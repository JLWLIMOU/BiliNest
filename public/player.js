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
    playing: false,         // 播放状态（由 video:play/pause 事件维护）
    rafId: 0,
    subtitleBody: [],
    subtitleOn: false,      // 字幕默认关闭，由用户手动开启
    subSettings: loadSubSettings(), // 字幕位置 / 字号（持久化到 localStorage）
    resumePoint: 0,         // 续播点（秒），媒体就绪后自动跳转
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
  function toProxiedUrl(url) {
    return '/api/video?url=' + encodeURIComponent(url);
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
        // 弹幕画布：挂在 ArtPlayer 内部 layer 上，全屏时依然覆盖视频
        { name: 'danmaku', html: '<canvas id="danmakuCanvas" class="danmaku-layer" hidden></canvas>' },
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
          name: 'danmaku',
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
      ]
    });

    state.art = art;
    els.canvas = els.player.querySelector('#danmakuCanvas');
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
      if (state.danmakuOn) startRender();
    });
    art.on('video:pause', function () {
      state.playing = false;
      // 暂停时冻结弹幕：保留画布最后一帧，方便阅读（播放时继续滚动）
      freezeRender();
      updateSubtitle(); // 暂停时也按当前时间刷新字幕，避免停留在上一句的空白间隙
      window.dispatchEvent(new CustomEvent('bilinest-pause'));
    });
    art.on('video:seeked', function () {
      updateSubtitle(); // 拖动进度后立即刷新字幕
      // 暂停中拖动进度：重画当前时间点的静态弹幕，而不是保留旧画面的弹幕
      if (!state.playing && state.danmakuOn && state.danmaku.length) drawFrame();
    });
    art.on('video:ended', function () {
      state.playing = false;
      stopRender();
      window.dispatchEvent(new CustomEvent('bilinest-ended'));
      showEndOverlay();
    });
    art.on('video:seeking', function () {
      // 跳转后清空已显示弹幕，从新位置重新生成
      state.active = [];
      state.lanes = [];
      state.danmakuIdx = 0;
      while (state.danmakuIdx < state.danmaku.length &&
             state.danmaku[state.danmakuIdx].time < art.currentTime) {
        state.danmakuIdx++;
      }
    });
    art.on('video:timeupdate', function () {
      updateSubtitle();
      // 交给应用层做观看进度节流保存
      window.dispatchEvent(new CustomEvent('bilinest-timeupdate', {
        detail: { currentTime: art.currentTime, duration: art.duration }
      }));
    });
    art.on('video:canplay', function () {
      // 加载成功：清零失败计数
      state.loadAttempts = 0;
      state.freshTries = 0;
      state.qualityTries = 0;
    });
    art.on('video:loadedmetadata', function () {
      // 自动从上次观看进度续播
      if (state.resumePoint > 10) {
        var sec = state.resumePoint;
        state.resumePoint = 0;
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
    art.on('fullscreen', function () {
      // 进入/退出全屏后立即校准弹幕画布尺寸
      sizeCanvas();
    });
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
    var v = art.video;
    var code = (v && v.error && v.error.code) || 0;
    // 播放地址现在经本地代理转发，currentSrc 是 127.0.0.1；用真实 CDN 地址的域名做诊断
    var realUrl = state.urls[state.urlIdx] || '';
    var host = '';
    try {
      host = new URL(realUrl).hostname;
    } catch (e) { /* 忽略 */ }

    /** 切到指定地址；期间屏蔽 video:error，避免切换过程被误判 */
    function switchTo(url) {
      if (!state.art) return;
      var next = toProxiedUrl(url);
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

    // 1) 同一地址重试
    if (state.loadAttempts < MAX_URL_ATTEMPTS) {
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
    if (state.freshTries < MAX_FRESH_TRIES) {
      state.freshTries++;
      clearPendingRetry();
      state.urlSwitching = true;
      if (art.notice) art.notice.show = '播放地址失效，正在重新获取…';
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
          state.loadAttempts = 0;
          switchTo(state.urls[0]);
        })
        .catch(function () {
          state.urlSwitching = false;
          handleLoadError();
        });
      return;
    }

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

    var pl = await fetchPlayurl(bvid, cid);

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

    state.art.url = toProxiedUrl(state.urls[0]);

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
        await art.switchQuality(toProxiedUrl(state.urls[0]));
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
    if (state.danmakuOn) startRender();
    else stopRender();
  }

  function updateDanmakuControl() {
    var art = state.art;
    if (!art) return;
    var el = art.controls.danmaku;
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
    state.danmakuIdx = 0;
    // 播放中 → 启动动画；暂停中 → 补画一帧静态弹幕
    if (state.danmakuOn && state.art) startRender();
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

  /** 开始弹幕渲染：播放中走动画循环；暂停中只补画一帧静态弹幕 */
  function startRender() {
    if (state.rafId) return;
    if (!els.canvas) return;
    els.canvas.hidden = false;
    if (!state.playing) {
      drawFrame(); // 暂停状态：静态帧（暂停时弹幕可阅读）
      return;
    }
    state.rafId = requestAnimationFrame(renderLoop);
  }

  /** 暂停时冻结弹幕：保留画布最后一帧，不清屏、不隐藏 */
  function freezeRender() {
    cancelAnimationFrame(state.rafId);
    state.rafId = 0;
  }

  /** 停止弹幕并彻底清屏（关闭弹幕 / 播放结束 / 切换视频时用） */
  function stopRender() {
    cancelAnimationFrame(state.rafId);
    state.rafId = 0;
    if (els.canvas) {
      var ctx = els.canvas.getContext('2d');
      // 画布经过 DPR 缩放，先复位变换再清屏，确保彻底清空
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
      els.canvas.hidden = true;
    }
  }

  function renderLoop() {
    state.rafId = 0;
    if (!state.playing || !state.danmakuOn || !els.canvas) return;
    drawFrame();
    state.rafId = requestAnimationFrame(renderLoop);
  }

  /** 绘制一帧弹幕：动画循环与暂停时的静态帧共用同一逻辑 */
  function drawFrame() {
    if (!els.canvas || !state.art) return;
    var ctx = els.canvas.getContext('2d');
    sizeCanvas();
    var w = els.canvas.clientWidth;
    var h = els.canvas.clientHeight;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    var t = state.art.currentTime;

    // 生成到时间点的弹幕
    while (state.danmakuIdx < state.danmaku.length &&
           state.danmaku[state.danmakuIdx].time <= t + 0.05) {
      spawnDanmaku(state.danmaku[state.danmakuIdx], t, w, h);
      state.danmakuIdx++;
    }

    // 绘制 + 清理出屏
    var remain = [];
    for (var i = 0; i < state.active.length; i++) {
      var d = state.active[i];
      if (d.mode === 4 || d.mode === 5) {
        // 底部/顶部固定弹幕：停留 4 秒
        if (t - d.start > 4) continue;
        ctx.textAlign = 'center';
        drawDanmaku(ctx, d, w / 2);
        remain.push(d);
      } else if (d.mode === 6) {
        // 逆向弹幕：从左向右移动（与普通弹幕方向相反）
        var rx = (t - d.start) * d.speed - d.width;
        if (rx > w) continue;
        ctx.textAlign = 'left';
        drawDanmaku(ctx, d, rx);
        remain.push(d);
      } else {
        var x = w - (t - d.start) * d.speed;
        if (x + d.width < 0) continue;
        ctx.textAlign = 'left';
        drawDanmaku(ctx, d, x);
        remain.push(d);
      }
    }
    state.active = remain;
  }

  /** 绘制单条弹幕：先描黑边再填充颜色，保证浅色画面上也可读 */
  function drawDanmaku(ctx, d, x) {
    ctx.font = danmakuFont(d.px);
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
    // 两层描边（先宽后窄）再填充：轮廓更饱满，细笔画处也不易断裂
    ctx.lineWidth = Math.max(3, Math.round(d.px / 5));
    ctx.strokeText(d.text, x, d.y);
    ctx.lineWidth = Math.max(1.5, Math.round(d.px / 9));
    ctx.strokeText(d.text, x, d.y);
    ctx.fillStyle = d.color;
    ctx.fillText(d.text, x, d.y);
  }

  /** 弹幕字体：加粗 + 常见中文字体栈，保证清晰度（测量与绘制共用同一字体） */
  function danmakuFont(px) {
    return '700 ' + px + 'px "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';
  }

  function spawnDanmaku(d, t, w, h) {
    var px = d.size >= 36 ? 28 : d.size >= 25 ? 20 : 16;
    var laneH = px + 6;
    var color = '#' + ('000000' + d.color.toString(16)).slice(-6);
    if (d.mode === 4 || d.mode === 5) {
      // 顶部(5) / 底部(4)：分配从顶/底开始的轨道
      var used = {};
      for (var i = 0; i < state.active.length; i++) {
        if (state.active[i].mode === d.mode) used[state.active[i].lane] = true;
      }
      var lane = 0;
      while (used[lane]) lane++;
      var y = d.mode === 5 ? 20 + lane * laneH : h - 20 - lane * laneH;
      state.active.push({
        mode: d.mode, text: d.text, color: color, px: px, start: t, lane: lane, y: y
      });
      return;
    }
    // 滚动弹幕：按轨道分配
    var ctx = els.canvas.getContext('2d');
    ctx.font = danmakuFont(px); // 与绘制用同一字体，保证测量宽度一致
    var tw = ctx.measureText(d.text).width;
    var speed = (w + tw) / 8;             // 约 8 秒穿过屏幕
    var duration = (w + tw) / speed;
    var lane = 0;
    while (state.lanes[lane] && state.lanes[lane] > t + 0.05) lane++;
    state.lanes[lane] = t + duration;
    state.active.push({
      mode: d.mode, text: d.text, color: color, px: px, start: t,
      speed: speed, width: tw, y: 20 + lane * laneH
    });
  }

  function sizeCanvas() {
    var c = els.canvas;
    if (!c) return;
    var dpr = window.devicePixelRatio || 1;
    var w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    var bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    // 尺寸变化超过阈值才重建位图，避免全屏过渡期间每帧重建导致卡顿
    if (Math.abs(c.width - bw) > dpr * 2 || Math.abs(c.height - bh) > dpr * 2) {
      c.width = bw;
      c.height = bh;
    }
    c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
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
    cancelAnimationFrame(state.rafId);
    state.rafId = 0;
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
    state.danmakuIdx = 0;
    state.active = [];
    state.lanes = [];
    state.subtitleBody = [];
    state.subtitleOn = false;
    state.resumePoint = 0;
    state.urlSwitching = false;
    state.loadAttempts = 0;
    state.freshTries = 0;
    state.qualityTries = 0;
    if (state.art) {
      try { state.art.pause(); } catch (e) { /* ignore */ }
      hideEndOverlay();
      if (els.canvas) {
        var ctx = els.canvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
        els.canvas.hidden = true;
      }
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
    setResumePoint: function (seconds) {
      state.resumePoint = Number(seconds) || 0;
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
