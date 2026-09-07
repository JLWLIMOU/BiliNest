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
    endOverlay: null // ArtPlayer 初始化后指向播放结束浮层
  };

  // 视频画面区域的单击 / 双击判定（见 bindClick）
  var clickTimer = null;
  var lastVideoClick = 0;
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
    pluginDanmaku: [],      // 适配 artplayer-plugin-danmuku 的弹幕数组
    playing: false,         // 播放状态（由 video:play/pause 事件维护）
    rafId: 0,
    subtitleVttUrl: null,   // 当前字幕的 Blob URL（切集时 revoke）
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
    endTimer: null,           // 播放结束自动连播倒计时
    lastDanmakuWidth: 0       // 弹幕容器宽度（用于全屏 resize 时修正速度）
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
          name: 'subtitle',
          position: 'right',
          index: 12,
          html: '<span class="bilinest-ctl">字幕</span>',
          tooltip: '字幕开关',
          click: function () { toggleSubtitle(); }
        }
      ],
      plugins: [
        window.artplayerPluginDashControl ? window.artplayerPluginDashControl() : null,
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
          display: true,
          theme: 'dark',
          heatmap: false,
          emitter: false,             // 不显示“发弹幕”输入框（只读观看，避免遮挡控件）
          beforeEmit: function () { return false; }, // 禁止发送弹幕
          filter: function () { return true; }
        })
      ],
      // DASH 流：用 dash.js 初始化，并把实例挂到 art.dash，
      // 供 artplayer-plugin-dash-control 读取码率列表生成清晰度下拉。
      // 注意：ArtPlayer v5 以 fn(videoEl, url, art) 形式调用，this === art。
      customType: {
        dash: function (videoEl, url) {
          var art = this;
          if (!window.dashjs || !url) {
            console.error('[bilinest][dash] dash.js 未加载或 url 为空，放弃 DASH 播放');
            return;
          }
          // 切换视频时，先释放上一次 dash.js 实例（ArtPlayer 不会自动清理）
          if (art.dash && art.dash.reset) {
            try { art.dash.reset(); } catch (e) { /* ignore */ }
          }
          // 直接用相对路径（同源），避免任何绝对 URL/跨域/Headers 问题
          var player = window.dashjs.MediaPlayer().create();
          try {
            var ck = (typeof store !== 'undefined' && store.getCookie && store.getCookie()) || '';
            if (ck) {
              player.updateSettings({ streaming: { httpHeaders: { Cookie: ck } } });
            }
            player.initialize(art.video, url, false);
            art.dash = player;
            var ev = (window.dashjs.MediaPlayer.events && window.dashjs.MediaPlayer.events.STREAM_INITIALIZED) || 'streamInitialized';
            var errEv = (window.dashjs.MediaPlayer.events && window.dashjs.MediaPlayer.events.ERROR) || 'error';
            var mpdEv = (window.dashjs.MediaPlayer.events && window.dashjs.MediaPlayer.events.MANIFEST_LOADED) || 'manifestLoaded';
            player.on(mpdEv, function () {
              console.log('[bilinest][dash] MANIFEST_LOADED');
            });
            player.on(ev, function () {
              console.log('[bilinest][dash] STREAM_INITIALIZED');
              var p = art.plugins && art.plugins.artplayerPluginDashControl;
              if (p && p.update) p.update();
              if (art.loading && art.loading.hide) art.loading.hide();
            });
            player.on(errEv, function (e) {
              var info = e && e.error ? (e.error.code + ':' + (e.error.message || '')) : (e && e.message) || 'unknown';
              console.error('[bilinest][dash] dash.js 错误：', info, e);
            });
          } catch (e) {
            console.error('[bilinest][dash] 初始化异常：', e && e.message, e);
          }
          return function () {
            try { if (player) player.reset(); } catch (e) { /* ignore */ }
            art.dash = null;
          };
        }
      }
    });

    state.art = art;
    els.endOverlay = els.player.querySelector('#endOverlay');
    applySubSettings(); // 字幕位置 / 字号（可能已持久化，先恢复再显示）
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
      window.dispatchEvent(new CustomEvent('bilinest-pause'));
    });
    art.on('video:seeked', function () {
    });
    art.on('video:ended', function () {
      state.playing = false;
      window.dispatchEvent(new CustomEvent('bilinest-ended'));
      showEndOverlay();
    });
    art.on('video:timeupdate', function () {
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

    // 修复全屏弹幕加速：覆盖插件 resize，在其重置 transition 之前修正 $restTime
    var dp = danmakuPlugin();
    if (dp && typeof dp.resize === 'function') {
      var _origResize = dp.resize.bind(dp);
      dp.resize = function () {
        var newW = art.player && art.player.clientWidth ? art.player.clientWidth : 0;
        if (newW > 0 && dp.queue) {
          var queue = dp.queue;
          for (var i = 0; i < queue.length; i++) {
            var d = queue[i];
            if (d.$state !== 'emit' || d.mode !== 0 || !d.$ref) continue;
            var tw = d.$ref.clientWidth || 0;
            var oldW = state.lastDanmakuWidth || newW;
            if (oldW > 0 && oldW !== newW && d.$restTime > 0) {
              var oldDist = oldW + tw;
              var newDist = newW + tw;
              if (oldDist > 0) d.$restTime = d.$restTime * newDist / oldDist;
            }
          }
        }
        state.lastDanmakuWidth = newW;
        _origResize();
      };
    }
  }

  /** 清理挂起的“重试同地址”定时器：换地址/切换前必须清理，否则旧定时器会打断新加载 */
  function clearPendingRetry() {
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
  }

  /**
   * 视频加载失败处理（DASH 流）。
   * 清晰度切换 / 分段重试由 artplayer-plugin-dash-control + dash.js 内部完成，
   * 这里只做兜底：本地视频给简短提示；B 站视频转交应用层降级到官方播放器。
   */
  function handleLoadError() {
    var art = state.art;
    var v = art.video;
    var code = (v && v.error && v.error.code) || 0;
    // 诊断：把原生 media error 打到控制台，便于定位“CDN 缺失”类降级的根因
    console.error('[bilinest][load-error] kind=' + state.kind + ' video.error.code=' + code,
      v && v.error ? { message: v.error.message, code: v.error.code } : null,
      'src=' + (v && v.currentSrc));
    if (state.kind !== 'bili') {
      var codeText = code === 1 ? '请求中止' : code === 2 ? '网络异常' : code === 3 ? '解码失败' : code === 4 ? '地址不支持' : '未知错误';
      toast('视频加载失败（' + codeText + '），请检查本地文件是否仍可用', 'error', 8000);
      return;
    }
    if (state.fallbackHandler) {
      state.fallbackHandler(state.bvid, state.cid);
      return;
    }
    toast('视频加载失败，请检查网络后重试', 'error', 8000);
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
  /** 构造 DASH MPD 地址：清晰度由 artplayer-plugin-dash-control 依据 MPD 码率列表自动提供 */
  function dashMpdUrl(bvid, cid, qn) {
    // 不再把 Cookie 塞进 URL（太长会被拦截），改由 dash.js 的 httpRequestHeaders 透传 Header
    return '/api/dash.mpd?bvid=' + encodeURIComponent(bvid) +
           '&cid=' + encodeURIComponent(cid) + '&qn=' + (qn || 80);
  }

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

    els.player.hidden = false;   // 先让容器可见，再创建播放器，避免隐藏状态下初始化
    ensureArt();
    state.art.poster = opts.poster || '';
    showBiliControls(true);
    updateSubtitleControl();

    // DASH：清晰度由 artplayer-plugin-dash-control 自动生成下拉
    state.mpdUrl = dashMpdUrl(bvid, cid, 80);
    state.art.type = 'dash';
    state.art.url = state.mpdUrl;

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
    state.art.type = 'auto';
    state.art.url = url;
    return true;
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
    state.lastDanmakuWidth = (els.player && els.player.clientWidth) || 0;
    var arr = toPluginDanmaku(list);
    state.pluginDanmaku = arr;
    var p = danmakuPlugin();
    if (p) p.load();  // 无参=重置队列后从 danmuku 函数重新加载
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
    return firstOk && list.length > 0 ? list : null; // protobuf 返回空 → 让调用方回退 XML
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

  /* ---------------- 字幕（改用 ArtPlayer 原生组件）设置 ---------------- */
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

  /** 字幕位置映射：滑块 0~100 → 距底部 2%~16%，始终位于底部区域做微调 */
  function subPosToBottom(v) {
    var x = Math.min(100, Math.max(0, Number(v) || 0));
    return 2 + (x / 100) * 14;
  }

  /** 取 ArtPlayer 原生字幕 DOM 节点（加载后才有）；初始化阶段 art.player 可能尚未就绪，需容错 */
  function nativeSubtitleEl() {
    try {
      if (!state.art || !state.art.player) return null;
      return state.art.player.querySelector('.art-subtitle');
    } catch (e) { return null; }
  }

  /** 显示 / 隐藏原生字幕：优先用官方 API，失败则直控元素兜底 */
  function setNativeSubtitleVisible(on) {
    var sub = state.art && state.art.subtitle;
    try {
      if (sub) { if (on) { if (sub.show) sub.show(); } else { if (sub.hide) sub.hide(); } }
    } catch (e) { /* ignore */ }
    var el = nativeSubtitleEl();
    if (el) {
      el.style.visibility = on ? '' : 'hidden';
    }
    if (on) setTimeout(applySubSettings, 30); // 显示时（元素已就绪）确保应用位置 / 字号
  }

  /** 把位置 / 字号设置应用到原生字幕层 */
  function applySubSettings() {
    var el = nativeSubtitleEl();
    if (!el) return;
    // 底部偏移（CSS 百分比），与原生默认叠加
    el.style.bottom = subPosToBottom(state.subSettings.pos).toFixed(2) + '%';
    resizeSubtitleFont();
  }

  /** 字幕字号按播放器实际宽度等比缩放（全屏时容器变大，字号同步变大） */
  function resizeSubtitleFont() {
    var el = nativeSubtitleEl();
    if (!el || !els.player) return;
    var w = els.player.clientWidth || els.player.offsetWidth || 0;
    if (!w) return;
    var z = state.subSettings.size || 'md';
    var factor = SUB_SIZE_FACTORS[z] || SUB_SIZE_FACTORS.md;
    el.style.fontSize = Math.max(12, Math.round(w * factor)) + 'px';
  }

  /** 把 B 站 CC 字幕（{from,to,content}[]）转换为 WebVTT 文本 */
  function subtitleBodyToVtt(body) {
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    function p3(n) { return (n < 100 ? '0' : '') + (n < 10 ? '0' : '') + n; }
    function fmt(sec) {
      sec = Math.max(0, sec);
      var h = Math.floor(sec / 3600);
      var m = Math.floor((sec % 3600) / 60);
      var s = Math.floor(sec % 60);
      var ms = Math.round((sec - Math.floor(sec)) * 1000);
      return p2(h) + ':' + p2(m) + ':' + p2(s) + '.' + p3(ms);
    }
    var lines = ['WEBVTT', ''];
    for (var i = 0; i < body.length; i++) {
      var it = body[i];
      var from = Number(it.from) || 0;
      var to = Number(it.to) || 0;
      if (to <= from) to = from + 0.001;
      var content = String(it.content == null ? '' : it.content).replace(/-->/g, '—>');
      lines.push(String(i + 1));
      lines.push(fmt(from) + ' --> ' + fmt(to));
      lines.push(content);
      lines.push('');
    }
    return lines.join('\n');
  }

  /* ---------------- 字幕开关 ---------------- */
  function toggleSubtitle() {
    if (!state.subtitleVttUrl) return;
    state.subtitleOn = !state.subtitleOn;
    setNativeSubtitleVisible(state.subtitleOn);
    updateSubtitleControl();
  }

  function updateSubtitleControl() {
    var art = state.art;
    if (!art) return;
    var el = art.controls.subtitle;
    if (!el) return;
    var span = el.querySelector('.bilinest-ctl');
    if (!span) return;
    var has = !!state.subtitleVttUrl;
    if (!has) state.subtitleOn = false;
    span.classList.toggle('disabled', !has);
    span.classList.toggle('off', !state.subtitleOn);
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
    if (state.subtitleVttUrl) { try { URL.revokeObjectURL(state.subtitleVttUrl); } catch (e) {} }
    state.subtitleVttUrl = null;
    state.subtitleOn = false;
    if (body.length) {
      var vtt = subtitleBodyToVtt(body);
      state.subtitleVttUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
      var sub = state.art && state.art.subtitle;
      try {
        if (sub) { if (sub.switch) sub.switch(state.subtitleVttUrl, 'vtt'); else if (sub.load) sub.load(state.subtitleVttUrl, 'vtt'); }
      } catch (e) { /* ignore */ }
      applySubSettings();             // 应用字号 / 位置样式
      setNativeSubtitleVisible(false); // 默认关，由用户手动开
    }
    updateSubtitleControl();
  }

  /* ---------------- 控件显隐 ---------------- */
  /** 本地视频没有弹幕/字幕/画质，隐藏对应控件 */
  function showBiliControls(show) {
    if (!state.art) return;
    ['danmaku', 'subtitle'].forEach(function (name) {
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
    state.mpdUrl = null;
    state.qn = 0;
    state.qualities = [];
    state.urls = [];
    state.urlIdx = 0;
    state.danmaku = [];
    state.pluginDanmaku = [];
    if (state.subtitleVttUrl) { try { URL.revokeObjectURL(state.subtitleVttUrl); } catch (e) {} }
    state.subtitleVttUrl = null;
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
      // 切换视频前释放 dash.js 实例（ArtPlayer 不会自动清理自定义源）
      if (state.art.dash) {
        try { state.art.dash.reset(); } catch (e) { /* ignore */ }
        state.art.dash = null;
      }
      hideEndOverlay();
      // 清空弹幕（已改由插件渲染）：先清数据源，再调 load()（无参=重置队列）
      state.pluginDanmaku = [];
      var dp = danmakuPlugin();
      if (dp) dp.load();
      setNativeSubtitleVisible(false);
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
      // DASH：清晰度与重试由 dash.js 内部完成；刷新即重新拉取 MPD（cookie/签名可能已变化）
      state.art.url = dashMpdUrl(state.bvid, state.cid, 80);
      return Promise.resolve(true);
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
