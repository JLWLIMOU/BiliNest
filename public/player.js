/**
 * BiliNest 播放器（ArtPlayer 内核）
 * ------------------------------------------------------------
 * 之前直接使用浏览器原生 <video controls>，存在两个无法绕开的问题：
 *   1. 原生全屏只全屏 video 元素，弹幕画布、字幕层、音量提示等自定义浮层
 *      全部被移出可视区域（双击全屏同样是原生全屏）。
 *   2. 画质 / 弹幕 / 字幕控件只能放在播放器外部，全屏后无法操作。
 *
 * 现改用开源组件 ArtPlayer v5（MIT，https://github.com/zhw2590582/ArtPlayer）：
 *   - 全屏作用在 ArtPlayer 自己的容器上，弹幕 / 字幕浮层在全屏时保持可见；
 *   - 弹幕 / 字幕 / 清晰度控件集成进 ArtPlayer 控制条，全屏同样可操作；
 *   - 音量提示使用 ArtPlayer 内置 notice（“音量: xx%”），全屏可见；
 *   - 双击全屏、单击播放/暂停由 ArtPlayer 内置行为接管。
 * 官方嵌入播放器 iframe 仍保留，仅作为播放地址获取失败时的降级方案。
 */
window.BiliNestPlayer = (function () {
  'use strict';

  var store = window.BiliNestStore;
  var api = window.BiliNestAPI;

  var els = {
    player: document.getElementById('customPlayer'),
    canvas: null,   // ArtPlayer 初始化后指向弹幕画布
    sub: null,      // ArtPlayer 初始化后指向字幕层
    endOverlay: null // ArtPlayer 初始化后指向播放结束浮层
  };

  // 视频画面区域的单击 / 双击判定（见 bindClick）
  var clickTimer = null;
  var lastVideoClick = 0;
  // 同一播放地址的连续失败次数上限（超过后转备用地址）
  var MAX_URL_ATTEMPTS = 3;
  // 地址失效（如 CDN 镜像 404）时，重新请求播放地址的次数上限
  var MAX_FRESH_TRIES = 2;
  // 当前清晰度文件在 CDN 缺失时，自动尝试其他清晰度的次数上限
  var MAX_QUALITY_TRIES = 2;
  // 弹幕分段：官方网页端每 6 分钟一包、每包最多 6000 条。
  // 上限 250 包 ≈ 25 小时视频，防止异常视频无限拉取。
  var MAX_DANMAKU_SEGMENTS = 250;
  // 段间请求间隔：分段请求仍会打到 B 站，礼貌性限速，降低触发风控的概率
  var DANMAKU_SEGMENT_DELAY_MS = 120;
  // 字幕字号与播放器宽度的比例系数（随窗口 / 全屏等比缩放）
  var SUB_SIZE_FACTORS = { sm: 0.020, md: 0.024, lg: 0.030, xl: 0.038 };
  // 字幕请求序号：快速切换视频时，用序号丢弃旧视频的过期字幕结果
  var subtitleSeq = 0;
  // 弹幕请求序号：与字幕同理，防止旧视频的弹幕覆盖新视频
  var danmakuSeq = 0;

  var state = {
    art: null,              // ArtPlayer 实例（懒加载，只创建一次）
    kind: '',               // 'bili' | 'local'
    bvid: '',
    cid: '',
    qn: 0,
    qualities: [],          // [{ qn, label }]
    urls: [],               // 当前画质的播放地址（含备用）
    urlIdx: 0,
    danmaku: [],            // 解析后的弹幕（按时间排序）
    danmakuIdx: 0,
    active: [],             // 正在显示的弹幕
    lanes: [],              // 弹幕轨道占用
    danmakuOn: true,        // 弹幕默认开启
    pluginDanmaku: [],      // 适配 artplayer-plugin-danmuku 的弹幕数组
    playing: false,         // 播放状态（由 video:play/pause 事件维护）
    rafId: 0,
    subtitleBody: [],
    subtitleOn: false,      // 字幕默认关闭，由用户手动开启
    subSettings: loadSubSettings(), // 字幕位置 / 字号（持久化到 localStorage）
    resumePoint: 0,         // 续播点（秒），媒体就绪后自动跳转（一次性，保留兼容）
    resumeTarget: 0,        // 期望续播点（秒），跨重试/恢复保持，直到真正到达才清零
    recovering: false,      // 处于“加载失败 → 自动恢复”过程中（此时不要回写进度）
    seekedResume: false,    // 本次加载是否已成功 seek 到续播点
    reseekTries: 0,         // 续播 seek 已尝试次数（防止深 seek 失败导致重试死循环）
    playurlAt: 0,           // 上次成功获取播放地址的时间戳（用于判断签名是否过期）
    errorHandler: null,
    urlSwitching: false,    // 重试/切换中，避免 video:error 重复触发
    loadAttempts: 0,        // 当前播放地址的连续失败次数
    freshTries: 0,          // 因地址失效重新请求播放地址的次数
    qualityTries: 0,        // 因文件缺失自动尝试其他清晰度的次数
    retryTimer: null,       // “重试同地址”的挂起定时器
    fallbackHandler: null,  // 全部方案失败后的兜底（切官方播放器）
    episodeNavHandler: null, // 上一集 / 下一集点击回调（由应用层提供）
    endNav: { show: false, next: false }, // 播放结束浮层状态（应用层设置）
    endTimer: null           // 播放结束自动连播倒计时
  };

  /* ---------------- 工具 ---------------- */
  function creds() {
    return { cookie: store.getCookie() || '', sid: store.get('sid') || '' };
  }

  function toast(msg, type, duration) {
    if (state.errorHandler) state.errorHandler(msg, type, duration);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * B 站 CDN 防盗链：视频地址的 Referer 必须是 bilibili.com，
   * 浏览器直连（Referer 为 127.0.0.1）会被 403 → 播放器报“地址不支持”。
   * 因此统一改为请求本地代理 /api/video，由服务器带正确 Referer 转发。
   */
  function toProxiedUrl(url, alts) {
    var u = '/api/video?url=' + encodeURIComponent(url);
    // 把备用 CDN 地址一并交给代理：主节点抖动时由服务器“CDN 优选”兜底
    if (alts && alts.length) {
      u += '&alt=' + encodeURIComponent(alts.join('|'));
    }
    return u;
  }

  /* ---------------- ArtPlayer 初始化 ---------------- */
  function ensureArt() {
    if (state.art) return state.art;

    // 关掉 ArtPlayer 内置的自动重连（错误后 1 秒重设同一地址，最多 5 次）。
    // 它和我们自己的重试/备用地址逻辑会互相抢地址，导致本来能恢复的加载被反复打断。
    if (window.Artplayer && typeof window.Artplayer.RECONNECT_TIME_MAX === 'number') {
      window.Artplayer.RECONNECT_TIME_MAX = 0;
    }

    var art = new window.Artplayer({
      id: 'bilinest',
      container: els.player,
      url: '',
      type: 'mp4',
      theme: '#2f6fed',
      lang: 'zh-cn',
      volume: 0.8,
      autoplay: false,        // 由我们按“续播 / 新播”逻辑控制
      autoSize: false,
      autoMini: false,
      loop: false,
      flip: false,
      playbackRate: false,
      aspectRatio: false,
      screenshot: false,
      setting: false,
      hotkey: true,           // 空格播放、方向键快进、↑↓音量、F 全屏
      pip: false,
      mutex: true,
      backdrop: true,
      fullscreen: true,       // 自带全屏按钮；全屏作用于 ArtPlayer 容器
      fullscreenWeb: false,
      subtitleOffset: false,
      miniProgressBar: false,
      playsInline: true,
      lock: false,
      gesture: true,
      fastForward: false,
      autoPlayback: false,
      autoOrientation: false,
      airplay: false,
      // 与原生的 <video> 加载行为保持一致（preload auto），
      // 避免某些 fMP4 流在 metadata 预取阶段解析失败导致误报加载错误
      moreVideoAttr: { controls: false, preload: 'auto' },
      layers: [
        // CC 字幕层：全屏时同样保持可见
        { name: 'subtitle', html: '<div id="subtitleBox" class="subtitle-box" hidden></div>' },
        // 播放结束浮层：下一集（含倒计时自动连播）/ 重温一遍
        {
          name: 'end',
          html:
            '<div id="endOverlay" class="end-overlay" hidden>' +
              '<div class="end-actions">' +
                '<button type="button" class="end-btn end-next" data-end-next>' +
                  '<span class="end-icon">›</span>' +
                  '<span class="end-text" data-end-next-text></span>' +
                  '<span class="end-progress"><span class="end-progress-fill" data-end-progress></span></span>' +
                '</button>' +
                '<button type="button" class="end-btn end-replay" data-end-replay>' +
                  '<span class="end-icon">↻</span>' +
                  '<span class="end-text" data-end-replay-text></span>' +
                '</button>' +
              '</div>' +
            '</div>'
        }
      ],
      controls: [
        {
          name: 'prev',
          position: 'right',
          index: 3,
          html: '<span class="bilinest-ctl nav">‹</span>',
          tooltip: '上一集',
          click: function () { if (state.episodeNavHandler) state.episodeNavHandler('prev'); }
        },
        {
          name: 'next',
          position: 'right',
          index: 4,
          html: '<span class="bilinest-ctl nav">›</span>',
          tooltip: '下一集',
          click: function () { if (state.episodeNavHandler) state.episodeNavHandler('next'); }
        },
        {
          name: 'bdmaku',
          position: 'right',
          index: 5,
          html: '<span class="bilinest-ctl">弹幕</span>',
          tooltip: '弹幕开关',
          click: function () { toggleDanmaku(); }
        },
        {
          name: 'subtitle',
          position: 'right',
          index: 12,
          html: '<span class="bilinest-ctl">字幕</span>',
          tooltip: '字幕开关',
          click: function () { toggleSubtitle(); }
        },
        {
          name: 'subpos',
          position: 'right',
          index: 13,
          html:
            '<span class="bilinest-ctl subpos-wrap">' +
              '位置<input type="range" class="subpos-slider" min="0" max="100" step="1" value="' +
              Math.round(state.subSettings.pos) + '" aria-label="字幕位置微调">' +
            '</span>',
          tooltip: '字幕位置（底部微调）'
        },
        {
          name: 'subsize',
          position: 'right',
          index: 14,
          html: '<span class="bilinest-ctl">字号</span>',
          selector: [],
          onSelect: function (item) { return selectSubSize(item); }
        },
        {
          name: 'quality',
          position: 'right',
          index: 10,
          html: '<span class="bilinest-ctl">清晰度</span>',
          selector: [],
          onSelect: function (item) { return selectQuality(item); }
        }
      ],
      plugins: [
        artplayerPluginDanmuku({
          // 弹幕数据由 loadDanmaku 经 danmakuPlugin().load() 动态注入；
          // 这里给一个兜底函数，插件初始化时读取一次
          danmuku: function () { return state.pluginDanmaku || []; },
          type: 'json',
          synchronousPlayback: true, // 拖动进度后弹幕索引与视频同步
          mode: 0,
          opacity: 1,
          fontSize: 25,
          color: '#FFFFFF',
          antiOverlap: true,
          display: state.danmakuOn,   // 初始可见性跟随“弹幕开关”
          theme: 'dark',
          heatmap: false,
          beforeEmit: function () { return false; }, // 只读，禁止发送弹幕
          filter: function () { return true; }
        })
      ]
    });

    state.art = art;
    els.sub = els.player.querySelector('#subtitleBox');
    els.endOverlay = els.player.querySelector('#endOverlay');
    applySubSettings(); // 字幕位置 / 字号（可能已持久化，先恢复再显示）
    bindSubPosSlider();
    bindEndOverlay();
    // ArtPlayer 模板里自带一个空 <track>（src=""），我们不用它的字幕模块，
    // 移除它可避免浏览器对空 track 发起无意义的请求
    var emptyTrack = els.player.querySelector('track');
    if (emptyTrack) emptyTrack.remove();
    bindArtEvents();
    bindWheel();
    return art;
  }

  function bindArtEvents() {
    var art = state.art;

    // 播放器尺寸变化（窗口缩放 / 全屏切换）时，字幕字号按宽度等比更新
    art.on('resize', function () { resizeSubtitleFont(); });
    window.addEventListener('resize', function () {
      if (state.art) resizeSubtitleFont();
    });
    art.on('video:play', function () {
      // 注意：不要用 art.playing 判断“是否在播放”来启动弹幕循环——
      // ArtPlayer 的 playing 依赖 currentTime>0 且 readyState>2，
      // 视频刚开始播放（currentTime 仍为 0）时会误判为 false，
      // 导致弹幕动画永远不启动。这里统一用我们自己维护的 state.playing。
      state.playing = true;
      hideEndOverlay(); // 用户重新播放时隐藏结束浮层
    });
    art.on('video:pause', function () {
      state.playing = false;
      updateSubtitle(); // 暂停时也按当前时间刷新字幕，避免停留在上一句的空白间隙
      window.dispatchEvent(new CustomEvent('bilinest-pause'));
    });
    art.on('video:seeked', function () {
      updateSubtitle(); // 拖动进度后立即刷新字幕
    });
    art.on('video:ended', function () {
      state.playing = false;
      window.dispatchEvent(new CustomEvent('bilinest-ended'));
      showEndOverlay();
    });
    art.on('video:timeupdate', function () {
      updateSubtitle();
      // 已真正到达续播点：停止续播逻辑，避免后续误判
      if (state.resumeTarget > 0 && art.currentTime >= state.resumeTarget - 2) {
        state.resumeTarget = 0;
      }
      // 交给应用层做观看进度节流保存
      window.dispatchEvent(new CustomEvent('bilinest-timeupdate', {
        detail: { currentTime: art.currentTime, duration: art.duration }
      }));
    });
    art.on('video:canplay', function () {
      // 加载成功：清零失败计数 + 退出恢复态
      state.loadAttempts = 0;
      state.freshTries = 0;
      state.qualityTries = 0;
      state.recovering = false;
    });
    art.on('video:loadedmetadata', function () {
      // 自动从上次观看进度续播（跨重试保持：只要尚未成功 seek，就重新跳转）
      if (state.resumeTarget > 10 && !state.seekedResume) {
        if (state.reseekTries >= 5) {
          // 续播多次失败，放弃续播、从开头播放，避免“重载→seek→再报错”死循环
          state.resumeTarget = 0;
          art.play().catch(function () { /* 自动播放可能被浏览器拦截 */ });
          return;
        }
        state.reseekTries++;
        var sec = state.resumeTarget;
        state.seekedResume = true;
        try { art.currentTime = sec; } catch (e) { /* 跳转失败忽略 */ }
        art.play().catch(function () { /* 自动播放可能被浏览器拦截 */ });
        window.dispatchEvent(new CustomEvent('bilinest-resumed', {
          detail: { seconds: sec }
        }));
      } else {
        art.play().catch(function () { /* 自动播放可能被浏览器拦截 */ });
      }
    });
    art.on('video:error', function () { handleLoadError(); });
  }

  /**
   * 视频加载失败处理：不再建议用户“切换画质”。
   * 策略：
   *   1. 同一地址自动重试几次（间隔 0.8s，瞬时网络抖动通常能自愈）；
   *   2. 仍失败则静默尝试备用地址（同清晰度，仅换 CDN）；
   *   3. 全部失败才提示，并附带错误码与域名便于排查。
   */
  /** 清理挂起的“重试同地址”定时器：换地址/切换前必须清理，否则旧定时器会打断新加载 */
  function clearPendingRetry() {
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
  }

  /** 切到指定地址；期间屏蔽 video:error，避免切换过程被误判 */
  function switchTo(url) {
    if (!state.art) return;
    var next = toProxiedUrl(url, state.urls);
    state.urlSwitching = true;
    // 新地址与当前相同：switchQuality 会直接跳过，需强制重载
    if (state.art.video.src === next) {
      try { state.art.video.load(); } catch (e) { /* 忽略 */ }
      state.urlSwitching = false;
      return;
    }
    state.art.switchQuality(next).then(function () {
      state.urlSwitching = false;
    }).catch(function () {
      state.urlSwitching = false;
      handleLoadError();
    });
  }

  /** B 站签名 URL 过期/坏镜像：重新请求播放地址并切换（受 MAX_FRESH_TRIES 限制） */
  function reFetchPlayurl() {
    if (state.freshTries >= MAX_FRESH_TRIES) return false;
    state.freshTries++;
    state.loadAttempts = 0;
    state.urlSwitching = true;
    if (state.art && state.art.notice) state.art.notice.show = '播放地址失效，正在重新获取…';
    var wantQn = state.qn || 64;
    api.playurl(state.bvid, state.cid, wantQn, creds())
      .then(function (pl) {
        if (!state.art) return;
        if (!pl || !pl.durl || !pl.durl.length) {
          state.urlSwitching = false;
          handleLoadError();
          return;
        }
        state.qn = pl.quality || wantQn;
        state.qualities = buildQualities(pl);
        state.urls = [pl.durl[0].url].concat(pl.durl[0].backup_url || []);
        state.urlIdx = 0;
        state.playurlAt = Date.now();
        switchTo(state.urls[0]);
      })
      .catch(function () {
        state.urlSwitching = false;
        handleLoadError();
      });
    return true;
  }

  /**
   * 视频加载失败处理：不再建议用户“切换画质”。
   * 策略（逐级自动恢复）：
   *   1. 同一地址自动重试几次（间隔 0.8s，瞬时网络抖动通常能自愈）；
   *   2. 静默尝试备用地址（同清晰度，仅换 CDN）；
   *   3. 重新请求播放地址（B 站偶尔返回坏镜像，重取可能换到可用镜像）；
   *   4. 静默尝试其他清晰度的文件（文件路径不同，可能存在）；
   *   5. 全部失败交给应用层兜底（切官方播放器，官方走 DASH 通常可播）。
   * 注意：所有切换动作开始前必须 clearPendingRetry()，否则旧的重试定时器
   * 会在新地址加载时触发 video.load()，把正常的加载打断（曾导致 206 流被中止）。
   */
  function handleLoadError() {
    var art = state.art;
    if (!art || state.urlSwitching) return;
    if (!state.urls.length) return; // 已停止/已兜底切换，忽略残留错误事件
    // 进入恢复态：禁止应用层在此期间把进度回写成 0，并允许重新 seek 续播点
    state.recovering = true;
    state.seekedResume = false;
    var v = art.video;
    var code = (v && v.error && v.error.code) || 0;
    // 播放地址现在经本地代理转发，currentSrc 是 127.0.0.1；用真实 CDN 地址的域名做诊断
    var realUrl = state.urls[state.urlIdx] || '';
    var host = '';
    try {
      host = new URL(realUrl).hostname;
    } catch (e) { /* 忽略 */ }

    // 地址已可能过期（长时间待机 / B 站签名时效）：直接重取，跳过同地址重试
    if (state.kind === 'bili' && state.playurlAt &&
        Date.now() - state.playurlAt > 4 * 60 * 1000) {
      if (reFetchPlayurl()) return;
    }

    // 1) 同一地址仅重试 1 次（代理侧已做上游重试，过多同址重试只会拖慢恢复）
    if (state.loadAttempts < 1) {
      state.loadAttempts++;
      state.urlSwitching = true;
      if (art.notice) art.notice.show = '视频加载失败，正在自动重试…';
      var failedUrl = state.urls[state.urlIdx];
      clearPendingRetry();
      state.retryTimer = setTimeout(function () {
        state.retryTimer = null;
        state.urlSwitching = false;
        // 仅当仍是同一个失败地址时重载，避免用户已切换视频时误重载新视频
        if (state.art && state.urls[state.urlIdx] === failedUrl) {
          try { state.art.video.load(); } catch (e) { /* 忽略 */ }
        }
      }, 800);
      return;
    }

    // 2) 备用地址（同清晰度，仅换 CDN）
    if (state.urls[state.urlIdx + 1]) {
      state.loadAttempts = 0;
      state.urlIdx++;
      clearPendingRetry();
      switchTo(state.urls[state.urlIdx]);
      return;
    }

    // 本地文件不走 B 站地址重取 / 换清晰度 / 官方兜底
    if (state.kind !== 'bili') {
      toast('视频加载失败，请检查本地文件是否仍可用', 'error', 8000);
      return;
    }

    // 3) 重新请求播放地址（B 站偶尔返回“坏镜像”，重取可能换到可用镜像）
    if (reFetchPlayurl()) return;


    // 4) 静默尝试其他清晰度的文件（文件路径不同，可能存在）
    if (state.qualityTries < MAX_QUALITY_TRIES) {
      var candidates = state.qualities.filter(function (q) { return q.qn !== state.qn; });
      var target = candidates[state.qualityTries];
      if (target) {
        state.qualityTries++;
        clearPendingRetry();
        state.urlSwitching = true;
        if (art.notice) art.notice.show = '当前清晰度文件缺失，正在尝试其他清晰度…';
        api.playurl(state.bvid, state.cid, target.qn, creds())
          .then(function (pl) {
            if (!state.art) return;
            if (!pl || !pl.durl || !pl.durl.length) {
              state.urlSwitching = false;
              handleLoadError();
              return;
            }
            state.qn = pl.quality || target.qn;
            state.qualities = buildQualities(pl);
            state.urls = [pl.durl[0].url].concat(pl.durl[0].backup_url || []);
            state.urlIdx = 0;
            state.loadAttempts = 0;
            state.freshTries = 0;
            switchTo(state.urls[0]);
          })
          .catch(function () {
            state.urlSwitching = false;
            handleLoadError();
          });
        return;
      }
    }

    // 5) 全部方案失败：交给应用层兜底（切官方播放器，官方走 DASH 通常可播）
    if (state.fallbackHandler) {
      state.fallbackHandler(state.bvid, state.cid);
      return;
    }

    console.warn('[BiliNest] 视频加载失败', {
      code: code,
      host: host,
      urlIdx: state.urlIdx,
      freshTries: state.freshTries,
      qualityTries: state.qualityTries,
      currentSrc: v ? v.currentSrc : ''
    });
    var codeText = code === 1 ? '请求中止' : code === 2 ? '网络异常' : code === 3 ? '解码失败' : code === 4 ? '地址不支持' : '未知错误';
    toast('视频加载失败（' + codeText + (host ? ' · ' + host : '') + '），请检查网络后重试', 'error', 8000);
  }

  /* 鼠标位于视频窗口时滚轮调节音量；提示使用 ArtPlayer 内置 notice（全屏可见） */
  function bindWheel() {
    if (!els.player) return;
    els.player.addEventListener('wheel', function (e) {
      e.preventDefault();
      var art = state.art;
      if (!art) return;
      var delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 16;       // 行模式归一化
      else if (e.deltaMode === 2) delta *= 100; // 页模式归一化
      var step = 0.05 * Math.max(1, Math.round(Math.abs(delta) / 50));
      var vol = art.muted ? 0 : art.volume;
      vol = delta < 0 ? Math.min(1, vol + step) : Math.max(0, vol - step);
      art.muted = vol === 0;
      art.volume = vol; // ArtPlayer 自动显示“音量: xx%”
    }, { passive: false });
  }

  /* ---------------- 播放结束浮层（下一集 / 重温） ---------------- */
  var END_COUNTDOWN_SECONDS = 5;
  var END_NEXT_TEXTS = ['再学一集！', '下一集'];
  var END_REPLAY_TEXTS = ['重温一遍', '重新播放'];

  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function bindEndOverlay() {
    if (!els.endOverlay) return;
    els.endOverlay.addEventListener('click', function (e) {
      if (e.target.closest('[data-end-next]')) {
        hideEndOverlay();
        if (state.episodeNavHandler) state.episodeNavHandler('next');
      } else if (e.target.closest('[data-end-replay]')) {
        hideEndOverlay();
        replayCurrent();
      }
    });
  }

  function showEndOverlay() {
    var art = state.art;
    if (!art || !els.endOverlay) return;
    // 单视频 / 本地视频：不显示结束提示，保持暂停即可
    if (!state.endNav || !state.endNav.show) {
      hideEndOverlay();
      return;
    }
    // 取消挂起的单击播放切换，避免结束后误触重播
    clearTimeout(clickTimer);
    clickTimer = null;
    lastVideoClick = 0;
    var nextBtn = els.endOverlay.querySelector('[data-end-next]');
    var nextText = els.endOverlay.querySelector('[data-end-next-text]');
    var replayText = els.endOverlay.querySelector('[data-end-replay-text]');
    nextBtn.style.display = state.endNav.next ? '' : 'none';
    nextText.textContent = pickRandom(END_NEXT_TEXTS);
    replayText.textContent = pickRandom(END_REPLAY_TEXTS);
    els.endOverlay.hidden = false;
    // 隐藏 ArtPlayer 默认的状态图标，避免遮挡结束浮层
    art.mask.show = false;
    startEndCountdown();
  }

  function hideEndOverlay() {
    clearEndCountdown();
    if (els.endOverlay) els.endOverlay.hidden = true;
  }

  /** 下一集按钮下方的倒计时读条：不点击则自动下一集（最后一集无倒计时） */
  function startEndCountdown() {
    clearEndCountdown();
    if (!state.endNav || !state.endNav.next || !els.endOverlay) return;
    var fill = els.endOverlay.querySelector('[data-end-progress]');
    if (!fill) return;
    fill.style.transition = 'none';
    fill.style.width = '100%';
    void fill.offsetWidth; // 强制重排，让动画从头开始
    fill.style.transition = 'width ' + END_COUNTDOWN_SECONDS + 's linear';
    fill.style.width = '0%';
    state.endTimer = setTimeout(function () {
      state.endTimer = null;
      hideEndOverlay();
      if (state.episodeNavHandler) state.episodeNavHandler('next');
    }, END_COUNTDOWN_SECONDS * 1000);
  }

  function clearEndCountdown() {
    if (state.endTimer) {
      clearTimeout(state.endTimer);
      state.endTimer = null;
    }
  }

  /** 重头播放当前视频 */
  function replayCurrent() {
    var art = state.art;
    if (!art) return;
    try { art.currentTime = 0; } catch (e) { /* 忽略 */ }
    art.play().catch(function () { /* 自动播放可能被拦截 */ });
  }

  /**
   * 单击 / 双击手势（视频画面区域）。
   * ArtPlayer 内置逻辑是“第一下单击立即切换播放，第二下才算双击全屏”，
   * 这会让双击进出全屏时出现一次“暂停又恢复”的闪烁。
   * 这里在捕获阶段拦截视频区域的 click，自己判定：
   *   - 300ms 内出现第二下 → 只切换全屏，完全不碰播放状态；
   *   - 超过 300ms 无第二下 → 才切换播放/暂停。
   * 代价是单击视频的响应有约 300ms 延迟；控制条、中央播放按钮等仍由 ArtPlayer 即时处理。
   */
  function bindClick() {
    if (!els.player) return;
    els.player.addEventListener('click', function (e) {
      var art = state.art;
      if (!art || e.target !== art.video) return;      // 只接管视频画面区域的点击
      if (navigator.maxTouchPoints > 0) return;        // 触屏保留 ArtPlayer 原生手势
      e.preventDefault();
      e.stopImmediatePropagation();                    // 阻止事件到达 ArtPlayer 的 click 处理

      var now = Date.now();
      if (now - lastVideoClick <= 300) {
        // 双击：取消挂起的单击动作，仅切换全屏
        clearTimeout(clickTimer);
        clickTimer = null;
        lastVideoClick = 0;
        if (typeof art.fullscreen === 'boolean') {
          art.fullscreen = !art.fullscreen;
        }
      } else {
        lastVideoClick = now;
        clearTimeout(clickTimer);
        // 播放结束浮层（下一集 / 重温）显示时：单击不响应，避免误触重播；
        // 只保留双击全屏 / 退出全屏。
        if (isEndOverlayVisible()) {
          clickTimer = null;
          return;
        }
        clickTimer = setTimeout(function () {
          clickTimer = null;
          lastVideoClick = 0;
          if (!state.art) return;
          if (isEndOverlayVisible()) return; // 浮层显示期间不执行播放切换
          var r = state.art.toggle();
          if (r && typeof r.catch === 'function') r.catch(function () { /* 自动播放可能被拦截 */ });
        }, 300);
      }
    }, true);
  }

  function isEndOverlayVisible() {
    return !!(els.endOverlay && !els.endOverlay.hidden);
  }

  /* ---------------- 加载视频 ---------------- */
  /**
   * 加载一个 B 站视频（单 P）。
   * @returns {Promise<boolean>} 成功返回 true；失败抛出异常由调用方降级。
   */
  async function load(bvid, cid, resumeSeconds, opts) {
    opts = opts || {};
    reset();
    state.kind = 'bili';
    state.bvid = bvid;
    state.cid = cid;
    // 续播点必须在 reset() 之后设置（reset 会清零）
    state.resumePoint = Number(resumeSeconds) || 0;
    state.resumeTarget = state.resumePoint;
    state.seekedResume = false;
    state.reseekTries = 0;

    var pl = await fetchPlayurl(bvid, cid);
    state.playurlAt = Date.now();

    state.qn = pl.quality || 64;
    state.qualities = buildQualities(pl);
    state.urls = [pl.durl[0].url].concat(pl.durl[0].backup_url || []);
    state.urlIdx = 0;

    els.player.hidden = false;   // 先让容器可见，再创建播放器，避免隐藏状态下初始化
    ensureArt();
    state.art.poster = opts.poster || '';
    showBiliControls(true);
    renderQualityControl();
    updateDanmakuControl();
    updateSubtitleControl();
    renderSubSettingsControls();

    state.art.url = toProxiedUrl(state.urls[0], state.urls);

    // 弹幕与字幕异步加载，失败不阻塞播放
    loadDanmaku(cid);
    loadSubtitles(bvid, cid);
    return true;
  }

  /** 加载本地视频文件（复用同一播放器，无弹幕/清晰度） */
  function loadLocal(url, resumeSeconds) {
    reset();
    state.kind = 'local';
    state.resumePoint = Number(resumeSeconds) || 0;
    state.resumeTarget = state.resumePoint;
    state.seekedResume = false;
    state.reseekTries = 0;
    els.player.hidden = false;   // 先让容器可见，再创建播放器，避免隐藏状态下初始化
    ensureArt();
    state.art.poster = '';
    showBiliControls(false);
    state.art.url = url;
    return true;
  }

  /**
   * 获取播放地址：默认请求最高画质；若接口自动降级，
   * 再按返回的可选画质列表请求最高档（默认取最高）。
   */
  async function fetchPlayurl(bvid, cid) {
    var pl = null;
    var tryQns = [120, 116, 80, 64];
    for (var i = 0; i < tryQns.length; i++) {
      try {
        var r = await api.playurl(bvid, cid, tryQns[i], creds());
        if (r && r.durl && r.durl.length) {
          pl = r;
          break;
        }
      } catch (e) {
        pl = null;
      }
    }
    if (!pl || !pl.durl || !pl.durl.length) throw new Error('未获取到播放地址');

    var maxQn = 0;
    (pl.accept_quality || []).forEach(function (q) { if (q > maxQn) maxQn = q; });
    if (maxQn > (pl.quality || 0)) {
      try {
        var r2 = await api.playurl(bvid, cid, maxQn, creds());
        if (r2 && r2.durl && r2.durl.length) pl = r2;
      } catch (e) {
        /* 保持当前画质 */
      }
    }
    return pl;
  }

  function buildQualities(pl) {
    var q = pl.accept_quality || [pl.quality];
    var d = pl.accept_description || [];
    return q.map(function (qn, i) {
      return { qn: qn, label: d[i] || ('画质 ' + qn) };
    });
  }

  /* ---------------- 画质切换 ---------------- */
  function currentQualityLabel() {
    var cur = state.qualities.find(function (q) { return q.qn === state.qn; });
    return cur ? cur.label : ('画质 ' + state.qn);
  }

  /** 把当前可选画质写入 ArtPlayer 的“清晰度”下拉控件 */
  function renderQualityControl() {
    var art = state.art;
    if (!art || state.kind !== 'bili') return;
    var items = state.qualities.map(function (q) {
      return { html: esc(q.label), qn: q.qn, default: q.qn === state.qn, url: '' };
    });
    art.controls.update({
      name: 'quality',
      position: 'right',
      index: 10,
      html: '<span class="bilinest-ctl">' + esc(currentQualityLabel()) + '</span>',
      selector: items,
      onSelect: function (item) { return selectQuality(item); }
    });
  }

  /** 选中画质：按需请求该画质地址，再交给 ArtPlayer 无缝切换（保留进度） */
  async function selectQuality(item) {
    var art = state.art;
    var qn = Number(item.qn);
    if (!art || !qn || qn === state.qn) return item.html;
    var label = item.html || ('画质 ' + qn);
    try {
      clearPendingRetry();
      var pl = await api.playurl(state.bvid, state.cid, qn, creds());
      if (!pl || !pl.durl || !pl.durl.length) throw new Error('该画质暂不可用');
      state.qn = pl.quality || qn;
      state.urls = [pl.durl[0].url].concat(pl.durl[0].backup_url || []);
      state.urlIdx = 0;
      state.urlSwitching = true;
      try {
        await art.switchQuality(toProxiedUrl(state.urls[0], state.urls));
        return label;
      } finally {
        state.urlSwitching = false;
      }
    } catch (e) {
      toast('画质切换失败：' + e.message, 'error');
      return currentQualityLabel();
    }
  }

  /* ---------------- 弹幕开关 ---------------- */
  function toggleDanmaku() {
    state.danmakuOn = !state.danmakuOn;
    updateDanmakuControl();
    var p = danmakuPlugin();
    if (p) {
      if (state.danmakuOn) p.show(); else p.hide();
    }
  }

  function updateDanmakuControl() {
    var art = state.art;
    if (!art) return;
    var el = art.controls.bdmaku;
    if (!el) return;
    var span = el.querySelector('.bilinest-ctl');
    if (span) span.classList.toggle('off', !state.danmakuOn);
  }

  /* ---------------- 弹幕 ---------------- */
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * 加载弹幕：优先官方网页端的分段 protobuf 方案（完整度远高于 XML），
   * 失败时回退旧 XML 接口（实时弹幕池，不完整但至少可用）。
   */
  async function loadDanmaku(cid) {
    var mySeq = ++danmakuSeq;
    var list = null;
    try {
      list = await fetchDanmakuSegments(cid, mySeq);
    } catch (e) {
      list = null; // 分段接口失败 → 回退 XML
    }
    if (mySeq !== danmakuSeq) return; // 已切到其它视频，丢弃过期结果
    if (!list) {
      try {
        list = await fetchDanmakuXml(cid);
      } catch (e) {
        /* 弹幕加载失败不阻塞播放 */
      }
    }
    if (mySeq !== danmakuSeq) return;
    if (!list) list = [];
    list.sort(function (a, b) { return a.time - b.time; });
    state.danmaku = list;
    var arr = toPluginDanmaku(list);
    state.pluginDanmaku = arr;
    var p = danmakuPlugin();
    if (p) p.load(arr);
  }

  /**
   * 分段拉取完整弹幕（官方网页端方案）。
   * 从第 1 包开始，每包 6 分钟、最多 6000 条；返回不足 6000 条即最后一包。
   * @returns {Promise<Array<{time,mode,size,color,text}>>}
   */
  async function fetchDanmakuSegments(cid, mySeq) {
    var list = [];
    var firstOk = false;
    for (var i = 1; i <= MAX_DANMAKU_SEGMENTS; i++) {
      var data = null;
      try {
        data = await api.danmakuSegments(cid, i, creds());
      } catch (e) {
        if (mySeq !== danmakuSeq) throw new Error('stale');
        break; // 后续分段请求失败：保留已拉到的弹幕，不再继续
      }
      if (mySeq !== danmakuSeq) throw new Error('stale'); // 已切换视频，中止拉取
      var elems = (data && data.elems) || [];
      firstOk = true;
      for (var j = 0; j < elems.length; j++) {
        var e = elems[j];
        var text = String(e.content || '').trim();
        if (!text) continue;
        var mode = Number(e.mode) || 1;
        // 高级/代码/BAS 弹幕（mode 8+）自研画布无法还原其特殊效果，跳过避免显示乱码
        if (mode > 7) continue;
        list.push({
          time: (Number(e.progress) || 0) / 1000, // 毫秒 → 秒
          mode: mode,
          size: Number(e.fontsize) || 25,
          color: Number(e.color) || 0xffffff,
          text: text
        });
      }
      // 未满 6000 条说明已是最后一包（官方每包最多 6000）
      if (elems.length < 6000) break;
      if (i < MAX_DANMAKU_SEGMENTS) await sleep(DANMAKU_SEGMENT_DELAY_MS);
    }
    return firstOk ? list : null; // 第一段就失败 → 让调用方回退 XML
  }

  /** 旧 XML 弹幕（仅实时弹幕池，不完整），作为分段接口失败时的兜底 */
  async function fetchDanmakuXml(cid) {
    var xml = await api.danmakuXml(cid, creds());
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    var items = doc.querySelectorAll('d');
    var list = [];
    for (var i = 0; i < items.length; i++) {
      var p = (items[i].getAttribute('p') || '').split(',');
      var text = (items[i].textContent || '').trim();
      if (p.length < 4 || !text) continue;
      list.push({
        time: parseFloat(p[0]) || 0,
        mode: parseInt(p[1], 10) || 1,
        size: parseInt(p[2], 10) || 25,
        color: parseInt(p[3], 10) || 0xffffff,
        text: text
      });
    }
    return list;
  }

  /** 适配 artplayer-plugin-danmuku：取出插件实例（首次加载后可用） */
  function danmakuPlugin() {
    return state.art && state.art.plugins ? state.art.plugins.artplayerPluginDanmuku : null;
  }

  /** 把内部弹幕格式（B 站 mode/color 数字）转换为插件要求的格式：
   *  { time, text, color: '#rrggbb', mode }
   *  插件 mode 约定：0 滚动 / 1 底部 / 2 顶部
   *  （B 站：1 滚动 / 4 底部 / 5 顶部）*/
  function toPluginDanmaku(list) {
    return (list || []).map(function (d) {
      var mode = d.mode === 5 ? 2 : d.mode === 4 ? 1 : 0; // 顶(5)/底(4) → 插件 top(2)/bottom(1)
      var color = '#' + ('000000' + (d.color >>> 0).toString(16)).slice(-6);
      return { time: d.time, text: d.text, color: color, mode: mode };
    });
  }

  /* ---------------- 字幕位置（滑块）/ 字号设置 ---------------- */
  function loadSubSettings() {
    var s = (store && store.get && store.get('subSettings')) || null;
    var pos = s && s.pos;
    // 旧版本存的是 'bottom'/'middle'/'top' 字符串，统一迁移为滑块数值（0~100）
    if (typeof pos !== 'number' || isNaN(pos)) pos = 100;
    return {
      pos: pos,
      size: (s && s.size) || 'md'
    };
  }

  function saveSubSettings() {
    if (store && store.set) store.set({ subSettings: state.subSettings });
  }

  function subSizeLabel(v) { return { sm: '小', md: '中', lg: '大', xl: '特大' }[v] || '中'; }

  /** 字幕位置映射：滑块 0~100 → bottom 2%~16%，始终位于底部区域做微调 */
  function subPosToBottom(v) {
    var x = Math.min(100, Math.max(0, Number(v) || 0));
    return 2 + (x / 100) * 14;
  }

  /** 把位置 / 字号设置应用到字幕层 */
  function applySubSettings() {
    if (!els.sub) return;
    // 底部偏移存成 CSS 变量，CSS 里再叠加控制条高度（暂停/悬停时自动抬升）
    els.sub.style.bottom = '';
    els.sub.style.setProperty('--sub-bottom', subPosToBottom(state.subSettings.pos).toFixed(2) + '%');
    var z = state.subSettings.size || 'md';
    els.sub.classList.remove('sub-size-sm', 'sub-size-md', 'sub-size-lg', 'sub-size-xl');
    els.sub.classList.add('sub-size-' + z);
    resizeSubtitleFont();
  }

  /** 字幕字号按播放器实际宽度等比缩放（全屏时容器变大，字号同步变大，不再封顶） */
  function resizeSubtitleFont() {
    if (!els.sub || !els.player) return;
    var w = els.player.clientWidth || els.player.offsetWidth || 0;
    if (!w) return;
    var z = state.subSettings.size || 'md';
    var factor = SUB_SIZE_FACTORS[z] || SUB_SIZE_FACTORS.md;
    // 极小窗口保底 12px；上限随宽度比例走
    els.sub.style.fontSize = Math.max(12, Math.round(w * factor)) + 'px';
  }

  /** 绑定控制条里的字幕位置滑块（ArtPlayer 只渲染一次，事件只需绑定一次） */
  function bindSubPosSlider() {
    var art = state.art;
    if (!art) return;
    var ctl = art.controls.subpos;
    if (!ctl) return;
    var slider = ctl.querySelector('.subpos-slider');
    if (!slider) return;
    slider.addEventListener('input', function () {
      state.subSettings.pos = Number(slider.value) || 0;
      saveSubSettings();
      applySubSettings();
    });
  }

  /** 把字号写入 ArtPlayer 下拉控件（位置已改为滑块，不再需要下拉） */
  function renderSubSettingsControls() {
    var art = state.art;
    if (!art) return;
    var sizeItems = [
      { html: '小', value: 'sm', default: state.subSettings.size === 'sm' },
      { html: '中', value: 'md', default: state.subSettings.size === 'md' },
      { html: '大', value: 'lg', default: state.subSettings.size === 'lg' },
      { html: '特大', value: 'xl', default: state.subSettings.size === 'xl' }
    ];
    art.controls.update({
      name: 'subsize',
      position: 'right',
      index: 14,
      html: '<span class="bilinest-ctl">字号·' + esc(subSizeLabel(state.subSettings.size)) + '</span>',
      selector: sizeItems,
      onSelect: function (item) { return selectSubSize(item); }
    });
  }

  function selectSubSize(item) {
    state.subSettings.size = item.value;
    saveSubSettings();
    applySubSettings();
    renderSubSettingsControls();
    return item.html;
  }

  /* ---------------- 字幕开关 ---------------- */
  function toggleSubtitle() {
    if (!state.subtitleBody.length) return;
    state.subtitleOn = !state.subtitleOn;
    updateSubtitleControl();
    if (state.subtitleOn) {
      els.sub.hidden = false;
      updateSubtitle();
    } else {
      els.sub.hidden = true;
      els.sub.textContent = '';
    }
  }

  function updateSubtitleControl() {
    var art = state.art;
    if (!art) return;
    var el = art.controls.subtitle;
    if (!el) return;
    var span = el.querySelector('.bilinest-ctl');
    if (!span) return;
    if (!state.subtitleBody.length) {
      state.subtitleOn = false;
      if (els.sub) {
        els.sub.hidden = true;
        els.sub.textContent = '';
      }
      span.classList.add('disabled');
    } else {
      span.classList.remove('disabled');
    }
    span.classList.toggle('off', !state.subtitleOn);
    // 没有字幕时，位置滑块 / 字号下拉一并置灰
    ['subpos', 'subsize'].forEach(function (name) {
      var ctl = art.controls[name];
      if (!ctl) return;
      var cSpan = ctl.querySelector('.bilinest-ctl');
      if (!cSpan) return;
      cSpan.classList.toggle('disabled', !state.subtitleBody.length);
      var slider = ctl.querySelector('.subpos-slider');
      if (slider) slider.disabled = !state.subtitleBody.length;
    });
  }

  async function loadSubtitles(bvid, cid) {
    var mySeq = ++subtitleSeq;
    var body = [];
    try {
      var v2 = await api.playerV2(bvid, cid, creds());
      if (mySeq !== subtitleSeq) return; // 已切到其它视频，丢弃过期结果
      var subs = v2 && v2.subtitle && v2.subtitle.subtitles;
      if (subs && subs.length) {
        var pick = subs.find(function (s) { return /^zh/i.test(s.lan); }) || subs[0];
        // 兼容 // 开头与 http:// 的地址，统一转成 https
        var subUrl = String(pick.subtitle_url || '');
        if (/^\/\//.test(subUrl)) subUrl = 'https:' + subUrl;
        else if (/^http:\/\//i.test(subUrl)) subUrl = subUrl.replace(/^http:/i, 'https:');
        var data = await api.subtitleJson(subUrl, creds());
        if (mySeq !== subtitleSeq) return; // 同上：只认最新一次请求
        if (data && Array.isArray(data.body) && data.body.length) body = data.body;
      }
    } catch (e) {
      body = []; // 失败视为无字幕
    }
    if (mySeq !== subtitleSeq) return;
    state.subtitleBody = body;
    updateSubtitleControl();
    renderSubSettingsControls();
    applySubSettings();
  }

  function updateSubtitle() {
    if (!state.subtitleBody.length || !state.subtitleOn || !els.sub) return;
    var t = state.art ? state.art.currentTime : 0;
    var cur = null;
    for (var i = 0; i < state.subtitleBody.length; i++) {
      var it = state.subtitleBody[i];
      if (t >= it.from && t <= it.to) { cur = it.content; break; }
    }
    els.sub.textContent = cur || '';
  }

  /* ---------------- 控件显隐 ---------------- */
  /** 本地视频没有弹幕/字幕/画质，隐藏对应控件 */
  function showBiliControls(show) {
    if (!state.art) return;
    ['danmaku', 'subtitle', 'subpos', 'subsize', 'quality'].forEach(function (name) {
      var el = state.art.controls[name];
      if (el) el.style.display = show ? '' : 'none';
    });
  }

  /* ---------------- 停止 ---------------- */
  function reset() {
    state.playing = false;
    clearPendingRetry();
    subtitleSeq++; // 使尚未完成的字幕请求失效，避免旧视频字幕覆盖新视频
    danmakuSeq++;  // 同理，使尚未完成的弹幕请求失效
    state.kind = '';
    state.bvid = '';
    state.cid = '';
    state.qn = 0;
    state.qualities = [];
    state.urls = [];
    state.urlIdx = 0;
    state.danmaku = [];
    state.pluginDanmaku = [];
    state.subtitleBody = [];
    state.subtitleOn = false;
    state.resumePoint = 0;
    state.resumeTarget = 0;
    state.recovering = false;
    state.seekedResume = false;
    state.reseekTries = 0;
    state.playurlAt = 0;
    state.urlSwitching = false;
    state.loadAttempts = 0;
    state.freshTries = 0;
    state.qualityTries = 0;
    if (state.art) {
      try { state.art.pause(); } catch (e) { /* ignore */ }
      hideEndOverlay();
      // 清空弹幕（已改由插件渲染）：重置内部数组并通知插件重载空数据
      var dp = danmakuPlugin();
      if (dp) dp.load([]);
      if (els.sub) {
        els.sub.hidden = true;
        els.sub.textContent = '';
      }
      els.player.hidden = true;
    }
  }

  function stop() {
    reset();
  }

  // 视频画面区域的手势（单击播放/暂停、双击全屏）由我们自己接管
  bindClick();

  return {
    VERSION: 6,
    load: load,
    loadLocal: loadLocal,
    stop: stop,
    getVideo: function () {
      // 供应用层读取播放进度 / 时长；ArtPlayer 初始化前返回 null
      return state.art ? state.art.template.$video : null;
    },
    /** 当前已加载弹幕条数（用于历史记录展示，对齐 DanmuTV 的 danmaku 字段） */
    getDanmakuCount: function () { return state.danmaku ? state.danmaku.length : 0; },
    setResumePoint: function (seconds) {
      state.resumePoint = Number(seconds) || 0;
      state.resumeTarget = state.resumePoint;
      state.seekedResume = false;
    },
    /** 是否处于“加载失败 → 自动恢复”过程中（应用层据此跳过进度回写） */
    isRecovering: function () { return !!state.recovering; },
    /** 主动强制重新获取播放地址（如检测到待机恢复、签名可能过期时由应用层调用） */
    refreshPlayurl: function () {
      if (state.kind !== 'bili' || !state.art) return Promise.resolve(false);
      state.playurlAt = 0; // 标记为“已过期”，下次出错会直接重取；这里立即重取
      return api.playurl(state.bvid, state.cid, state.qn || 64, creds())
        .then(function (pl) {
          if (!state.art || !pl || !pl.durl || !pl.durl.length) return false;
          state.qn = pl.quality || state.qn;
          state.qualities = buildQualities(pl);
          state.urls = [pl.durl[0].url].concat(pl.durl[0].backup_url || []);
          state.urlIdx = 0;
          state.seekedResume = false;
          state.playurlAt = Date.now();
          switchTo(state.urls[0]);
          return true;
        })
        .catch(function () { return false; });
    },
    setEpisodeNavHandler: function (fn) { state.episodeNavHandler = fn; },
    /** 应用层根据选集列表更新上一集/下一集按钮：{ visible, prev, next } */
    updateEpisodeNav: function (nav) {
      var art = state.art;
      if (!art) return;
      ['prev', 'next'].forEach(function (name) {
        var el = art.controls[name];
        if (!el) return;
        var on = nav && nav.visible && (name === 'prev' ? nav.prev : nav.next);
        el.style.display = on ? '' : 'none';
      });
    },
    /** 应用层设置播放结束浮层状态：{ show, next } */
    setEndNav: function (nav) {
      state.endNav = nav || { show: false, next: false };
      if (!state.endNav.show) hideEndOverlay();
    },
    setFallbackHandler: function (fn) { state.fallbackHandler = fn; },
    setErrorHandler: function (fn) { state.errorHandler = fn; }
  };
})();
