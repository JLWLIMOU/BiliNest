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
    playerView: document.getElementById('playerView'),   // 整个播放页（画面 + 选集面板 + 标题区）
    canvas: null,   // ArtPlayer 初始化后指向弹幕画布
    endOverlay: null // ArtPlayer 初始化后指向播放结束浮层
  };

  // 视频画面区域的单击 / 双击判定（见 bindClick）
  var clickTimer = null;        // 挂起中的单击（双击窗口过去后才执行）
  var lastVideoClick = 0;       // 上一"第一下"的时间
  var lastToggle = null;        // 已经执行过的单击切换（迟到的双击用它回滚）
  var DOUBLE_CLICK_MS = 300;    // 与 ArtPlayer 的 DBCLICK_TIME 对齐
  // 弹幕分段：官方网页端每 6 分钟一包、每包最多 6000 条。
  // 上限 250 包 ≈ 25 小时视频，防止异常视频无限拉取。
  var MAX_DANMAKU_SEGMENTS = 250;
  // 段间请求间隔：分段请求仍会打到 B 站，礼貌性限速，降低触发风控的概率
  var DANMAKU_SEGMENT_DELAY_MS = 120;
  // 字幕字号与播放器宽度的比例系数（随窗口 / 全屏等比缩放）
  var SUB_SIZE_FACTORS = { sm: 0.020, md: 0.024, lg: 0.030, xl: 0.038 };
  /*
   * 播放倍速档位。挑这 7 档的理由：0.5/0.75 给"听不懂要抠细节"的，
   * 1.25/1.5/1.75 给"听课时拉进度"的（1.25 是最常用的一档），
   * 0.5 以下、2 以上基本只有刷课会用，列出来只会让下拉变长，不收。
   */
  var PLAY_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  // 字幕请求序号：快速切换视频时，用序号丢弃旧视频的过期字幕结果
  var subtitleSeq = 0;
  // 弹幕请求序号：与字幕同理，防止旧视频的弹幕覆盖新视频
  var danmakuSeq = 0;
  // MPD 请求序号：清空/切集时让还没回来的 MPD 请求失效
  var mpdSeq = 0;

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
    chapters: [],           // 章节（view_points）：进度条分节标记 + 控制条菜单
    active: [],             // 正在显示的弹幕
    lanes: [],              // 弹幕轨道占用
    pluginDanmaku: [],      // 适配 artplayer-plugin-danmuku 的弹幕数组
    playing: false,         // 播放状态（由 video:play/pause 事件维护）
    rafId: 0,
    subtitleVttUrl: null,   // 当前字幕的 Blob URL（切集时 revoke）
    subtitleOn: false,      // 字幕默认关闭，由用户手动开启
    subSettings: loadSubSettings(), // 字幕位置 / 字号（持久化到 localStorage）
    playRate: loadPlayRate(),       // 播放倍速（持久化到 localStorage）
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
    pendingQuality: null,   // 待切换的清晰度（等开始播放后再切，避免初始化阶段切流卡住首帧）
    retryTimer: null,       // “重试同地址”的挂起定时器
    fallbackHandler: null,  // 全部方案失败后的兜底（切官方播放器）
    episodeNavHandler: null, // 上一集 / 下一集点击回调（由应用层提供）
    chapterHandler: null,    // 「章节」按钮点击回调（由应用层提供，弹出章节菜单）
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
          name: 'chapters',
          position: 'right',
          index: 10,
          html: '<span class="bilinest-ctl">章节</span>',
          tooltip: '章节',
          click: function () {
            if (!state.chapters.length || !state.chapterHandler) return;
            state.chapterHandler(state.chapters.slice(), state.art.controls.chapters);
          }
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
          name: 'speed',
          position: 'right',
          index: 11,
          html: rateControlHtml(),
          tooltip: '播放倍速',
          selector: rateItems(),
          onSelect: function (item) {
            if (item && item.value) setPlayRate(Number(item.value));
            return rateControlHtml();   // 控件上直接显示当前倍速
          }
        },
        {
          name: 'substyle',
          position: 'right',
          index: 13,
          html: '<span class="bilinest-ctl">Aa</span>',
          tooltip: '字幕字号 / 位置',
          selector: subStyleItems(),
          onSelect: function (item) {
            if (item && item.value) {
              var p = String(item.value).split(':');
              var patch = {};
              patch[p[0]] = p[0] === 'pos' ? Number(p[1]) : p[1];
              setSubSettings(patch);
            }
            return item ? item.html : '';
          }
        }
      ],
      plugins: [
        window.artplayerPluginDashControl ? window.artplayerPluginDashControl({
          quality: { control: true, title: '画质' }
        }) : null,
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
          // 注意：插件的开关选项叫 visible（以前这里写的 display 是无效字段，插件根本不认）。
          // 默认值来自设置 → 播放 →「默认显示弹幕」。
          visible: loadDanmakuOnDefault(),
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
          var player = window.dashjs.MediaPlayer().create();
          art.dash = player;
          var mySeq = ++mpdSeq;
          var mpdBlobUrl = '';
          function bindEvents() {
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
              // 插件重建完码率下拉之后，再按设置里的"默认清晰度"选一档
              applyDefaultQuality();
              if (art.loading && art.loading.hide) art.loading.hide();
            });
            player.on(errEv, function (e) {
              var info = e && e.error ? (e.error.code + ':' + (e.error.message || '')) : (e && e.message) || 'unknown';
              console.error('[bilinest][dash] dash.js 错误：', info, e);
            });
          }
          /*
           * MPD 由前端自己带凭据取回来，再以 blob 交给 dash.js。原因有三：
           *   1. 这个版本的 dash.js 不认 streaming.httpHeaders（控制台会报
           *      "Settings parameter streaming.httpHeaders is not supported"）；
           *   2. 浏览器的 fetch/XHR 禁止 JS 设置 Cookie 头，只能走自定义头（X-Bili-Cookie）；
           *   3. 不带凭据拉 MPD = 未登录档位，清晰度会被卡在 480P（实测 1080→480）。
           * MPD 里的 BaseURL 由服务端写成绝对地址，所以 blob 相对路径解析不会出问题。
           */
          var ck = (typeof store !== 'undefined' && store.getCookie && store.getCookie()) || '';
          fetch(url, { headers: ck ? { 'X-Bili-Cookie': ck } : {} })
            .then(function (res) {
              if (!res.ok) throw new Error('MPD HTTP ' + res.status);
              return res.text();
            })
            .then(function (xml) {
              if (mySeq !== mpdSeq) return;             // 已经切到别的视频
              mpdBlobUrl = URL.createObjectURL(new Blob([xml], { type: 'application/dash+xml' }));
              art.mpdBlobUrl = mpdBlobUrl;
              /*
               * 关键一步：在把 MPD 交给 dash.js **之前**，先按设置里的默认清晰度
               * 把 initialBitrate 定下来。这样它一开始就选对档位，
               * 不需要在初始化阶段切流 —— 那正是"刚打开视频卡在 0 秒一直转圈、
               * 要手动拖一下进度条才动"的原因（实测：改成固定档位后必现）。
               */
              var reps = parseMpdVideoReps(xml);
              var wantBw = preferredInitialBandwidth(reps);
              if (wantBw) {
                try {
                  player.updateSettings({
                    streaming: { abr: { autoSwitchBitrate: { video: false }, initialBitrate: { video: wantBw } } }
                  });
                } catch (e) {
                  console.warn('[bilinest][dash] 设置初始码率失败：', e && e.message);
                }
              }
              bindEvents();
              try {
                player.initialize(art.video, mpdBlobUrl, false);
              } catch (e) {
                console.error('[bilinest][dash] 初始化异常：', e && e.message, e);
                handleLoadError();
              }
            })
            .catch(function (e) {
              if (mySeq !== mpdSeq) return;
              console.error('[bilinest][dash] MPD 获取失败：', e && e.message);
              handleLoadError();
            });
          return function () {
            try { if (player) player.reset(); } catch (e) { /* ignore */ }
            var last = mpdBlobUrl;
            mpdBlobUrl = '';
            if (last) {
              try { URL.revokeObjectURL(last); } catch (e) { /* ignore */ }
              if (art.mpdBlobUrl === last) art.mpdBlobUrl = null;
            }
            if (art.dash === player) art.dash = null;
          };
        }
      }
    });

    state.art = art;
    mutePlayPauseNotice(art);
    els.endOverlay = els.player.querySelector('#endOverlay');
    applySubSettings(); // 字幕位置 / 字号（可能已持久化，先恢复再显示）
    applyPlayRate();    // 上次用的倍速（换集 / 重试后由 loadedmetadata 再补一次）
    applyDanmakuDefault(); // 设置里的"默认显示弹幕"：建播放器时就定好，图标状态一并同步
    bindEndOverlay();
    // ArtPlayer 模板里自带 <track default kind="metadata" src="">：
    //   · src="" 会被解析成当前页面地址，浏览器会白请求一次 —— 所以清掉 src；
    //   · 但这个 <track> 不能删！字幕组件只认 video.textTracks[0]，
    //     没有它就 switch() 直接 return null（点了字幕没反应，见下方 loadSubtitles）。
    var tplTrack = els.player.querySelector('track');
    if (tplTrack) tplTrack.removeAttribute('src');
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
      // 默认清晰度如果需要在开播后纠正一次，就趁现在（避开初始化阶段切流）
      if (state.pendingQuality != null) setTimeout(applyPendingQuality, 800);
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
      // 换流（尤其切清晰度 / dash 重建 MSE）后 playbackRate 可能被重置回 1.0，这里补回来
      applyPlayRate();
    });
    art.on('video:loadedmetadata', function () {
      // 时长这时才确定：章节刻度按新的总时长重画（ArtPlayer 自己也会按 option.highlight 画一遍）
      renderChapterMarks();
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
  /* ---------------- 进度卡住兜底 ---------------- */
  /*
   * 症状（用户报过、也实测复现过）：刚打开一个视频，进度条停在某个位置一直转圈，
   * 手动拖一下进度条就正常了 —— 说明是"这一下没续上"，而不是地址或解码有问题。
   * dash.js 遇到这种情况不会抛 error（所以现有的 handleLoadError 兜不到），
   * 于是这里自己盯着：明明处于播放中、进度却连续 8 秒纹丝不动，就替用户"轻推一下"；
   * 推两次还不动，就重新取一次播放地址（签名 / 线路可能失效）。
   *
   * 静默恢复：不弹提示，用户看到的只是"卡了一下又自己好了"。
   */
  var stallTimer = null;
  var stallLastT = -1;
  var stallQuiet = 0;
  var stallNudges = 0;

  function stopStallWatch() {
    if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
  }

  function startStallWatch() {
    stopStallWatch();
    stallLastT = -1;
    stallQuiet = 0;
    stallNudges = 0;
    stallTimer = setInterval(function () {
      var art = state.art;
      if (!art || state.kind !== 'bili') return;
      var v = art.template && art.template.$video;
      if (!v) return;
      // 暂停 / 拖动中 / 播完：不算卡住
      if (v.paused || v.seeking || v.ended) {
        stallLastT = v.currentTime;
        stallQuiet = 0;
        return;
      }
      if (stallLastT >= 0 && Math.abs(v.currentTime - stallLastT) < 0.05) {
        stallQuiet++;
        if (stallQuiet >= 4) {            // 2 秒一次 × 4 ≈ 8 秒没动
          stallQuiet = 0;
          stallNudges++;
          recoverFromStall(art, v);
        }
      } else {
        stallQuiet = 0;
        if (v.currentTime > 1) stallNudges = 0;   // 正常播放中，计数归零
      }
      stallLastT = v.currentTime;
    }, 2000);
  }

  function recoverFromStall(art, v) {
    if (stallNudges > 3) return;   // 别没完没了地折腾，交给用户手动处理
    console.warn('[bilinest][play] 进度卡在 ' + (Math.round(v.currentTime * 10) / 10) + 's，第 ' + stallNudges + ' 次自动恢复');
    if (stallNudges <= 2) {
      // 轻推：等价于用户"手动拖一下进度条"，绝大多数情况这一下就续上了
      try { v.currentTime = Math.max(0.1, v.currentTime + 0.1); } catch (e) { /* ignore */ }
      return;
    }
    // 推两次仍不动：重新取一次播放地址（可能签名过期 / 线路问题）
    state.playurlAt = 0;
    try { art.url = dashMpdUrl(state.bvid, state.cid, 80); } catch (e) { /* ignore */ }
  }

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
      // 用我们自己的文案覆盖内置那句（内置是「音量: 50」，没有百分号也不带静音态）；
      // 位置由 styles.css 统一挪到画面正中。
      if (art.notice) art.notice.show = vol === 0 ? '静音' : '音量 ' + Math.round(vol * 100) + '%';
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
    lastToggle = null;
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
   *
   * 为什么不用 ArtPlayer 自带的那套：它按 DBCLICK_TIME(300ms) 自己数点击 —— 第一下
   * 立即切播放状态，第二下才切全屏。于是"双击进全屏"必然先暂停一下；再慢一点的双击
   * 会被算成两次单击，最后停在暂停上。
   *
   * 这里在捕获阶段接管（stopImmediatePropagation 让事件到不了 ArtPlayer 的处理器）：
   *   - 第一下：挂起 300ms，期间没有第二下才切播放状态（单击响应慢 300ms，换双击不碰播放状态）；
   *   - 第二下在 300ms 内：取消挂起的动作，只切全屏；
   *   - 第二下比 300ms 还慢（系统双击阈值默认 500ms）：那一下的切换已经执行了，回滚它再切全屏，
   *     用户最多看到一闪，而不是"进了全屏还停着"。
   *
   * 触屏 / 手写笔保留 ArtPlayer 原生的手势（滑动调音量等）。
   * 注意这里按 **pointerType** 判断而不是 navigator.maxTouchPoints：带触摸屏的笔记本
   * maxTouchPoints 一直大于 0，用鼠标时也被整段跳过，就会退回上面那个"双击必暂停"的行为
   * （实测：有触摸屏的机器上，双击 ≈200ms → 暂停 + 全屏，且保持暂停）。
   *
   * 控制条、中央播放按钮等仍由 ArtPlayer 即时处理。
   */
  function bindClick() {
    if (!els.player) return;
    els.player.addEventListener('click', function (e) {
      var art = state.art;
      if (!art) return;
      var pointer = e.pointerType;
      if (pointer && pointer !== 'mouse' && pointer !== 'pen') return;  // 触屏保留 ArtPlayer 原生手势

      var now = Date.now();
      var onVideo = e.target === art.video;
      // 第二下：挂起中的单击还没执行（够快），或者浏览器自己认定为双击（detail=2），
      // 或者刚刚才执行过第一下的切换（慢一点的双击），都算双击
      var isSecond = clickTimer !== null || e.detail >= 2 || (now - lastVideoClick <= DOUBLE_CLICK_MS);

      /*
       * 第二下没落在 <video> 上、而是落在画面中央那个播放按钮（.art-state）上 —— 这是
       * 第一下的延迟切换把画面暂停、按钮冒出来接住了第二下。也算双击处理，否则观感是
       * "暂停一下又自己播起来，还没进全屏"。控制条上的点击不接管：双击进度条是找位置，
       * 不是要全屏。
       */
      if (!onVideo) {
        if (!isSecond || !e.target.closest || !e.target.closest('.art-state')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        clickTimer = null;
        lastVideoClick = 0;
        undoLastToggle();
        if (typeof art.fullscreen === 'boolean') {
          art.fullscreen = !art.fullscreen;
        }
        return;
      }

      e.preventDefault();
      e.stopImmediatePropagation();                    // 阻止事件到达 ArtPlayer 的 click 处理

      if (isSecond) {
        // 双击：取消挂起的单击动作 + 回滚已经执行过的那次切换，仅切换全屏
        clearTimeout(clickTimer);
        clickTimer = null;
        lastVideoClick = 0;
        undoLastToggle();
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
          var v = state.art.video;
          var wasPaused = !!(v && v.paused);
          var r = state.art.toggle();
          lastToggle = { at: Date.now(), wasPaused: wasPaused };
          if (r && typeof r.catch === 'function') r.catch(function () { /* 自动播放可能被拦截 */ });
        }, DOUBLE_CLICK_MS);
      }
    }, true);
  }

  /**
   * 回滚刚刚由"单击"造成的播放状态切换（迟到的双击用）。
   * 只在状态确实还停在"我们刚切到的那一边"时才回滚，避免推翻用户自己的操作；
   * 超过 600ms 就当那次单击已经成立，不再回滚。
   */
  function undoLastToggle() {
    var art = state.art;
    if (!art || !lastToggle) return;
    var pending = lastToggle;
    lastToggle = null;
    if (Date.now() - pending.at > 600) return;
    var v = art.video;
    if (!v || v.paused === pending.wasPaused) return;
    var r = art.toggle();
    if (r && typeof r.catch === 'function') r.catch(function () { /* ignore */ });
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

  /**
   * 让空格 / 方向键等快捷键在刚进播放页时就能用。
   *
   * ArtPlayer 的 hotkey 有个隐藏前置条件：只有 `art.isFocus === true` 时才处理
   * 空格、方向键等（见其源码 hotkey 模块）。而 isFocus 仅在「document click 的
   * 目标落在播放器内部」时被置位——所以刚进播放页、还没点过任何地方时，空格暂停、
   * 方向键调进度全都没反应，必须先点一下播放区/进度条"激活"。
   *
   * 这里在载入视频后主动置位。**必须延到下一个事件循环**：打开播放页的那次点击
   * 还在冒泡，ArtPlayer 的 document:click 处理器随后会把"目标不在播放器内"的
   * 点击判为 blur；同步设置会被它立刻覆盖掉。
   */
  function armHotkeys() {
    setTimeout(function () {
      if (!state.art) return;
      if (els.playerView && els.playerView.hidden) return;   // 已经离开播放页，别抢快捷键
      state.art.isFocus = true;
      state.art.isInput = false;
    }, 0);
  }

  /**
   * 播放页范围内的任何点击，都重新让快捷键生效。
   *
   * 背景：ArtPlayer 只把「点击落在播放器元素内」当作 focus，落在外面就判为 blur
   * 并让快捷键失效——所以看课时点一下右侧选集面板、再按空格就没反应了。这里把
   * 判定范围放宽到整个播放页（#playerView：画面、上下集、选集面板、标题区）：
   * 只要还在播放页，快捷键就一直可用。离开播放页时 stop() 会把它关掉，避免回到
   * 主页后按空格误触发后台播放。
   *
   * 同样必须延到下一个事件循环（armHotkeys 里做了）：ArtPlayer 自己的
   * document:click 处理器会把 isFocus 覆写为 false，同步设置会被它盖掉。
   */
  document.addEventListener('click', function (e) {
    if (!state.art) return;
    if (!els.playerView || !els.playerView.contains(e.target)) return;
    armHotkeys();
  });

  /**
   * 播放页内的任何"按下"都重新激活快捷键 —— 用 pointerdown，而不是 click。
   *
   * 为什么必须有这一条：bindClick() 会在捕获阶段把**画面**上的 click 吞掉
   * （`stopImmediatePropagation()`，用来避免双击进出全屏时闪一次暂停）——
   * 那次 click 根本到不了 document，所以 ArtPlayer 的 `document:click`（它才是
   * 决定 isFocus 的地方）和上面那个 document 监听都不会跑。
   * 结果就是：一旦 isFocus 因为"点到播放页以外"变成 false，
   * **点画面永远复活不了快捷键**，只有点控制条（进度条等）才行 ——
   * 这正是"全屏里还得先激活进度条才能用空格 / 方向键"的原因。
   *
   * pointerdown 比 click 早、且在捕获阶段，任何 click 层面的拦截都影响不到它。
   * 点在输入框（弹幕输入等）上时不动：ArtPlayer 自己也会跳过 INPUT，
   * 免得把输入状态搅乱。
   */
  if (els.playerView) {
    els.playerView.addEventListener('pointerdown', function (e) {
      if (!state.art) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      armHotkeys();
    }, true);
  }

  /**
   * 进出全屏也重新激活一次。
   * 全屏是"另一个上下文"：进全屏时浏览器会把焦点挪到全屏元素上，
   * 而且如果进全屏前光标停在某个输入框里（例如刚发过弹幕），
   * 空格会被那个输入框吃掉 —— 所以进全屏时先把输入框失焦，再置位。
   */
  document.addEventListener('fullscreenchange', function () {
    if (!state.art) return;
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl && els.playerView && els.playerView.contains(fsEl)) {
      var ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
        try { ae.blur(); } catch (err) { /* 忽略 */ }
      }
    }
    if (!els.playerView || els.playerView.hidden) return;
    armHotkeys();
  });

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

    armHotkeys();   // 进播放页即可用快捷键，不必先点一下（详见 armHotkeys 注释）
    startStallWatch();   // 首帧/中途卡住时自动恢复（见 startStallWatch 注释）

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
    /*
     * 本地视频没有 dash 实例，但 ArtPlayer 会照常触发 clearness-control 插件的 ready：
     * 插件内部直接调 art.dash.getVideoElement()，于是每次播本地视频都抛一个
     * "Cannot read properties of undefined (reading 'getVideoElement')"。
     * 给它一个空壳（视频元素对得上、码率列表为空），插件拿到空列表就自己 return 了。
     */
    state.art.dash = {
      getVideoElement: function () { return state.art.template.$video; },
      getBitrateInfoListFor: function () { return []; },
      getTracksFor: function () { return []; },
      getCurrentTrackFor: function () { return null; },
      reset: function () { /* 本地视频没有 dash 实例可重置 */ }
    };
    armHotkeys();
    return true;
  }

  /* ---------------- 弹幕 ---------------- */
  /* ---------------- 章节（view_points） ---------------- */

  /**
   * 章节：B 站把视频分成若干段（`x/player/wbi/v2` 的 `view_points`，from/to 单位是秒，
   * 和字幕来自同一份响应，所以不额外多打一次接口）。
   * 两处用到：进度条上的分节刻度、控制条「章节」菜单（菜单由应用层渲染，见 setChapterHandler）。
   */
  function applyChapters(list) {
    state.chapters = (list || []).filter(function (c) { return c && c.from >= 0 && c.text; });
    var art = state.art;
    if (art) {
      // 同步给 ArtPlayer：它会在 loadedmetadata 时按这份数据重建刻度（见 vendor 的 progress 模块）
      try {
        art.option.highlight = state.chapters.map(function (c) {
          return { time: c.from, text: c.text };
        });
      } catch (e) { /* option 不可写就算了，下面自己画 */ }
    }
    renderChapterMarks();
    updateChapterControl();
  }

  /** 把章节刻度画到进度条上（结构照 ArtPlayer 自己的那份：data-time / data-text + left%） */
  function renderChapterMarks() {
    var art = state.art;
    if (!art || !els.player) return;
    var box = els.player.querySelector('.art-progress-highlight');
    if (!box) return;
    box.textContent = '';
    var dur = Number(art.duration) || (art.video && Number(art.video.duration)) || 0;
    if (!dur || !state.chapters.length) return;
    state.chapters.forEach(function (c) {
      if (!(c.from > 0)) return;                 // 0 秒那根是起点，画上去只是噪音
      var left = Math.max(0, Math.min(100, (c.from / dur) * 100));
      var span = document.createElement('span');
      span.setAttribute('data-time', String(c.from));
      span.setAttribute('data-text', c.text);
      span.style.left = left + '%';
      box.appendChild(span);
    });
  }

  /** 有章节才显示控制条上的「章节」按钮 */
  function updateChapterControl() {
    var art = state.art;
    if (!art || !art.controls || !art.controls.chapters) return;
    var el = art.controls.chapters;
    el.style.display = state.kind === 'bili' && state.chapters.length ? '' : 'none';
  }

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
        /*
         * B 站弹幕模式：1/2/3 滚动、4 底部、5 顶部、6 逆向滚动、7 高级（正文是定位用的
         * JSON 数组）、8 代码、9 BAS。7 起的正文不是给人读的文字，画布也还原不了它们
         * 的特效，直接跳过（否则屏幕上会滚过一串 JSON）。
         */
        if (mode < 1 || mode > 6) continue;
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

  /* ---------------- 播放倍速 ---------------- */

  /* ---------------- 默认清晰度 ---------------- */

  /* ---------------- 弹幕 / 字幕的默认值（设置 → 播放） ---------------- */

  /** 设置里的"默认显示弹幕"（缺省视为开，保持老行为） */
  function loadDanmakuOnDefault() {
    var v = (store && store.get && store.get('danmakuOn'));
    return v === false ? false : true;
  }

  /** 设置里的"默认开启字幕"（缺省关，保持老行为） */
  function loadSubtitleOnDefault() {
    var v = (store && store.get && store.get('subtitleOnDefault'));
    return v === true;
  }

  /**
   * 把"默认显示弹幕"应用到当前播放器。
   * 走插件自己的 config({visible}) + reset()：前者管显示/隐藏与 show/hide 事件，
   * 后者把控制条上那个「弹」按钮的图标状态同步过来（跟用户手点那个按钮是同一条路径）。
   */
  function applyDanmakuDefault() {
    var dp = danmakuPlugin();
    if (!dp) return;
    var want = loadDanmakuOnDefault();
    try {
      /*
       * 直接用插件的 show() / hide()：它们会设置弹幕层的 opacity、更新 option.visible
       * 并抛出 artplayerPluginDanmuku:show / :hide 事件（控制条那个「弹」按钮的提示词
       * 就是听这两个事件更新的）。最后 reset() 把配置面板里的开关状态也同步过来。
       *
       * 为什么不走 config({visible})：那是插件构造时用的初始化入口，
       * 运行中改状态它并不保证重新走一遍 show/hide。
       */
      if (want) { if (dp.show) dp.show(); else dp.config({ visible: true }); }
      else { if (dp.hide) dp.hide(); else dp.config({ visible: false }); }
      if (dp.reset) dp.reset();
      /*
       * 控制条上那枚「弹」按钮的"开/关"图标是靠 [data-danmuku-visible] 属性切 CSS 的
       * （插件源码里 `[data-danmuku-visible=false] .apd-toggle-off{display:block}`），
       * 而 show()/hide() 只改弹幕层 opacity 和提示词，属性要我们补一下，
       * 否则会出现"弹幕已经关了、图标还是开着的"。
       */
      var holder = els.player.querySelector('[data-danmuku-visible]');
      if (holder) holder.setAttribute('data-danmuku-visible', want ? 'true' : 'false');
    } catch (e) { /* 插件状态异常时不打断播放 */ }
  }

  /**
   * 把"默认开启字幕"应用到当前视频。
   * 只在当前视频真的有字幕时才切（没有字幕就什么也不做，避免弹一个"暂无字幕"的提示）。
   */
  function applySubtitleDefault() {
    if (!state.subtitleVttUrl) return;
    var want = loadSubtitleOnDefault();
    if (!!state.subtitleOn === want) return;
    state.subtitleOn = want;
    setNativeSubtitleVisible(want);
    updateSubtitleControl();
    // 保险：字幕层/控件可能刚被别的渲染路径重建过，下一帧再同步一次按钮状态
    setTimeout(updateSubtitleControl, 60);
  }

  /**
   * 按设置里的"默认清晰度"在当前 dash 实例上选一档。
   *
   * 为什么要自己挑：dash.js 默认开 ABR（自适应），控制条上的「画质」就永远显示 Auto。
   * 设置里给了三档固定值，打开每个视频时按它选一次，并关掉 ABR，
   * 让这一档稳定地播下去（想换回来在控制条里点「Auto」即可）。
   *
   * 档位怎么定：
   *   - 高：可用档位里分辨率最高的那一档（并列取码率高的）；
   *   - 低：最低那一档；
   *   - 中：**最接近 480P** 的那一档 —— B 站自己把 480P 当默认清晰度，
   *     而各视频的档位不连续（可能只有 1080P / 720P / 360P），"正中间"会随视频变，
   *     取"离 480P 最近"最可预期；并列时取低的那一档（省流量）。
   */
  function pickBitrateIndex(list, pref) {
    if (!list || !list.length) return -1;
    var h = function (it) { return Number(it.height || 0); };
    var br = function (it) { return Number(it.bitrate || 0); };
    var i;
    if (pref === 'high') {
      var hi = 0;
      for (i = 1; i < list.length; i++) {
        if (h(list[i]) > h(list[hi]) || (h(list[i]) === h(list[hi]) && br(list[i]) > br(list[hi]))) hi = i;
      }
      return hi;
    }
    if (pref === 'low') {
      var lo = 0;
      for (i = 1; i < list.length; i++) {
        if (h(list[i]) < h(list[lo]) || (h(list[i]) === h(list[lo]) && br(list[i]) < br(list[lo]))) lo = i;
      }
      return lo;
    }
    var best = 0;
    for (i = 1; i < list.length; i++) {
      var d = Math.abs(h(list[i]) - 480) - Math.abs(h(list[best]) - 480);
      if (d < 0 || (d === 0 && h(list[i]) < h(list[best]))) best = i;
    }
    return best;
  }

  /** 把设置里的默认清晰度应用到当前 dash（auto 就打开 ABR，其余选固定档） */
  function applyDefaultQuality() {
    var art = state.art;
    if (!art || !art.dash || typeof art.dash.getBitrateInfoListFor !== 'function') return;
    var pref = (store && store.get && store.get('defaultQuality')) || 'auto';
    var list = [];
    try { list = art.dash.getBitrateInfoListFor('video') || []; } catch (e) { return; }
    if (!list.length) return;
    var ctl = art.controls && art.controls['dash-quality'];
    var idx = pref === 'auto' ? -1 : pickBitrateIndex(list, pref);
    var value = idx >= 0 ? String(list[idx].qualityIndex) : 'auto';
    /*
     * 优先"点"插件下拉里的那一项：切换画质、更新控件文字、弹一条「画质：720p」提示
     * 全由插件自己完成，我们不用去猜它的 DOM 结构（直接改控件 innerHTML 会把下拉列表删掉）。
     * 下拉条目是 ArtPlayer 渲染时就生成的，不需要先把菜单展开。
     */
    var item = ctl && ctl.querySelector ? ctl.querySelector('.art-selector-item[data-value="' + value + '"]') : null;
    /*
     * 已经就是这个档位：什么都不做（最重要的一条）。
     * MPD 交给 dash.js 之前我们已经按设置给了 initialBitrate，
     * 所以正常情况下这里"本来就对"，不需要任何切换 ——
     * 而初始化阶段切流正是"刚打开视频卡在 0 秒一直加载"的元凶（实测复现过）。
     */
    var target = idx >= 0 ? list[idx] : null;
    var cur = null;
    try { cur = art.dash.getQualityFor('video'); } catch (e) { cur = null; }
    if (target && cur === target.qualityIndex) {
      if (item && item.click) item.click();
      return;
    }
    /*
     * 需要切（说明 initialBitrate 没选中我们想要的那档，或者用户刚在设置里改了）：
     * 不在这里立刻切，而是记下来，等视频真正开始播之后再切 —— 初始化阶段切流
     * 会让首帧一直转圈（要手动拖一下进度条才好）。
     */
    state.pendingQuality = idx >= 0 ? list[idx].qualityIndex : null;
    if (state.pendingQuality != null && state.playing) applyPendingQuality();
  }

  /** 把"待切换的清晰度"真正落实到 dash 上（只在开始播放后调用） */
  function applyPendingQuality() {
    var art = state.art;
    var q = state.pendingQuality;
    if (!art || q == null || !art.dash) return;
    state.pendingQuality = null;
    var ctl = art.controls && art.controls['dash-quality'];
    var item = ctl && ctl.querySelector ? ctl.querySelector('.art-selector-item[data-value="' + q + '"]') : null;
    if (item && item.click) { item.click(); return; }   // 走插件自己的切换逻辑
    try {
      art.dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } });
      art.dash.setQualityFor('video', q);
    } catch (e) { /* ignore */ }
  }

  /**
   * 从 MPD 文本里抠出视频档位（height / bandwidth）。
   * MPD 是我们自己的服务端生成的，视频 Representation 带 mimeType="video/mp4" ✓，
   * 所以这里正则一下就够了 —— 目的是**在交给 dash.js 之前**就知道有哪些档，
   * 好把"默认清晰度"写进 initialBitrate（见 customType.dash）。
   */
  function parseMpdVideoReps(xml) {
    var out = [];
    var re = /<Representation\b[^>]*>/g;
    var m;
    while ((m = re.exec(xml))) {
      var tag = m[0];
      if (tag.indexOf('mimeType="video/mp4"') < 0) continue;
      var h = /height="(\d+)"/.exec(tag);
      var bw = /bandwidth="(\d+)"/.exec(tag);
      if (!h || !bw) continue;
      out.push({ height: Number(h[1]), bandwidth: Number(bw[1]), bitrate: Number(bw[1]) });
    }
    return out;
  }

  /** 按设置算出的"初始码率"：交给 dash.js 之前用，避免初始化阶段切流 */
  function preferredInitialBandwidth(reps) {
    var pref = (store && store.get && store.get('defaultQuality')) || 'auto';
    if (pref === 'auto' || !reps || !reps.length) return 0;
    var idx = pickBitrateIndex(reps, pref);
    return idx >= 0 ? reps[idx].bandwidth : 0;
  }

  /** 读上次用的倍速；值不在档位里（或旧数据）就回到 1.0 */
  function loadPlayRate() {
    var v = Number((store && store.get && store.get('playRate')) || 1);
    return PLAY_RATES.indexOf(v) >= 0 ? v : 1;
  }

  /** 倍速的显示文本：0.5 / 0.75 / 1.0 / 1.25 …（末尾不留多余的 0） */
  function fmtRate(v) {
    return (Math.round(Number(v) * 100) / 100).toFixed(2).replace(/0$/, '');
  }

  /** 控制条上那个按钮的内容：不是在 1.0 倍速时高亮一下，避免"我明明开了倍速却忘了" */
  function rateControlHtml() {
    return '<span class="bilinest-ctl rate' + (state.playRate === 1 ? '' : ' on') + '">' +
      fmtRate(state.playRate) + '×</span>';
  }

  /** 倍速下拉的档位（当前值带勾） */
  function rateItems() {
    return PLAY_RATES.map(function (v) {
      return {
        html: v === 1 ? '正常（1.0×）' : fmtRate(v) + '×',
        value: String(v),
        default: state.playRate === v
      };
    });
  }

  /** 把当前倍速写到 <video> 上（ArtPlayer 会代理到 video.playbackRate） */
  function applyPlayRate() {
    var art = state.art;
    if (!art) return;
    try {
      art.playbackRate = state.playRate;
    } catch (e) {
      /* 个别浏览器在未就绪时会抛错，忽略即可（loadedmetadata 后会再应用一次） */
    }
  }

  /** 设置倍速：立即生效 + 持久化（下次打开还是这个速度）+ 一条提示 */
  function setPlayRate(v) {
    var n = Number(v);
    state.playRate = PLAY_RATES.indexOf(n) >= 0 ? n : 1;
    if (store && store.set) store.set({ playRate: state.playRate });
    applyPlayRate();
    if (state.art && state.art.notice) state.art.notice.show = '倍速 ' + fmtRate(state.playRate) + '×';
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

  /** 改一项字幕设置（字号 / 位置）并立即生效 + 持久化 */
  function setSubSettings(patch) {
    state.subSettings = {
      pos: patch.pos !== undefined ? patch.pos : state.subSettings.pos,
      size: patch.size !== undefined ? patch.size : state.subSettings.size
    };
    saveSubSettings();
    applySubSettings();
  }

  /** 「Aa」下拉里的选项：字号四档 + 位置三档（当前值带勾） */
  function subStyleItems() {
    var s = state.subSettings || { pos: 100, size: 'md' };
    return [
      { html: '字号：小', value: 'size:sm', default: s.size === 'sm' },
      { html: '字号：中', value: 'size:md', default: s.size === 'md' },
      { html: '字号：大', value: 'size:lg', default: s.size === 'lg' },
      { html: '字号：特大', value: 'size:xl', default: s.size === 'xl' },
      { html: '位置：贴底', value: 'pos:0', default: Number(s.pos) === 0 },
      { html: '位置：中间', value: 'pos:50', default: Number(s.pos) === 50 },
      { html: '位置：最高', value: 'pos:100', default: Number(s.pos) === 100 }
    ];
  }

  /** 字幕位置映射：滑块 0~100 → 距底部 2%~16%，始终位于底部区域做微调 */
  function subPosToBottom(v) {
    var x = Math.min(100, Math.max(0, Number(v) || 0));
    return 2 + (x / 100) * 14;
  }

  /**
   * 取 ArtPlayer 原生字幕 DOM 节点。
   * 注意：v5 里 `art.player` 是播放器 API 对象（不是 DOM），拿它 querySelector 会抛错，
   * 所以只能走模板引用 `art.template.$subtitle`（就是那个 .art-subtitle 层）。
   */
  function nativeSubtitleEl() {
    try {
      var art = state.art;
      if (!art) return null;
      if (art.template && art.template.$subtitle) return art.template.$subtitle;
      var el = document.querySelector('#customPlayer .art-subtitle');
      return el || null;
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
    // 四舍五入可能得到 1000（如 12.9999）→ 会写出 4 位毫秒的非法时间戳，夹一下
    var ms = Math.min(999, Math.round((sec - Math.floor(sec)) * 1000));
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
    if (state.art && state.art.notice) {
      state.art.notice.show = '字幕 ' + (state.subtitleOn ? '开' : '关');
    }
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
      // 章节和字幕是同一份响应里的两件事：顺手一起处理，不额外请求
      var points = (v2 && v2.view_points) || [];
      applyChapters(points.map(function (p) {
        return {
          from: Number(p.from) || 0,
          to: Number(p.to) || 0,
          text: String(p.content || '').trim()
        };
      }));
      var subs = v2 && v2.subtitle && v2.subtitle.subtitles;
      if (subs && subs.length) {
        // B 站的语言码：普通 CC 是 zh-CN / zh-Hans，AI 字幕是 ai-zh —— 两种都算中文
        var pick = subs.find(function (s) { return /^(ai-)?zh/i.test(s.lan); }) || subs[0];
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
        // v5 的签名是 switch(url, options)：第二个参数要传对象，传字符串会被当成选项展开
        if (sub) {
          if (sub.switch) {
            // 不带 name：否则 ArtPlayer 会在加载时弹一句"Switch Subtitle: 字幕"
            // 那种中英混排的提示；开关状态由 toggleSubtitle 自己提示。
            var r = sub.switch(state.subtitleVttUrl, { type: 'vtt' });
            if (r && r.catch) r.catch(function () { /* 失败按"没有字幕"处理，见 updateSubtitleControl */ });
          } else if (sub.load) {
            sub.load(state.subtitleVttUrl, 'vtt');
          }
        }
      } catch (e) { /* ignore */ }
      applySubSettings();             // 应用字号 / 位置样式
      // 默认开关来自设置（设置 → 播放 →「默认开启字幕」；缺省仍是关，由用户手动开）
      state.subtitleOn = loadSubtitleOnDefault();
      setNativeSubtitleVisible(state.subtitleOn);
    }
    updateSubtitleControl();
  }

  /* ---------------- 控件显隐 ---------------- */
  /** 本地视频没有弹幕/字幕/画质，隐藏对应控件 */
  function showBiliControls(show) {
    if (!state.art) return;
    ['danmaku', 'subtitle', 'substyle', 'dash-quality'].forEach(function (name) {
      var el = state.art.controls[name];
      if (el) el.style.display = show ? '' : 'none';
    });
    // 章节按钮的显隐由"有没有章节"决定，但本地视频一律不显示（见 updateChapterControl）
    updateChapterControl();
  }

  /**
   * 播放 / 暂停不弹提示。
   *
   * ArtPlayer 的 play/pause 存取器里会 `notice.show = i18n('Play' | 'Pause')`，
   * 而控制条上本来就有播放/暂停图标，这个提示纯属重复（而且现在提示挪到画面正中了，
   * 一按空格就在画面中间闪一下更碍眼）。这里只把这两句挡掉，其它提示照旧：
   * 做法是给 notice 实例装一个自己的 `show` 存取器，过滤后再转发给原型上的实现。
   */
  function mutePlayPauseNotice(art) {
    try {
      var notice = art.notice;
      if (!notice) return;
      var desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(notice), 'show');
      if (!desc || !desc.get || !desc.set) return;
      Object.defineProperty(notice, 'show', {
        configurable: true,
        get: function () { return desc.get.call(notice); },
        set: function (v) {
          // 播放/暂停：不弹新提示，顺手把可能还挂在画面上的旧提示收掉
          if (typeof v === 'string' && /^(播放|暂停|play|pause)$/i.test(v.trim())) {
            desc.set.call(notice, '');
            return;
          }
          desc.set.call(notice, v);
        }
      });
    } catch (e) {
      /* 拿不到存取器就保持原样：为一句提示影响播放不值得 */
    }
  }

  /* ---------------- 停止 ---------------- */
  function reset() {
    state.playing = false;
    stopStallWatch();
    clearPendingRetry();
    subtitleSeq++; // 使尚未完成的字幕请求失效，避免旧视频字幕覆盖新视频
    danmakuSeq++;  // 同理，使尚未完成的弹幕请求失效
    mpdSeq++;      // 同理，让还没回来的 MPD 请求失效
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
    state.chapters = [];        // 章节随视频走，换视频先清空（否则会短暂显示上一集的刻度）
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
    state.pendingQuality = null;
    if (state.art) {
      try { state.art.pause(); } catch (e) { /* ignore */ }
      if (state.art.mpdBlobUrl) {
        try { URL.revokeObjectURL(state.art.mpdBlobUrl); } catch (e) { /* ignore */ }
        state.art.mpdBlobUrl = null;
      }
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
    // 离开播放页后不要让快捷键继续作用于后台播放器
    if (state.art) state.art.isFocus = false;
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
    /** 应用层提供「章节」按钮的点击处理（负责弹菜单） */
    setChapterHandler: function (fn) { state.chapterHandler = fn; },
    /** 当前视频的章节列表（[{from,to,text}]，没有就是空数组） */
    getChapters: function () { return state.chapters.slice(); },
    /** 跳到指定秒数（章节菜单用） */
    seekTo: function (seconds) {
      var art = state.art;
      if (!art) return;
      var t = Number(seconds);
      if (!isFinite(t) || t < 0) return;
      // 用户主动跳转：把续播标记掉，否则清单里的续播逻辑会再把它拉回上次进度
      state.resumeTarget = 0;
      state.seekedResume = true;
      try { art.currentTime = t; } catch (e) { /* 跳转失败忽略 */ }
      art.play().catch(function () { /* 自动播放可能被浏览器拦截 */ });
    },
    /** 设置里改了"默认清晰度"：正在播的话立刻切过去（详见 applyDefaultQuality） */
    applyDefaultQuality: function () { applyDefaultQuality(); },
    /** 设置里改了"默认显示弹幕"：立刻应用（控制条图标也会同步） */
    applyDanmakuDefault: function () { applyDanmakuDefault(); },
    /** 设置里改了"默认开启字幕"：当前视频有字幕就立刻切 */
    applySubtitleDefault: function () { applySubtitleDefault(); },
    /** 设置里改字幕字号 / 位置：立刻生效并持久化（同一份 subSettings） */
    setSubSettings: function (patch) { setSubSettings(patch || {}); },
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
