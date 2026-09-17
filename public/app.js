/**
 * BiliNest 主逻辑
 * ------------------------------------------------------------
 * 职责：页面渲染、状态管理、收藏夹 / 自定义视频列表、
 *       官方嵌入播放器与本地视频播放、设置与登录、OAuth 回调。
 *
 * 纯净性约定：
 *   - 页面不包含搜索框、推荐、评论区、互动按钮、通知私信入口与广告；
 *   - “已收藏”仅为不可点击的状态标识；
 *   - 全局只有“内容源”一个内容切换入口（另有“设置”负责登录/外观/数据）。
 */
(function () {
  'use strict';

  var store = window.BiliNestStore;
  var api = window.BiliNestAPI;
  var local = window.BiliNestLocal;

  /* ---------------- DOM ---------------- */
  var els = {
    dashboardView: document.getElementById('dashboardView'),
    dashboard: document.getElementById('dashboard'),
    homeView: document.getElementById('homeView'),
    playerView: document.getElementById('playerView'),
    sourceTitle: document.getElementById('sourceTitle'),
    sourceMeta: document.getElementById('sourceMeta'),
    sortSelect: document.getElementById('sortSelect'),
    folderSearch: document.getElementById('folderSearch'),
    grid: document.getElementById('videoGrid'),
    loadMoreWrap: document.getElementById('loadMoreWrap'),
    btnLoadMore: document.getElementById('btnLoadMore'),
    browseView: document.getElementById('browseView'),
    browseTitle: document.getElementById('browseTitle'),
    browseSearch: document.getElementById('browseSearch'),
    browseGrid: document.getElementById('browseGrid'),
    browseSort: document.getElementById('browseSort'),
    browsePager: document.getElementById('browsePager'),
    browsePageInfo: document.getElementById('browsePageInfo'),
    btnBrowsePrev: document.getElementById('btnBrowsePrev'),
    btnBrowseNext: document.getElementById('btnBrowseNext'),
    btnBrowseBack: document.getElementById('btnBrowseBack'),
    btnSource: document.getElementById('btnSource'),
    btnSettings: document.getElementById('btnSettings'),
    btnTheme: document.getElementById('btnTheme'),
    btnHome: document.getElementById('btnHome'),
    btnBackHome: document.getElementById('btnBackHome'),
    btnBack: document.getElementById('btnBack'),
    biliFrame: document.getElementById('biliFrame'),
    playerShell: document.getElementById('playerShell'),
    playerLayout: document.getElementById('playerLayout'),
    customPlayer: document.getElementById('customPlayer'),
    playerTitle: document.getElementById('playerTitle'),
    playerUp: document.getElementById('playerUp'),
    favBadge: document.getElementById('favBadge'),
    episodePanel: document.getElementById('episodePanel'),
    episodeList: document.getElementById('episodeList'),
    fileInput: document.getElementById('fileInput'),
    dirInput: document.getElementById('dirInput'),
    modalRoot: document.getElementById('modalRoot'),
    toastRoot: document.getElementById('toastRoot'),
    backendBanner: document.getElementById('backendBanner'),
    btnRetryBackend: document.getElementById('btnRetryBackend')
  };

  /* ---------------- 内存状态 ---------------- */
  var state = {
    backend: null,          // api.init() 的结果
    folders: [],            // 收藏夹列表缓存
    foldersFetchedAt: 0,
    videoPages: new Map(),  // folderId:pn -> { medias, hasMore, at }
    videos: [],             // 当前展示的视频（已加载）
    activeFolder: null,
    pn: 1,
    hasMore: false,
    activeVideo: null,      // 当前正在播放的视频条目
    activeEpisode: null,    // { bvid, cid, page }
    episodes: [],
    currentView: 'dashboard',
    dashQuery: '',          // 首页“视频库”搜索关键字
    tabQuery: {},           // 自定义标签页各自的搜索关键字 { tabId: query }
    pendingTabId: '',       // 从某个自定义标签页进入收藏夹视图时的目标标签页
    folderQuery: '',        // 收藏夹视图内搜索关键字
    sourceQuery: '',        // 内容源弹窗搜索关键字
    sourceSearchTimer: null, // 内容源搜索防抖定时器
    folderSearchSeq: 0,      // 内容源收藏夹内搜索的批次号（用于丢弃过期结果）
    folderSearchMatches: [], // 内容源收藏夹内搜索匹配项
    browse: null,           // 二级浏览页状态 { kind, title, items, sort, page, perPage, query }
    loading: false,
    prevView: 'dashboard',   // 播放前的视图（用于返回）
    progressCtx: null,       // 观看进度上下文
    seriesInfo: null,        // 当前播放视频的列表（剧集）信息
    jumpToBvid: null,        // 从内容源搜索跳转到收藏夹后要定位高亮的视频
    jumpBusy: false          // 防止定位翻页循环重入
  };

  var videoInfoCache = new Map(); // bvid -> { at, data }
  var qrPollTimer = null;         // 扫码登录轮询定时器
  var progressLastSave = 0;       // 观看进度上次保存时间

  /* ---------------- 工具函数 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtCount(n) {
    n = parseInt(n, 10) || 0;
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    return String(n);
  }

  /** 统一头像 URL：// → https:，http:// → https: */
  function fixAvatar(url) {
    if (!url) return '';
    if (url.indexOf('//') === 0) return 'https:' + url;
    return url.replace(/^http:\/\//i, 'https://');
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var mm = String(m).padStart(h ? 2 : 1, '0');
    var ss = String(s).padStart(2, '0');
    return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  function fmtDate(ts) {
    if (!ts) return '';
    try {
      // 单位注意：B 站接口给的 fav_time 是「秒」，而本地添加视频存的是 Date.now()（毫秒）。
      // 统一按秒处理，毫秒值先换算，否则卡片上会显示成"添加于 58667年"。
      var n = Number(ts);
      if (n > 1e12) n = Math.round(n / 1000);
      return new Date(n * 1000).toLocaleDateString('zh-CN', {
        year: 'numeric', month: 'short', day: 'numeric'
      });
    } catch (e) {
      return '';
    }
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    var n = Number(bytes);
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function toast(msg, type, duration) {
    type = type || 'info';
    duration = typeof duration === 'number' ? duration : 3200;
    var el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    els.toastRoot.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 250);
    }, duration);
  }

  function creds() {
    return { cookie: store.getCookie() || '', sid: store.get('sid') || '' };
  }

  /* ---------------- 主题 ---------------- */
  function applyTheme() {
    var t = store.get('theme') || 'auto';
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }

  function effectiveTheme() {
    var t = store.get('theme') || 'auto';
    if (t === 'dark') return 'dark';
    if (t === 'light') return 'light';
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  /* ---------------- 登录 ---------------- */
  async function checkLogin(showError) {
    var c = creds();
    if (!c.cookie && !c.sid) {
      store.set({ login: null }, false);
      return null;
    }
    try {
      // Cookie 方式用 Web 端 nav 校验（稳定返回 mid/uname）；
      // OAuth 会话用 APP 端 myinfo（通过 access_key 鉴权）。
      var data = c.cookie ? await api.nav(c) : await api.myinfo(c);
      if (!data || data.isLogin === false) throw new Error('未登录');
      var mid = data.mid;
      if (!mid) throw new Error('未登录');
      store.set({ login: { mid: mid, uname: data.uname || 'B站用户' } }, false);
      return store.get('login');
    } catch (e) {
      store.set({ login: null }, false);
      if (showError) toast('登录校验失败：' + e.message, 'error');
      return null;
    }
  }

  /* ---------------- 主页（仪表盘）渲染 ---------------- */
  /**
   * 学习时长统计。
   * 数据存在 store 的 watchStats 里：{ daily: {'YYYY-MM-DD': 秒}, byKey: {'进度键': 秒} }，
   * 和别的数据一样走 store.set → localStorage + 服务端备份，不额外落盘。
   *
   * 记录口径是"**实际观看**"：播放器每次上报进度时，比较「时钟增量」与「播放位置增量」，
   * 两者接近才计入 —— 拖进度条、暂停、切集都会让两者差很多，直接丢弃。
   */
  var watchSample = { t: 0, at: 0 };

  function dayKeyOf(ts) {
    var d = new Date(ts || Date.now());
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());   // 本地日期
  }

  function statsData() {
    var s = store.get('watchStats') || {};
    return { daily: s.daily || {}, byKey: s.byKey || {} };
  }

  /** 只保留最近 keep 个键（键按日期 / 加入顺序排），避免数据无限增长 */
  function capKeys(obj, keep) {
    var keys = Object.keys(obj);
    if (keys.length <= keep) return obj;
    keys.sort();
    var out = {};
    for (var i = keys.length - keep; i < keys.length; i++) out[keys[i]] = obj[keys[i]];
    return out;
  }

  /** 记一笔"实际观看"秒数 */
  function trackWatchTime(seconds, key) {
    if (!(seconds > 0.2)) return;
    var s = statsData();
    var day = dayKeyOf();
    var daily = Object.assign({}, s.daily);
    var byKey = Object.assign({}, s.byKey);
    // 保留一位小数：播放事件大约每 250ms 一次，单次增量只有 0.25 秒 ——
    // 每次写入都四舍五入成整数的话，会**永远累加不起来**（每次都归零）。
    var round1 = function (n) { return Math.round(n * 10) / 10; };
    daily[day] = round1((daily[day] || 0) + seconds);
    if (key) byKey[key] = round1((byKey[key] || 0) + seconds);
    store.set({ watchStats: { daily: capKeys(daily, 400), byKey: capKeys(byKey, 300) } });
  }

  /** 播放器上报进度时调用（见 bindEvents 里的 bilinest-timeupdate） */
  function sampleWatchTime() {
    var video = window.BiliNestPlayer && BiliNestPlayer.getVideo && BiliNestPlayer.getVideo();
    if (!video) { watchSample = { t: 0, at: 0 }; return; }
    var t = video.currentTime || 0;
    var now = Date.now();
    var dt = (now - watchSample.at) / 1000;
    var dv = t - watchSample.t;
    var inPlayer = state.currentView === 'player' && els.playerView && !els.playerView.hidden;
    if (watchSample.at && inPlayer && dt > 0 && dt < 12 && dv > 0 && Math.abs(dv - dt) < 1.5) {
      trackWatchTime(dv, state.progressCtx && state.progressCtx.key);
    }
    watchSample = { t: t, at: now };
  }

  /** 日期 key → 序号（按天算，雨天/夏令时都不会算错） */
  function dayOrdinal(key) {
    var p = String(key).split('-');
    return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000;
  }

  /** 最长连续打卡：有记录的日子里最长的一段"一天不落" */
  function bestStreakOf(activeDays) {
    var best = 0;
    var run = 0;
    var prev = null;
    for (var i = 0; i < activeDays.length; i++) {
      var ord = dayOrdinal(activeDays[i]);
      if (!isFinite(ord)) continue;
      run = (prev !== null && ord - prev === 1) ? run + 1 : 1;
      if (run > best) best = run;
      prev = ord;
    }
    return best;
  }

  /** 汇总：累计 / 近 7 天 / 最长连续 / 日均 / 最多的一天 */
  function studySummary() {
    var daily = statsData().daily;
    var activeDays = Object.keys(daily).filter(function (d) { return daily[d] > 0; }).sort();
    var totalSec = activeDays.reduce(function (a, d) { return a + daily[d]; }, 0);
    var sumRange = function (n) {
      var t = 0;
      for (var i = 0; i < n; i++) t += daily[dayKeyOf(Date.now() - i * 86400000)] || 0;
      return t;
    };
    // 当前连续（今天没学就从昨天算起）——留着给以后可能用到的"今日已打卡"提示
    var streak = 0;
    var offset = daily[dayKeyOf()] ? 0 : 1;
    while (streak < 400 && daily[dayKeyOf(Date.now() - (offset + streak) * 86400000)]) streak++;
    var maxDaySec = activeDays.reduce(function (a, d) { return Math.max(a, daily[d]); }, 0);
    return {
      daily: daily,
      totalSec: totalSec,
      weekSec: sumRange(7),
      streak: streak,
      bestStreak: bestStreakOf(activeDays),
      activeDays: activeDays.length,
      avgSec: activeDays.length ? Math.round(totalSec / activeDays.length) : 0,
      maxDaySec: maxDaySec,
      firstDay: activeDays[0] || ''
    };
  }

  function fmtWatch(sec) {
    sec = Math.round(sec || 0);
    if (sec < 60) return sec + ' 秒';
    var h = Math.floor(sec / 3600);
    var m = Math.round((sec % 3600) / 60);
    if (!h) return m + ' 分钟';
    if (!m) return h + ' 小时';
    return h + ' 小时 ' + m + ' 分';
  }

  /**
   * 继续学习大标题旁的入口。
   * 这里**一律显示分钟**（不折算成小时）——「240 分钟」比「4 小时」更有成就感；
   * 小时只在面板内部规规矩矩地显示。数字放大但用次级色，不与「继续学习」抢视线。
   */
  function studyEntryHtml() {
    var sum = studySummary();
    var mins = Math.round(sum.totalSec / 60);
    // 一点记录都还没有时整个入口都不出现 —— 标题行保持和学习统计上线前一模一样，
    // 不显示"0 分钟"（读起来像被扣分，也平白多出一块东西）。
    // 累计不足 1 分钟时同样按住不表，等真的学了再露面。
    if (!mins) return '';
    return '<button type="button" class="study-entry" data-study-open title="查看学习记录">' +
      '<span class="study-entry-label">一共学了</span>' +
      '<span class="study-entry-num">' + mins + '</span>' +
      '<span class="study-entry-label">分钟</span>' +
      '<span class="study-entry-go">学习记录 ›</span>' +
    '</button>';
  }

  /**
    * 打卡日历的窗口：**固定 N 周 × 7 天（N 列）× 7 行**，形状永远不变。
    * 按 GitHub 贡献图的读法：一列 = 一周（周一在最上），一天往下走；时间往右推进。
    *  - 开始记录那天所在的那一周，摆在**第一列**；
    *  - 等今天走到第 N 列（也就是满 N 周）之后，窗口开始跟着今天滑动，
    *    此后最后一列恒为本周，周日（未来）那几格留空 —— 和 GitHub 一样。
    * 所以新用户看到的是"我从哪一周开始"，老用户看到的是最近 N 周。
    */
  function calendarWindow(daily, weeks) {
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var cap = weeks * 7;
    var dow = (today.getDay() + 6) % 7;                        // 周一 = 0
    var thisWeek = today.getTime() - dow * 86400000;           // 本周周一
    var start = new Date(thisWeek - (weeks - 1) * 7 * 86400000);
    var anchored = false;
    var keys = Object.keys(daily || {}).filter(function (k) { return daily[k] > 0; }).sort();
    if (keys.length) {
      var first = new Date(keys[0] + 'T00:00:00');
      if (!isNaN(first.getTime())) {
        var firstWeek = first.getTime() - ((first.getDay() + 6) % 7) * 86400000;
        // 还没满 N 周：把"开始记录那一周"钉在第一列
        if (thisWeek - firstWeek < (weeks - 1) * 7 * 86400000) {
          start = new Date(firstWeek);
          anchored = true;
        }
      }
    }
    return {
      today: today,
      days: cap,
      anchored: anchored,
      start: start
    };
  }

  /**
    * 打卡日历：一格一天，方格铺满一整块。
    * 按 GitHub 贡献图的读法：**一列 = 一周（周一在最上），一天往下走**，时间往右推进。
    * 左边一列小字标出周一 / 周四 / 周日，方便对上"哪一行是周末"。
   */
  function studyCalendarHtml(daily, weeks) {
    var win = calendarWindow(daily, weeks);
    var today = win.today;
    var start = win.start;
    var max = 0;
    Object.keys(daily).forEach(function (k) { if (daily[k] > max) max = daily[k]; });
    var cells = '';
    for (var i = 0; i < win.days; i++) {
      var ts = start.getTime() + i * 86400000;
      var key = dayKeyOf(ts);
      var sec = daily[key] || 0;
      var lv = 0;
      if (sec > 0 && max > 0) {
        var r = sec / max;
        lv = r < 0.25 ? 1 : r < 0.5 ? 2 : r < 0.75 ? 3 : 4;
      }
      var d = new Date(ts);
      var day = (d.getMonth() + 1) + '月' + d.getDate() + '日';
      // 还没到的日子只报日期，不说"没有学习"
      var tip = ts > today.getTime() ? day : day + ' · ' + (sec > 0 ? fmtWatch(sec) : '没有学习');
      cells += '<span class="cal-cell' + (ts === today.getTime() ? ' today' : '') +
        '" data-lv="' + lv + '" title="' + esc(tip) + '"></span>';
    }
    return '<div class="study-cal-wrap">' +
        '<div class="cal-wd" aria-hidden="true"><span style="grid-row:1">一</span><span style="grid-row:4">四</span><span style="grid-row:7">日</span></div>' +
        '<div class="study-cal">' + cells + '</div>' +
      '</div>' +
      '<div class="cal-legend"><span>少</span>' +
        '<span class="cal-cell" data-lv="0"></span><span class="cal-cell" data-lv="1"></span>' +
        '<span class="cal-cell" data-lv="2"></span><span class="cal-cell" data-lv="3"></span>' +
        '<span class="cal-cell" data-lv="4"></span><span>多</span></div>';
  }

  /** 看得最多的内容：按累计时长排序 */
  function studyTopContent(limit) {
    var byKey = statsData().byKey;
    var lib = store.get('customVideos') || [];
    var hist = store.get('watchHistory') || [];
    var nameOf = function (key) {
      var head = String(key).split(':')[0];
      var v = lib.find(function (x) { return String(x.bvid || x.id) === head; }) ||
              hist.find(function (x) { return String(x.bvid || x.key) === head; });
      return (v && (v.title || v.name)) || head;
    };
    return Object.keys(byKey)
      .map(function (k) { return { key: k, name: nameOf(k), sec: byKey[k] }; })
      .sort(function (a, b) { return b.sec - a.sec; })
      .slice(0, limit || 5);
  }

  /* ---------------- 学习统计：右侧面板 ---------------- */

  var studyPage = 'brief';    // brief = 简版卡片，detail = 详细数据
  var studyRange = 14;        // 详细页的统计窗口（天）

  /** 用 uPlot 画一组柱状图（内联数据、canvas，不引图表库之外的依赖） */
  function drawBars(host, labels, values, opts) {
    if (!host || !window.uPlot) return;
    opts = opts || {};
    // 同一个 host 会被重复绘制（切 7 / 14 / 30 天）：先把上一张销毁、清空，
    // 否则 uPlot 会一层层往上叠，叠起来看着就是"图有点糊 / 图不见了"。
    if (host._uplot) {
      try { host._uplot.destroy(); } catch (e) { /* ignore */ }
      host._uplot = null;
    }
    host.innerHTML = '';
    host.classList.add('chart-host');
    // 悬浮读数：鼠标在图上走的时候给一行"日期 · 时长"，图上本身一动不动
    var tip = document.createElement('span');
    tip.className = 'chart-tip';
    tip.hidden = true;
    host.appendChild(tip);
    var cs = getComputedStyle(document.body);
    var accent = cs.getPropertyValue('--accent').trim() || '#0071e3';
    var green = cs.getPropertyValue('--tab-green').trim() || '#30a46c';
    var text2 = cs.getPropertyValue('--text-2').trim() || '#8e8e93';
    var grid = 'rgba(120,120,128,.16)';
    var color = opts.tone === 'green' ? green : accent;
    var maxV = Math.max(1, Math.max.apply(null, values));
    var width = host.clientWidth || 360;
    var barPaths = uPlot.paths.bars({ size: [0.6, 16] });
    var data = [labels.map(function (_, i) { return i; }), values];
    var series = [
      { value: function (u, v) { return labels[v] == null ? '' : labels[v]; } },
      {
        stroke: color,
        fill: /^#[0-9a-f]{6}$/i.test(color) ? color + '22' : 'rgba(0,113,227,.12)',
        paths: barPaths,
        points: { show: false },
        value: function (u, v) { return v == null ? '' : v + ' 分钟'; }
      }
    ];
    // 最后一根柱子是"今天"：其它柱子是淡填充 + 描边，今天这根填实，一眼能认出来
    var todayIdx = opts.highlightLast && values.length ? values.length - 1 : -1;
    if (todayIdx >= 0 && values[todayIdx] != null) {
      data.push(values.map(function (v, i) { return i === todayIdx ? v : null; }));
      series.push({
        stroke: color,
        fill: color,
        paths: barPaths,
        points: { show: false },
        value: function () { return ''; }
      });
    }
    host._uplot = new uPlot({
      width: width,
      height: opts.height || 160,
      padding: [12, 8, 0, 0],
      legend: { show: false },
      // 只保留一条竖着的悬浮线；把"左键拖动 = 框选缩放"关掉 ——
      // 这个小面板里的图是给人看的趋势图，拖一下就缩进一小段（甚至缩成空图），
      // 更像是把图弄坏了，而不是在交互。
      cursor: { y: false, drag: { setScale: false, x: false, y: false } },
      hooks: {
        setCursor: [function (u) {
          var i = u.cursor.idx;
          if (i == null || values[i] == null) { tip.hidden = true; return; }
          tip.hidden = false;
          tip.textContent = (i === todayIdx ? '今天 ' : '') + (labels[i] || '') + ' · ' + values[i] + ' 分钟';
        }]
      },
      // 横轴两端各留半格：不留的话最右边那根柱子（今天）会被画到画布外面，
      // 连同它下面 "9/17" 的刻度文字一起被切掉一半。
      scales: {
        x: { time: false, range: function (u, min, max) { return [min - 0.5, max + 0.5]; } },
        y: { range: [0, maxV * 1.2] }
      },
      series: series,
      axes: [
        { stroke: text2, font: '11px system-ui, sans-serif', size: 26, grid: { show: false }, ticks: { show: false },
          // 刻度从"今天"往回数：这样最右边那根柱子（今天）永远带日期，
          // 不用指望 uPlot 自动挑出来的"整数档"刚好落在最后一天上。
          splits: function () {
            var n = labels.length;
            var step = Math.max(1, Math.ceil((n - 1) / 5));
            var out = [];
            for (var i = n - 1; i >= 0; i -= step) out.unshift(i);
            return out;
          },
          values: function (u, ticks) { return ticks.map(function (t) { return labels[t] || ''; }); } },
        { stroke: text2, font: '11px system-ui, sans-serif', size: 34, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } }
      ]
    }, data, host);
  }

  function drawStudyCharts(range) {
    var daily = statsData().daily;
    var labels = [];
    var values = [];
    for (var i = range - 1; i >= 0; i--) {
      var d = new Date(Date.now() - i * 86400000);
      labels.push((d.getMonth() + 1) + '/' + d.getDate());
      values.push(Math.round((daily[dayKeyOf(d.getTime())] || 0) / 60));
    }
    drawBars(document.getElementById('studyDaily'), labels, values, { height: 170, highlightLast: true });

    // 一周里的规律：按星期几取平均（只算有记录的天）
    var sum = [0, 0, 0, 0, 0, 0, 0];
    var cnt = [0, 0, 0, 0, 0, 0, 0];
    Object.keys(daily).forEach(function (k) {
      var t = new Date(k + 'T00:00:00');
      if (isNaN(t.getTime())) return;
      var idx = (t.getDay() + 6) % 7;
      sum[idx] += daily[k];
      cnt[idx] += 1;
    });
    drawBars(
      document.getElementById('studyWeekday'),
      ['一', '二', '三', '四', '五', '六', '日'],
      sum.map(function (s, i) { return cnt[i] ? Math.round(s / cnt[i] / 60) : 0; }),
      { height: 150, tone: 'green' }
    );
  }

  function renderStudyTop() {
    var host = document.getElementById('studyTop');
    if (!host) return;
    var list = studyTopContent(5);
    if (!list.length) {
      host.innerHTML = '<p class="muted small">还没有足够的数据。</p>';
      return;
    }
    var max = list[0].sec || 1;
    host.innerHTML = list.map(function (it) {
      var pct = Math.max(3, Math.round((it.sec / max) * 100));
      return '<div class="top-row" title="' + esc(it.name) + '">' +
        '<span class="top-name">' + esc(it.name) + '</span>' +
        '<span class="top-bar"><i style="width:' + pct + '%"></i></span>' +
        '<span class="top-val">' + fmtWatch(it.sec) + '</span>' +
      '</div>';
    }).join('');
  }

  function studySheetHtml() {
    var sum = studySummary();
    var head = function (title, back) {
      return '<div class="sheet-head">' +
        (back ? '<button type="button" class="icon-btn" data-study-back aria-label="返回">‹</button>' : '') +
        '<h2>' + title + '</h2>' +
        '<button type="button" class="icon-btn" data-close aria-label="关闭">×</button>' +
      '</div>';
    };
    if (studyPage === 'detail') {
      var emptyHint = sum.totalSec > 0 ? ''
        : '<p class="muted small">还没有数据 —— 看几个视频，这里就会出现曲线（只统计真正播放的时间，拖进度条不算）。</p>';
      return head('学习记录', true) +
        '<div class="sheet-body">' +
          emptyHint +
          '<div class="seg study-range">' + [7, 14, 30].map(function (n) {
            return '<button type="button" data-study-range="' + n + '"' + (n === studyRange ? ' class="on"' : '') + '>' + n + ' 天</button>';
          }).join('') + '</div>' +
          '<h3 class="study-sub">每日学习时长</h3>' +
          '<div class="study-chart" id="studyDaily"></div>' +
          '<h3 class="study-sub">一周里的规律 <span class="muted small">按星期几的平均值</span></h3>' +
          '<div class="study-chart" id="studyWeekday"></div>' +
          '<h3 class="study-sub">学得最多的内容</h3>' +
          '<div class="study-top" id="studyTop"></div>' +
        '</div>';
    }
    // 简版：累计大数字 + 三个小数字 + 打卡日历 + 查看更多
    var calWin = calendarWindow(sum.daily, 12);
    var big = sum.totalSec >= 3600
      ? Math.floor(sum.totalSec / 3600) + '<small>小时</small>' + Math.round((sum.totalSec % 3600) / 60) + '<small>分</small>'
      : (sum.totalSec >= 60 ? Math.round(sum.totalSec / 60) + '<small>分钟</small>' : '0<small>分钟</small>');
    var sub = sum.activeDays
      ? '从 ' + sum.firstDay + ' 开始记录 · 共 ' + sum.activeDays + ' 天有学习'
      : '看一个视频就开始统计（只算真正播放的时间，拖进度条不算）';
    return head('学习记录', false) +
      '<div class="sheet-body">' +
        '<div class="study-hero">' +
          '<div class="study-hero-num">' + big + '</div>' +
          '<div class="study-hero-label">累计学习时长</div>' +
          '<div class="study-hero-sub">' + esc(sub) + '</div>' +
        '</div>' +
        '<div class="study-mini">' +
          '<div><b>' + sum.bestStreak + '</b><span>最长连续（天）</span></div>' +
          '<div><b>' + Math.round(sum.avgSec / 60) + '</b><span>日均（分钟）</span></div>' +
          '<div><b>' + Math.round(sum.maxDaySec / 60) + '</b><span>最多一天（分钟）</span></div>' +
        '</div>' +
        '<h3 class="study-sub">打卡日历 <span class="muted small">' +
          esc(calWin.anchored
            ? (calWin.start.getMonth() + 1) + '/' + calWin.start.getDate() + ' 起'
            : '近 12 周') +
        '</span></h3>' +
        studyCalendarHtml(sum.daily, 12) +
        '<button type="button" class="btn primary study-more" data-study-detail>查看更多</button>' +
      '</div>';
  }

  /** 面板里的关闭按钮要重新绑定（innerHTML 换过） */
  function bindSheetButtons() {
    var modal = els.modalRoot.querySelector('.modal.study-sheet');
    if (!modal) return;
    var closes = modal.querySelectorAll('[data-close]');
    for (var i = 0; i < closes.length; i++) closes[i].addEventListener('click', closeModal);
    var detail = modal.querySelector('[data-study-detail]');
    if (detail) detail.addEventListener('click', function () { studyPage = 'detail'; renderStudySheet(); });
    var back = modal.querySelector('[data-study-back]');
    if (back) back.addEventListener('click', function () { studyPage = 'brief'; renderStudySheet(); });
    var ranges = modal.querySelectorAll('[data-study-range]');
    for (var j = 0; j < ranges.length; j++) {
      ranges[j].addEventListener('click', function () {
        studyRange = Number(this.dataset.studyRange) || 14;
        var all = modal.querySelectorAll('[data-study-range]');
        for (var k = 0; k < all.length; k++) all[k].classList.toggle('on', all[k] === this);
        drawStudyCharts(studyRange);
      });
    }
    if (studyPage === 'detail') {
      drawStudyCharts(studyRange);
      renderStudyTop();
    }
  }

  function renderStudySheet() {
    var modal = els.modalRoot.querySelector('.modal.study-sheet');
    if (!modal) return;
    modal.innerHTML = studySheetHtml();
    bindSheetButtons();
  }

  function openStudySheet() {
    studyPage = 'brief';
    studyRange = 14;
    // 右侧滑出：复用弹窗的遮罩与退场逻辑（退场沿同一条路径回去，见 §7 空间一致性）
    openModal(studySheetHtml(), { cls: 'study-sheet' });
    bindClose();
    bindSheetButtons();
  }

  async function loadDashboard() {
    showView('dashboard');
    state.episodes = [];
    renderDashboard();
  }

  /* ---------------- 主页标签页（系统标签 + 自定义标签） ---------------- */
  var SYSTEM_TABS = [
    { key: 'continue', label: '继续学习' },
    { key: 'added', label: '视频库' },
    { key: 'folders', label: '收藏夹库' },
    { key: 'ups', label: '学习 UP主' }
  ];

  function customTabs() {
    return store.get('customTabs') || [];
  }

  function findCustomTab(key) {
    return customTabs().find(function (t) { return String(t.id) === String(key); }) || null;
  }

  /** 系统标签 + 自定义标签（自定义按创建顺序追加在最后） */
  function dashTabs() {
    return SYSTEM_TABS.concat(customTabs().map(function (t) {
      return { key: t.id, label: t.name, custom: true };
    }));
  }

  /** 把任意 key 归一为合法标签；自定义标签已删除或值非法时回落「继续学习」 */
  function normalizeDashTab(key) {
    if (findCustomTab(key)) return key;
    for (var i = 0; i < SYSTEM_TABS.length; i++) {
      if (SYSTEM_TABS[i].key === key) return key;
    }
    return 'continue';
  }

  /** 排序下拉的选项（视频库 / 展开全部页共用同一套语义） */
  function sortOptionsHtml() {
    var cur = store.get('sort') || 'add';
    return [['add', '添加时间'], ['pub', '发布时间'], ['star', '星级'], ['play', '播放量']]
      .map(function (o) {
        return '<option value="' + o[0] + '"' + (cur === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      })
      .join('');
  }

  /** 当前页的搜索关键字（视频库用全局的，自定义标签页各记各的） */
  function dashQueryOf(tab, custom) {
    return (custom ? state.tabQuery[custom.id] : state.dashQuery) || '';
  }

  /** 搜索命中数；没有关键字时返回 -1（调用方据此显示"共 N 个"还是"N / 总数"） */
  function dashSearchMatched(tab, custom) {
    var q = dashQueryOf(tab, custom).trim().toLowerCase();
    if (!q) return -1;
    var hit = function (text) { return String(text || '').toLowerCase().indexOf(q) >= 0; };
    if (custom) {
      var m = tabMembers(custom);
      return m.videos.filter(function (v) { return hit(v.title || v.name) || hit((v.upper && v.upper.name) || v.upper); }).length +
        m.folders.filter(function (f) { return hit(f.title || f.name); }).length +
        m.ups.filter(function (u) { return hit(u.name) || hit(u.sign); }).length;
    }
    return (store.get('customVideos') || []).filter(function (v) {
      return hit(v.title || v.name) || hit((v.upper && v.upper.name) || v.upper);
    }).length;
  }

  /** 大标题下面那句说明：搜索时变成"N / 总数"，让结果数就在标题下面 */
  function dashHeadSubText(tab, custom) {
    var matched = dashSearchMatched(tab, custom);
    if (custom) {
      var m = tabMembers(custom);
      var total = m.videos.length + m.folders.length + m.ups.length;
      if (matched >= 0) return matched + ' / ' + total + ' 项';
      return total ? '共 ' + total + ' 项内容' : '还没有内容';
    }
    if (tab === 'continue') return '自动从上次进度续播';
    if (tab === 'added') {
      var n = (store.get('customVideos') || []).length;
      if (matched >= 0) return matched + ' / ' + n + ' 个视频';
      return n ? '共 ' + n + ' 个视频' : '还没有添加视频';
    }
    if (tab === 'folders') {
      var f = (store.get('studyFolders') || []).length;
      return f ? '共 ' + f + ' 个收藏夹' : '把收藏夹加进来单独管理';
    }
    if (tab === 'ups') {
      var u = (store.get('studyUps') || []).length;
      return u ? '共 ' + u + ' 位 UP主' : '输入 UID 添加要跟的 UP主';
    }
    return '';
  }

  /**
   * 主页的"大标题"区（Apple 的 large title）：标题 + 一句说明 + 这一页的工具。
   * 以前这些分散在各栏目的 section-head 里——标题只有 21px、说明挤在右边、搜索框还独占一行，
   * 一屏上没有任何一处告诉用户"我在哪一页"。现在收成一处；栏目内部只留真正的分组标题
   * （自定义标签页里的 视频 / 收藏夹库 / UP主）。
   * 标题在滚动时走掉、标签栏留在顶部，和 iOS 的大标题行为一致。
   */
  function renderDashHead(tab, custom) {
    var title = '';
    if (custom) {
      title = custom.name;
    } else {
      for (var i = 0; i < SYSTEM_TABS.length; i++) {
        if (SYSTEM_TABS[i].key === tab) title = SYSTEM_TABS[i].label;
      }
    }
    var sub = '';
    var tools = '';
    var searchPlaceholder = '';
    var searchValue = '';

    if (custom) {
      searchPlaceholder = '在本标签页内搜索…';
      searchValue = state.tabQuery[custom.id] || '';
    } else if (tab === 'continue') {
      // 「继续学习」标题行右侧：累计学习时长 + 学习记录入口。
      // 做成入口而不是独立标签页 —— 它是附属功能，不该和「视频库 / 收藏夹库」抢位置。
      tools += studyEntryHtml();
    } else if (tab === 'added') {
      searchPlaceholder = '在视频库中搜索…';
      searchValue = state.dashQuery;
      tools +=
        '<label class="sort-wrap"><span class="muted small">排序</span>' +
          '<select id="dashSort" class="select">' + sortOptionsHtml() + '</select></label>';
    }
    sub = dashHeadSubText(tab, custom);

    var searchHtml = searchPlaceholder
      ? '<div class="dash-search-wrap">' +
          '<span class="search-icon" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.6-3.6"></path></svg>' +
          '</span>' +
          '<input id="dashSearch" class="search-input" type="search" placeholder="' + searchPlaceholder +
          '" autocomplete="off" value="' + esc(searchValue) + '">' +
        '</div>'
      : '';

    var toolsHtml = (searchHtml || tools) ? '<div class="dash-page-tools">' + searchHtml + tools + '</div>' : '';
    return (
      '<div class="dash-page-head">' +
        '<div class="dash-page-title">' +
          '<h1 class="page-title">' + esc(title) + '</h1>' +
          (sub ? '<p class="dash-page-sub">' + esc(sub) + '</p>' : '') +
        '</div>' +
        toolsHtml +
      '</div>'
    );
  }

  function renderDashboard() {
    var tab = normalizeDashTab(state.activeDashTab);
    state.activeDashTab = tab;
    var custom = findCustomTab(tab);
    var tabs = dashTabs();

    var hasAny =
      (store.get('watchHistory') || []).length ||
      (store.get('customVideos') || []).length ||
      (store.get('studyFolders') || []).length ||
      (store.get('studyUps') || []).length;
    if (!hasAny) {
      pendingTabsScroll = null;   // 空状态没有标签栏，别把位置留给下一次
      els.dashboard.innerHTML =
        '<div class="empty" style="padding:90px 20px">' +
          '<p class="empty-title">还没有学习内容</p>' +
          '<p>点击右上角「内容源」：把收藏夹加入收藏夹库、粘贴单个视频链接，或选择本地视频。</p>' +
          '<div class="row">' +
            '<button type="button" id="btnEmptyAction" class="btn primary">打开内容源</button>' +
            '<button type="button" id="btnEmptyAddUp" class="btn ghost">添加 UP主</button>' +
          '</div>' +
        '</div>';
      return;
    }

    // 标签栏：系统标签（固定）+ 分隔线 + 滚动区（自定义标签，可拖动排序）+ 新建按钮
    // 新建按钮放在滚动区末尾并用 sticky right:0 —— 不溢出时它就跟在最后一个标签后面，
    // 只有内容溢出、横向滚动时才钉在右侧保持可达。
    var sysHtml = '';
    var custHtml = '';
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      var btnHtml =
        '<button type="button" class="dash-tab' + (tab === t.key ? ' active' : '') + (t.custom ? ' custom' : '') + '"' +
          ' data-dash-tab="' + esc(t.key) + '"' +
          (t.custom
            ? ' data-tab-custom="' + esc(t.key) + '" title="双击重命名，按住可拖动排序"'
            : '') + '>' +
          '<span class="dash-tab-label">' + esc(t.label) + '</span>' +
          (t.custom ? '<span class="dash-tab-more" data-tab-menu="' + esc(t.key) + '" title="标签页操作">⋯</span>' : '') +
        '</button>';
      if (t.custom) custHtml += btnHtml;
      else sysHtml += btnHtml;
    }
    var tabsHtml =
      '<div class="dash-tabs">' +
        sysHtml +
        (custHtml ? '<span class="dash-tabs-sep" aria-hidden="true"></span>' : '') +
        '<div class="dash-tabs-scroll">' +
          custHtml +
          '<button type="button" class="dash-tab dash-tab-new" data-tab-new="1" title="新建标签页">＋</button>' +
        '</div>' +
        // 活动标签的滑动指示条：把它作为"当前在哪一页"的可见证据，而不是让每个标签
        // 各画一条下划线、切换时硬切（Apple：状态变化要看得见去向）
        '<span class="dash-tab-ind" aria-hidden="true"></span>' +
      '</div>';

    // 页面头部（Apple 的"大标题"）：一个大标题 + 一句说明，右侧放这一页的工具
    // （搜索 / 排序 / 展开全部）。标题在滚动时会走掉、标签栏留在顶部 —— 和 iOS 一样。
    var headHtml = renderDashHead(tab, custom);

    // 当前标签内容
    var contentHtml = '<div id="dashContent">';
    if (tab === 'continue') contentHtml += renderContinueSection();
    else if (tab === 'added') contentHtml += renderAddedVideosSection();
    else if (tab === 'folders') contentHtml += renderStudyFoldersSection();
    else if (tab === 'ups') contentHtml += renderStudyUpsSection();
    else if (custom) contentHtml += renderCustomTab(custom);
    contentHtml += '</div>';

    // 重建前记下标签栏的横向位置。下面的 innerHTML 会把滚动容器的 scrollLeft 清零，
    // 不记住的话，每次切换标签看起来都是"从最左边重新滚过来"，而不是从上一个标签滑到新的。
    var prevSc = els.dashboard.querySelector('.dash-tabs-scroll');
    pendingTabsScroll = prevSc ? prevSc.scrollLeft : null;

    // 首屏入场动画只播一次：切标签、输入搜索都会重跑这里，每次都播就成了闪屏。
    // 动画结束后摘掉 .first-paint —— 否则 animation 的 fill 会盖住卡片自己的
    // hover / :active transform（CSS 动画优先级高于普通声明）。
    if (!state.dashboardPainted) {
      state.dashboardPainted = true;
      els.dashboard.classList.add('first-paint');
      els.dashboard.addEventListener('animationend', function () {
        els.dashboard.classList.remove('first-paint');
      }, { once: true });
    }

    els.dashboard.innerHTML = headHtml + tabsHtml + contentHtml;
    fitPosterTitles(els.dashboard);   // 没封面图的卡片：量一遍标题能不能当海报放

    // 封面加载失败时隐藏图片
    var imgs = els.dashboard.querySelectorAll('img');
    for (var j = 0; j < imgs.length; j++) {
      imgs[j].addEventListener('error', function () {
        this.style.display = 'none';
      });
    }
    syncTabsScroll();
  }

  /** 标签栏横向滚动的状态同步：左侧渐隐提示 + 保证当前自定义标签在可视区内 */
  function syncTabsScroll() {
    var sc = els.dashboard.querySelector('.dash-tabs-scroll');
    if (!sc) return;
    // 先把横向位置瞬时还原到重建前的位置（这一步必须"瞬时"，平滑就成了从左滑过来），
    // 后面再按需要平滑地把当前选中的标签滚进视野。
    if (pendingTabsScroll !== null) {
      var keep = pendingTabsScroll;
      pendingTabsScroll = null;
      try { sc.scrollTo({ left: keep, behavior: 'instant' }); }
      catch (e) { sc.scrollLeft = keep; }
    }
    if (!sc.dataset.syncBound) {
      sc.dataset.syncBound = '1';
      sc.addEventListener('scroll', function () {
        sc.classList.toggle('scrolled', sc.scrollLeft > 4);
        syncTabIndicator();   // 指示条在滚动区里，横向滚动时要跟着走
        markTabsScrolling();  // 滚动期间关掉指示条的过渡，避免它被"拖在后面"
      });
    }
    sc.classList.toggle('scrolled', sc.scrollLeft > 4);
    sc.classList.toggle('overflowing', sc.scrollWidth > sc.clientWidth);
    syncTabIndicator();
    var active = sc.querySelector('.dash-tab.active');
    if (!active) return;
    var newBtn = sc.querySelector('.dash-tab-new');
    var reserve = newBtn ? newBtn.getBoundingClientRect().width : 0;
    var sr = sc.getBoundingClientRect();
    var ar = active.getBoundingClientRect();
    // 自己算滚动量：scrollIntoView 不知道右侧贴住的「＋」会盖住内容
    var rightLimit = sr.right - reserve;
    if (ar.left < sr.left) sc.scrollLeft -= (sr.left - ar.left) + 8;
    else if (ar.right > rightLimit) sc.scrollLeft += (ar.right - rightLimit) + 8;
  }

  /* 标签栏横向滚动位置：重建后要瞬时还原，见 syncTabsScroll */
  var pendingTabsScroll = null;
  var tabsScrollTimer = null;

  /**
   * 滚动进行中给标签栏加 .scrolling，稍后移除。
   * 指示条本身有 200ms 过渡；滚动时目标每帧都在变，过渡会让它滞后于标签
   * （手跟不跟手就是这种细节决定的）。滚动期间关掉过渡即可 1:1 跟随。
   */
  function markTabsScrolling() {
    var bar = els.dashboard.querySelector('.dash-tabs');
    if (!bar) return;
    bar.classList.add('scrolling');
    clearTimeout(tabsScrollTimer);
    tabsScrollTimer = setTimeout(function () {
      var b = els.dashboard.querySelector('.dash-tabs');
      if (b) b.classList.remove('scrolling');
    }, 140);
  }

  /**
   * 把滑动指示条对齐到当前标签。
   * 用 getBoundingClientRect 而不是 offsetLeft：rect 是视口坐标，天然包含
   * 「自定义标签横向滚动」的位移，不用自己再减 scrollLeft。
   * 宽高走 scaleX，所以整条只动 transform（合成器层），切标签时是"滑过去"
   * 而不是两端各自淡出淡入。
   */
  /* 上一次指示条的位置。标签栏每次重建都会生成一个新的指示条节点（从
     translateX(0) scaleX(0) 起步），不先把旧位置恢复给它，切标签就会变成
     "从最左端刷一下拉过来"，而不是从上一个标签滑到选中。 */
  var lastIndX = null;
  var lastIndW = 0;
  var lastIndTone = '';

  function syncTabIndicator() {
    var bar = els.dashboard.querySelector('.dash-tabs');
    var ind = els.dashboard.querySelector('.dash-tab-ind');
    if (!bar || !ind) return;
    var active = bar.querySelector('.dash-tab.active');
    if (!active) { ind.classList.remove('ready'); return; }
    var br = bar.getBoundingClientRect();
    var ar = active.getBoundingClientRect();
    var tone = active.classList.contains('custom') ? 'custom' : 'system';
    // 指示条现在是分段控件里那块"胶囊滑块"：只平移 + 改宽度。
    // （不用 scaleX 拉伸，是因为拉伸会把圆角一起拉变形。）
    var x = Math.round(ar.left - br.left);
    var w = Math.round(ar.width);

    if (ind.dataset.synced === '1') {
      // 同一个节点（例如横向滚动中反复调用）：正常补间即可，
      // 滚动期间由 .scrolling 关掉过渡，让指示条 1:1 跟着标签走。
      ind.style.transform = 'translateX(' + x + 'px)';
      ind.style.width = w + 'px';
      ind.dataset.tone = tone;
      lastIndX = x;
      lastIndW = w;
      lastIndTone = tone;
      return;
    }

    // 新节点：先"无过渡"地放到上一次的位置（首次渲染则直接放到目标位置），
    // 强制一次样式计算让浏览器采纳这个起点，再恢复过渡并补间到目标。
    var fromX = lastIndX === null ? x : lastIndX;
    var fromW = lastIndX === null ? w : lastIndW;
    ind.style.transition = 'none';
    ind.style.transform = 'translateX(' + fromX + 'px)';
    ind.style.width = fromW + 'px';
    ind.dataset.tone = lastIndTone || tone;
    ind.classList.add('ready');
    void ind.offsetWidth;
    ind.style.transition = '';
    ind.dataset.synced = '1';

    ind.style.transform = 'translateX(' + x + 'px)';
    ind.style.width = w + 'px';
    ind.dataset.tone = tone;
    lastIndX = x;
    lastIndW = w;
    lastIndTone = tone;
  }

  /* ---------------- 自定义标签页：按住拖动排序 ----------------
   *
   * 这里刻意不用 HTML5 原生拖放（draggable + dragstart/dragover/drop）：
   * 原生拖放的"拖影"由浏览器生成，被拖的标签本身全程不动，用户在拖的过程中
   * 看不到任何反馈（标签栏又是 sticky 玻璃层，拖影还可能把整层重新栅格化），
   * 表现出来就是"拖了但像卡死"。
   *
   * 改成指针事件 + transform：
   *   · 被拖的标签跟着指针走，并"抬起来"（白底 + 投影）；
   *   · 其余标签实时让位 —— 直接改 transform，由 CSS 过渡补间，所以是滑过去而不是跳过去；
   *   · 松手交给 moveCustomTab()：它以"当前 DOM 位置（含拖动位移）"为 FLIP 起点，
   *     重排后再补间到最终位置，于是落位也是一次连续运动。
   * 拖动过程中不改动任何数据、不重排 DOM，所以重排成本与拖动时长无关。
   */
  var TAB_DRAG_THRESHOLD = 5;      // 超过这个横向位移才认定是拖动；否则仍是一次点击
  var TAB_DRAG_EDGE = 44;          // 指针进入滚动区边缘这么多像素内 → 自动滚动
  var TAB_DRAG_SCROLL_STEP = 12;   // 自动滚动速度（px/帧）
  var TAB_LONG_PRESS = 320;        // 触摸端：长按多久开始拖动（否则留给横向滚动）

  var tabPending = null;           // 已按下、还没越过拖动阈值
  var tabDrag = null;              // 正在拖动
  var tabLongPressTimer = null;
  var tabAutoScrollRaf = 0;
  var tabSettleTimer = 0;          // 让位/回位的过渡结束后再对齐指示条（见 finishTabDrag）
  /**
   * 拖动刚结束的时间戳（0 表示没有需要吞掉的 click）。
   * 指针捕获（setPointerCapture）会把 pointerup 的 target 变成被拖的标签，于是浏览器
   * 补发的那次 click 也落在它身上 —— 结果"拖到别处松手"会顺手把被拖的标签选中。
   * 只吞"真的挪过"的这次 click：只抖了几像素仍然算点击（跟 Apple 的 ~10px 迟滞一致）。
   */
  var tabDragEndedAt = 0;

  function onTabPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var btn = e.target.closest('.dash-tab.custom[data-tab-custom]');
    if (!btn || e.target.closest('.dash-tab-more') || e.target.closest('.dash-tab-input')) return;
    tabPending = {
      id: btn.dataset.tabCustom,
      el: btn,
      x: e.clientX,
      y: e.clientY,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      sc: btn.closest('.dash-tabs-scroll')
    };
    if (e.pointerType === 'touch') {
      // 触摸：先让位给"横向滚动标签栏"，长按不动才进入拖动排序
      clearTimeout(tabLongPressTimer);
      tabLongPressTimer = setTimeout(function () {
        if (!tabPending || tabPending.pointerId !== e.pointerId) return;
        beginTabDrag(null);
      }, TAB_LONG_PRESS);
    }
  }

  function onTabPointerMove(e) {
    if (tabPending && e.pointerId === tabPending.pointerId) {
      var mdx = e.clientX - tabPending.x;
      var mdy = e.clientY - tabPending.y;
      if (tabPending.pointerType === 'touch') {
        // 触摸一移动就是"滚标签栏"，取消长按判定
        if (Math.abs(mdx) > 8 || Math.abs(mdy) > 8) {
          clearTimeout(tabLongPressTimer);
          tabPending = null;
        }
      } else if (Math.abs(mdx) >= TAB_DRAG_THRESHOLD && Math.abs(mdx) > Math.abs(mdy)) {
        beginTabDrag(e);
      }
    }
    if (!tabDrag || e.pointerId !== tabDrag.pointerId) return;
    tabDrag.pointerX = e.clientX;
    tabDrag.pointerY = e.clientY;
    applyTabDragLayout();
    tickTabAutoScroll();
  }

  function onTabPointerUp(e) {
    if (tabPending && e.pointerId === tabPending.pointerId) {
      clearTimeout(tabLongPressTimer);
      tabPending = null;
    }
    if (!tabDrag || e.pointerId !== tabDrag.pointerId) return;
    finishTabDrag(true);
  }

  function onTabDragKey(e) {
    if (e.key !== 'Escape' || !tabDrag) return;
    e.preventDefault();
    finishTabDrag(false);
  }

  /** 开始拖动：把每个自定义标签的初始位置量下来（后面全靠这几个数，不再读布局） */
  function beginTabDrag(ev) {
    var pending = tabPending;
    if (!pending || tabDrag) return;
    clearTimeout(tabSettleTimer);
    var nodes = els.dashboard.querySelectorAll('.dash-tab.custom');
    if (nodes.length < 2) { tabPending = null; return; }
    var items = [];
    var self = null;
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i].getBoundingClientRect();
      var it = { id: String(nodes[i].dataset.tabCustom), el: nodes[i], left: r.left, width: r.width, applied: 0 };
      items.push(it);
      if (it.id === String(pending.id)) self = it;
    }
    if (!self) { tabPending = null; return; }
    tabPending = null;
    tabDrag = {
      id: self.id,
      el: self.el,
      selfWidth: self.width,
      selfLeft: self.left,
      appliedSelf: 0,
      pointerId: pending.pointerId,
      startX: pending.x,
      startY: pending.y,
      pointerX: ev ? ev.clientX : pending.x,
      pointerY: ev ? ev.clientY : pending.y,
      items: items,
      sc: pending.sc,
      scrollStart: pending.sc ? pending.sc.scrollLeft : 0,
      prevScrollBehavior: pending.sc ? pending.sc.style.scrollBehavior : '',
      // 拖动用的 translateX 会算进滚动容器的可滚动宽度（浏览器的规则），
      // 于是"能滚多远"在拖动中被撑大，自动滚动会一路跑到不存在的位置上。
      // 记下按下那一刻的最大滚动量，拖动期间都以它为准。
      maxScroll: pending.sc ? Math.max(0, pending.sc.scrollWidth - pending.sc.clientWidth) : 0,
      target: -1
    };
    if (pending.pointerType === 'touch') self.el.style.touchAction = 'none';
    self.el.classList.add('dragging');
    var bar = els.dashboard.querySelector('.dash-tabs');
    if (bar) bar.classList.add('tabs-sorting');
    document.body.classList.add('tab-sorting');
    // 拖动期间自己按帧滚动，smooth 会把 scrollLeft 变成"目标值"，自己算的量就失效了
    if (pending.sc) pending.sc.style.scrollBehavior = 'auto';
    try { self.el.setPointerCapture(pending.pointerId); } catch (err) { /* 忽略 */ }
    applyTabDragLayout();
  }

  /**
   * 按当前指针位置摆放所有标签。
   * 全部是纯计算 + 两次 style 写入，不读取布局、不改 DOM，所以每帧成本恒定。
   * 坐标统一换算回"按下的那一刻"：拖动期间自动滚动会让视口坐标整体偏移 scrollDelta。
   */
  function applyTabDragLayout() {
    var d = tabDrag;
    if (!d) return;
    var scrollDelta = d.sc ? (d.sc.scrollLeft - d.scrollStart) : 0;
    var x = d.pointerX + scrollDelta;

    var rest = [];
    for (var i = 0; i < d.items.length; i++) {
      if (d.items[i].id !== d.id) rest.push(d.items[i]);
    }
    // 插入位：数一数"起点在中点左边"的标签有几个。
    // 用按下那一刻的位置来比，而不是用让位后的位置 —— 后者依赖各标签的宽度，
    // 被拖的标签一旦比右邻宽，指针还停在原地就会立刻被判定成"要往右挪一格"。
    // 用原始位置比则天然稳定：不动就不换位，越过谁的中间才和谁换。
    var k = 0;
    for (var a = 0; a < rest.length; a++) {
      if (x > rest[a].left + rest[a].width / 2) k++;
    }
    d.target = k;

    // 插入位之后的标签整体后移一个"被拖标签的宽度"
    var cursor = d.items[0].left;
    for (var b = 0; b < rest.length; b++) {
      var it = rest[b];
      var dx = Math.round(cursor + (b >= k ? d.selfWidth : 0) - it.left);
      if (it.applied !== dx) {
        it.applied = dx;
        it.el.style.transform = dx ? 'translateX(' + dx + 'px)' : '';
      }
      cursor += it.width;
    }

    var selfDx = Math.round(x - d.startX);
    if (d.appliedSelf !== selfDx) {
      d.appliedSelf = selfDx;
      // 只写平移：必须严格 1:1 跟手。抬起（放大 3%）交给 .dragging 里的 scale 属性，
      // 它是独立于 transform 的，可以带过渡而不影响跟手。
      d.el.style.transform = 'translateX(' + selfDx + 'px)';
    }
  }

  /**
   * 靠近滚动区边缘时自动滚动（否则拖不到看不见的标签）。
   * 只有指针确实停在边缘、且容器确实溢出时才起 rAF；离开边缘或滚到尽头立即停，
   * 不做无意义的每帧空转。
   */
  function tickTabAutoScroll() {
    var d = tabDrag;
    if (!d || !d.sc || tabAutoScrollRaf) return;
    if (!tabDragEdgeDir(d)) { stopTabAutoScroll(); return; }
    tabAutoScrollRaf = requestAnimationFrame(function step() {
      tabAutoScrollRaf = 0;
      var cur = tabDrag;
      var dir = cur ? tabDragEdgeDir(cur) : 0;
      if (!dir) return;
      var before = cur.sc.scrollLeft;
      var next = Math.max(0, Math.min(cur.maxScroll, before + dir * TAB_DRAG_SCROLL_STEP));
      if (next === before) return;   // 已经到边界，停止
      cur.sc.scrollLeft = next;
      applyTabDragLayout();
      tabAutoScrollRaf = requestAnimationFrame(step);
    });
  }

  function tabDragEdgeDir(d) {
    if (!d.sc || d.sc.scrollWidth <= d.sc.clientWidth) return 0;
    var r = d.sc.getBoundingClientRect();
    if (d.pointerX - r.left < TAB_DRAG_EDGE) return d.sc.scrollLeft > 0 ? -1 : 0;
    if (r.right - d.pointerX < TAB_DRAG_EDGE) return d.sc.scrollLeft < d.maxScroll ? 1 : 0;
    return 0;
  }

  function stopTabAutoScroll() {
    if (tabAutoScrollRaf) cancelAnimationFrame(tabAutoScrollRaf);
    tabAutoScrollRaf = 0;
  }

  /** 结束拖动。commit=false 表示取消（Esc），标签滑回原位 */
  function finishTabDrag(commit) {
    var d = tabDrag;
    if (!d) return;
    tabDrag = null;
    stopTabAutoScroll();
    try { d.el.releasePointerCapture(d.pointerId); } catch (err) { /* 忽略 */ }
    d.el.classList.remove('dragging');
    d.el.style.touchAction = '';
    document.body.classList.remove('tab-sorting');
    if (d.sc) d.sc.style.scrollBehavior = d.prevScrollBehavior || '';

    var rest = [];
    for (var i = 0; i < d.items.length; i++) {
      if (d.items[i].id !== d.id) rest.push(d.items[i]);
    }
    var k = Math.max(0, Math.min(d.target < 0 ? d.items.length - 1 : d.target, rest.length));
    var oldOrder = d.items.map(function (it) { return it.id; }).join('|');
    var newOrder = rest.map(function (it) { return it.id; });
    newOrder.splice(k, 0, d.id);
    var changed = newOrder.join('|') !== oldOrder;

    // 真的挪过（换位了，或者指针带着标签走了 8px 以上）→ 吞掉接下来的那次 click
    tabDragEndedAt = (changed || Math.abs(d.appliedSelf) > 8) ? Date.now() : 0;

    if (commit && changed) {
      // moveCustomTab 会把"当前 DOM 位置（含拖动位移）"记成 FLIP 起点，重排后补间到最终位置
      moveCustomTab(d.id, k < rest.length ? rest[k].id : '', false);
      return;
    }

    // 取消 / 位置没变：让标签平滑回位
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var dur = reduce ? 0 : 220;
    for (var j = 0; j < d.items.length; j++) {
      var el = d.items[j].el;
      if (!el.isConnected) continue;
      if (dur) {
        el.style.transition = 'transform ' + dur + 'ms cubic-bezier(0.23, 1, 0.32, 1)';
        (function (node) {
          setTimeout(function () { node.style.transition = ''; }, dur + 80);
        })(el);
      }
      el.style.transform = '';
    }
    /*
     * 指示条不能现在就量：标签此时还在"让位"的位置上（回位是一次 220ms 过渡），
     * getBoundingClientRect 读到的还是偏移后的位置，量出来指示条就会整体歪掉、
     * 而且此后没有任何时机再纠正它 —— 表现就是"拖到分割线松手，滑块停错地方"。
     * 所以保持 .tabs-sorting（指示条先藏着），等过渡结束再对齐 + 显示。
     */
    var settle = function () {
      if (tabDrag) return;   // 已经开始下一轮拖动了，别插手
      var bar = els.dashboard.querySelector('.dash-tabs');
      if (bar) bar.classList.remove('tabs-sorting');
      syncTabIndicator();
    };
    clearTimeout(tabSettleTimer);
    if (dur) tabSettleTimer = setTimeout(settle, dur + 40);
    else settle();
  }
  /* ---------------- 自定义标签页：成员解析与渲染 ---------------- */

  /**
   * 把 tab.items 解析成库内实体。
   * 只存引用：条目在库中被删除后，这里的引用会自然失效并被跳过（渲染自愈）。
   */
  function tabMembers(tab) {
    var out = { videos: [], folders: [], ups: [] };
    var videos = store.get('customVideos') || [];
    var folders = store.get('studyFolders') || [];
    var ups = store.get('studyUps') || [];
    (tab.items || []).forEach(function (it) {
      var id = String(it.id);
      if (it.kind === 'video') {
        var v = videos.find(function (x) { return String(x.id || x.bvid) === id; });
        if (v) out.videos.push(v);
      } else if (it.kind === 'folder') {
        var f = folders.find(function (x) { return String(x.id) === id; });
        if (f) out.folders.push(f);
      } else if (it.kind === 'up') {
        var u = ups.find(function (x) { return String(x.mid) === id; });
        if (u) out.ups.push(u);
      }
    });
    return out;
  }

  function memberKey(kind, id) {
    return kind + ':' + String(id);
  }

  function tabHasItem(tab, kind, id) {
    var k = memberKey(kind, id);
    return (tab.items || []).some(function (it) { return memberKey(it.kind, it.id) === k; });
  }

  function renderCustomTab(tab) {
    var q = (state.tabQuery[tab.id] || '').trim().toLowerCase();
    var m = tabMembers(tab);
    var total = m.videos.length + m.folders.length + m.ups.length;

    var hit = function (text) { return !q || String(text || '').toLowerCase().indexOf(q) >= 0; };
    var videos = m.videos.filter(function (v) {
      return hit(v.title || v.name) || hit((v.upper && v.upper.name) || v.upper);
    });
    var folders = m.folders.filter(function (f) { return hit(f.title || f.name); });
    var ups = m.ups.filter(function (u) { return hit(u.name) || hit(u.sign); });
    var matched = videos.length + folders.length + ups.length;

    var ctx = { tab: tab.id };
    var html =
      '<div class="dash-section">' +
        '<button type="button" class="tab-add-card" data-tab-add="' + esc(tab.id) + '">' +
          '<span class="tab-add-icon">＋</span>' +
          '<span class="tab-add-text">添加内容</span>' +
        '</button>';

    if (!total) {
      html += '<div class="empty-inline">这个标签页还是空的 —— 点上方「添加内容」，从收藏夹 / 视频库 / 学习 UP主 里挑。</div>';
    } else if (!matched) {
      html += '<div class="empty-inline">没有匹配「' + esc(q) + '」的内容。</div>';
    } else {
      if (videos.length) {
        html += '<h3 class="tab-group-title">视频 <span class="muted small">' + videos.length + '</span></h3>' +
          '<div class="grid">' + videos.map(function (v) { return videoCard(v, ctx); }).join('') + '</div>';
      }
      if (folders.length) {
        html += '<h3 class="tab-group-title">收藏夹库 <span class="muted small">' + folders.length + '</span></h3>' +
          '<div class="grid folder-grid">' + folders.map(function (f) { return folderCard(f, ctx); }).join('') + '</div>';
      }
      if (ups.length) {
        html += '<h3 class="tab-group-title">学习 UP主 <span class="muted small">' + ups.length + '</span></h3>' +
          '<div class="up-grid">' + ups.map(function (u) { return studyUpCard(u, ctx); }).join('') + '</div>';
      }
    }
    html += '</div>';
    return html;
  }

  /** 栏一：继续学习（有观看记录时出现，大封面 + 进度条强调） */
  function renderContinueSection() {
    var list = mergedHistoryList();
    if (!list.length) {
      return (
        '<section class="dash-section">' +
          '<div class="empty-inline">还没有观看记录 —— 播放任意视频后会出现在这里，并从上次的位置继续。</div>' +
        '</section>'
      );
    }
    var LIMIT = 12;
    var visible = list.slice(0, LIMIT);
    return (
      '<section class="dash-section">' +
        '<div class="bar-grid">' + visible.map(historyCard).join('') + '</div>' +
        // "展开全部"统一放在网格下方（和视频库 / 收藏夹库一致），
        // 标题行只留搜索与排序这类真正的"页级工具"
        (list.length > LIMIT ? '<div class="bar-more-wrap">' + barMoreBtn('continue', list.length) + '</div>' : '') +
      '</section>'
    );
  }

  /**
   * 观看记录按“整季一个进度”合并：
   * 分组键优先“系列标题”（同一合集即使 season_id 不一致也能归并），
   * 其次 seriesKey、bvid、key；每组只取“最新且可续播”的一条生成卡片，
   * 其余记录保留在数据里但不参与渲染（用户要求）。
   */
  function mergedHistoryList() {
    var hidden = store.get('hiddenHistoryKeys') || [];
    var all = store.get('watchHistory') || [];

    // 分组键：系列标题优先（同一合集即使 season_id 不一致也归并），其次 seriesKey、bvid、key
    function groupKeyOf(h) {
      if (h.seriesTitle) return 't:' + h.seriesTitle;
      if (h.seriesKey) return h.seriesKey;
      if (h.bvid) return 'b:' + h.bvid;
      return h.key;
    }

    // 建立 bvid -> 分组键 的映射（含整季记录分集映射里的所有集），
    // 让旧版“无系列信息的单集记录”也能归并到所属系列
    var bvidToGk = new Map();
    all.forEach(function (h) {
      if (!h.seriesKey && !h.seriesTitle) return;
      var gk = groupKeyOf(h);
      bvidToGk.set(String(h.bvid), gk);
      if (h.episodes) {
        Object.keys(h.episodes).forEach(function (pk) {
          var ci = pk.indexOf(':');
          if (ci > 0) bvidToGk.set(pk.slice(0, ci), gk);
        });
      }
    });

    // 是否可渲染为卡片：系列看“实际可续播集”的进度，单条看 progress 阈值
    function showable(h) {
      if (h.seriesKey) {
        var s = seriesResume(h.seriesKey);
        return !!(s && s.progress >= 10);
      }
      return h.progress >= 10 && (!h.duration || h.progress < h.duration - 10);
    }

    // 组内挑选“最新且可续播”的一条（可显示的优先，其次 watchedAt 最新）
    var best = new Map();
    all.forEach(function (h) {
      var gk = groupKeyOf(h);
      // 无系列信息的孤儿记录：bvid 命中已知系列 → 归并到该系列组
      if (h.bvid && !h.seriesKey && !h.seriesTitle && bvidToGk.has(String(h.bvid))) {
        gk = bvidToGk.get(String(h.bvid));
      }
      var oldMk = h.seriesKey || (h.bvid ? 'b:' + h.bvid : h.key);
      if (hidden.indexOf(gk) >= 0 || hidden.indexOf(oldMk) >= 0) return; // 用户手动删除过的卡片不再渲染
      var cur = best.get(gk);
      var hGood = showable(h);
      var curGood = cur ? showable(cur) : false;
      if (!cur || (hGood && !curGood) || (hGood === curGood && (h.watchedAt || 0) > (cur.watchedAt || 0))) {
        best.set(gk, h);
      }
    });

    var list = [];
    best.forEach(function (h) {
      if (!showable(h)) return;
      if (h.seriesKey) {
        // 系列：用“实际可续播集”的信息渲染卡片
        var s = seriesResume(h.seriesKey);
        if (!s) return;
        var ep = (h.episodes && h.episodes[s.bvid + ':' + s.cid]) || null;
        list.push(Object.assign({}, h, {
          bvid: s.bvid,
          cid: s.cid,
          page: s.page || h.page || 1,
          progress: s.progress,
          duration: (ep && ep.duration) || h.duration || 0,
          title: s.title || h.title,
          episodeLabel: (ep && ep.title) || h.episodeLabel || ''
        }));
      } else {
        list.push(h);
      }
    });
    list.sort(function (a, b) { return (b.watchedAt || 0) - (a.watchedAt || 0); });
    return list;
  }

  /** 栏位“展开全部”按钮 */
  function barMoreBtn(kind, total) {
    return (
      '<button type="button" class="btn ghost small bar-more" data-browse="' + esc(kind) + '">' +
        '展开全部（' + total + '）' +
      '</button>'
    );
  }

  function historyCard(h) {
    var cover = (h.cover || '').replace(/^http:\/\//i, 'https://');
    var pct = h.duration ? Math.min(100, Math.round((h.progress / h.duration) * 100)) : 0;
    var isSeries = !!h.seriesKey;
    // 库里改过名的，观看记录里跟着显示新名字（见 renameLibraryEntry）
    var title = h.customTitle || (isSeries ? (h.seriesTitle || h.title) : h.title);
    var meta = '';
    if (isSeries && h.episodeCount) meta = '共 ' + h.episodeCount + ' 集 · ';
    if (isSeries && h.episodeLabel) meta += h.episodeLabel + ' · ';
    meta += fmtDuration(h.progress) + ' / ' + fmtDuration(h.duration);
    return (
      '<article class="hcard" data-history="' + esc(h.key) + '" title="' + esc(title) + '">' +
        '<button type="button" class="hcard-remove" data-history-remove="' + esc(h.key) + '" title="删除此卡片" aria-label="删除">✕</button>' +
        '<div class="hcard-cover">' +
          (cover ? '<img src="' + esc(cover) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '') +
          '<span class="hcard-label">' + (isSeries ? '继续学习 · 剧集' : '继续学习') + '</span>' +
        '</div>' +
        '<div class="hcard-body">' +
          '<h3>' + esc(title) + '</h3>' +
          '<div class="progress"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
          '<span class="muted">' + esc(meta) + '</span>' +
        '</div>' +
      '</article>'
    );
  }

  /** 栏二：视频库（按星级 / 添加时间等排序） */
  function renderAddedVideosSection() {
    var items = (store.get('customVideos') || []).slice();
    if (!items.length) {
      return (
        '<section class="dash-section">' +
          '<div class="empty-inline">视频库还是空的 —— 在「内容源」里粘贴视频链接，或把收藏夹里的视频加进来。</div>' +
        '</section>'
      );
    }
    var q = (state.dashQuery || '').trim().toLowerCase();
    if (q) {
      items = items.filter(function (v) {
        var title = (v.title || v.name || '').toLowerCase();
        var up = ((v.upper && v.upper.name) || v.upper || '').toLowerCase();
        return title.indexOf(q) >= 0 || up.indexOf(q) >= 0;
      });
    }
    sortVideosInPlace(items, store.get('sort') || 'add');
    var LIMIT = 20;
    var visible = items.slice(0, LIMIT);
    var body;
    if (!items.length) {
      body = '<div class="empty-inline">没有找到匹配的视频，换个关键词试试。</div>';
    } else {
      body =
        '<div class="grid">' + visible.map(videoCard).join('') + '</div>' +
        (items.length > LIMIT ? '<div class="bar-more-wrap">' + barMoreBtn('added', items.length) + '</div>' : '');
    }
    return (
      '<section class="dash-section">' +
        body +
      '</section>'
    );
  }

  /** 栏三：收藏夹库 */
  function renderStudyFoldersSection() {
    var folders = (store.get('studyFolders') || []).slice();
    folders.sort(function (a, b) {
      return ((b.stars || 0) - (a.stars || 0)) || ((b.addedAt || 0) - (a.addedAt || 0));
    });
    var body;
    if (!folders.length) {
      body =
        '<div class="empty-inline"><b>收藏夹库</b>还是空的 —— 在「内容源」的收藏夹列表中点击「加入学习」即可显示在这里。<br>' +
        '也可以先在「内容源」里直接观看某个收藏夹的视频。</div>';
    } else {
      var LIMIT = 12;
      var visible = folders.slice(0, LIMIT);
      body =
        '<div class="grid folder-grid">' + visible.map(folderCard).join('') + '</div>' +
        (folders.length > LIMIT ? '<div class="bar-more-wrap">' + barMoreBtn('folders', folders.length) + '</div>' : '');
    }
    return '<section class="dash-section">' + body + '</section>';
  }

  function folderCard(f, ctx) {
    var cover = (f.cover || '').replace(/^http:\/\//i, 'https://');
    // ctx.tab 存在时表示卡片渲染在自定义标签页内：✕ 只把成员移出本页，不动库
    // 收藏夹卡片不参与改名，保持原来的 ✕（从收藏夹库移除 / 从本页移除）
    var removeBtn = ctx && ctx.tab
      ? '<button type="button" class="card-remove" data-tab-remove="' + esc(f.id) + '" data-tab-id="' + esc(ctx.tab) + '" data-tab-kind="folder" title="从本标签页移除（不会移出收藏夹库）" aria-label="从本标签页移除">✕</button>'
      : '<button type="button" class="card-remove" data-card-remove="' + esc(f.id) + '" title="从收藏夹库移除" aria-label="移除">✕</button>';
    return (
      '<article class="card folder-card" data-folder="' + esc(f.id) + '" title="' + esc(f.title) + '">' +
        (cover
          ? '<div class="card-cover"><img src="' + esc(cover) + '" alt="" loading="lazy" referrerpolicy="no-referrer"></div>'
          : '<div class="card-cover ph ph--poster" style="--h:' + coverHue(f.title) + '">' + posterTitleHtml(f.title) + '</div>') +
        '<div class="card-body">' +
          (cover
            ? '<h3 class="card-title">' + esc(f.title) + '</h3>'
            : '<h3 class="card-title card-title--data">收藏夹</h3>') +
          '<div class="card-meta">' +
            '<span class="muted">' + (f.mediaCount != null ? f.mediaCount + ' 个视频' : '收藏夹') + '</span>' +
            starControl(f.id, f.stars || 0, 'folder') +
          '</div>' +
          '<div class="card-foot">' +
            removeBtn +
          '</div>' +
        '</div>' +
      '</article>'
    );
  }

  /* ---------------- 二级浏览页（栏位展开：翻页 / 排序 / 搜索） ---------------- */
  var BROWSE_META = {
    continue: {
      title: '继续学习',
      sortOptions: [['recent', '最近观看']],
      perPage: 12
    },
    added: {
      title: '视频库',
      sortOptions: [['add', '添加时间'], ['pub', '发布时间'], ['star', '星级'], ['play', '播放量']],
      perPage: 12
    },
    folders: {
      title: '收藏夹库',
      sortOptions: [['star', '星级'], ['add', '添加时间']],
      perPage: 12
    }
  };

  function openBrowse(kind, presetQuery) {
    var meta = BROWSE_META[kind];
    if (!meta) return;
    state.prevView = state.currentView;
    var items = [];
    if (kind === 'continue') items = mergedHistoryList();
    else if (kind === 'added') items = (store.get('customVideos') || []).slice();
    else if (kind === 'folders') items = (store.get('studyFolders') || []).slice();
    var defaultSort = kind === 'added' ? (store.get('sort') || 'add') : kind === 'folders' ? 'star' : 'recent';
    state.browse = {
      kind: kind,
      items: items,
      sort: defaultSort,
      page: 1,
      perPage: meta.perPage,
      query: presetQuery || ''
    };
    els.browseTitle.textContent = meta.title;
    els.browseSort.innerHTML = meta.sortOptions
      .map(function (o) {
        return '<option value="' + o[0] + '">' + o[1] + '</option>';
      })
      .join('');
    els.browseSort.value = state.browse.sort;
    els.browseSearch.value = state.browse.query;
    renderBrowse();
    showView('browse');
  }

  /** 二级浏览页：过滤 + 排序后的完整列表 */
  function browseItems() {
    var b = state.browse;
    if (!b) return [];
    var items = b.items.slice();
    var q = (b.query || '').trim().toLowerCase();
    if (q) {
      items = items.filter(function (it) {
        var title = '';
        var up = '';
        if (b.kind === 'folders') {
          title = it.title || it.name || '';
        } else {
          title = it.title || it.name || it.seriesTitle || '';
          up = ((it.upper && it.upper.name) || it.upper || '');
        }
        return title.toLowerCase().indexOf(q) >= 0 || up.toLowerCase().indexOf(q) >= 0;
      });
    }
    if (b.kind === 'continue') {
      items.sort(function (a, c) { return (c.watchedAt || 0) - (a.watchedAt || 0); });
    } else if (b.kind === 'folders') {
      items.sort(function (a, c) {
        return b.sort === 'add'
          ? ((c.addedAt || 0) - (a.addedAt || 0))
          : (((c.stars || 0) - (a.stars || 0)) || ((c.addedAt || 0) - (a.addedAt || 0)));
      });
    } else {
      sortVideosInPlace(items, b.sort);
    }
    return items;
  }

  function renderBrowse() {
    var b = state.browse;
    if (!b) return;
    var items = browseItems();
    var per = b.perPage || 12;
    var pages = Math.max(1, Math.ceil(items.length / per));
    if (b.page > pages) b.page = pages;
    var slice = items.slice((b.page - 1) * per, b.page * per);

    if (!items.length) {
      els.browseGrid.innerHTML = '<div class="empty"><p class="empty-title">没有匹配的内容</p></div>';
    } else if (b.kind === 'continue') {
      els.browseGrid.innerHTML = slice.map(historyCard).join('');
    } else if (b.kind === 'folders') {
      els.browseGrid.innerHTML = '<div class="grid folder-grid">' + slice.map(folderCard).join('') + '</div>';
    } else {
      els.browseGrid.innerHTML = slice.map(videoCard).join('');
    }
    fitPosterTitles(els.browseGrid);
    var imgs = els.browseGrid.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      imgs[i].addEventListener('error', function () {
        this.style.display = 'none';
      });
    }
    els.browsePager.hidden = pages <= 1;
    els.browsePageInfo.textContent = pages > 1 ? '第 ' + b.page + ' / ' + pages + ' 页' : '';
    els.btnBrowsePrev.disabled = b.page <= 1;
    els.btnBrowseNext.disabled = b.page >= pages;
  }

  /** 二级浏览页点击委托 */
  function onBrowseClick(e) {
    var histRm = e.target.closest('[data-history-remove]');
    if (histRm) {
      e.stopPropagation();
      removeHistoryCard(histRm.dataset.historyRemove);
      return;
    }
    var menuBtn = e.target.closest('[data-card-menu]');
    if (menuBtn) {
      e.stopPropagation();
      openCardMenu(menuBtn, menuBtn.dataset.cardMenuKind, menuBtn.dataset.cardMenu,
        menuBtn.dataset.tabId ? { tabId: menuBtn.dataset.tabId, tabKind: menuBtn.dataset.tabKind } : null);
      return;
    }
    var rmBtn = e.target.closest('[data-card-remove]');
    if (rmBtn) {
      e.stopPropagation();
      if (rmBtn.closest('.folder-card')) removeStudyFolder(rmBtn.dataset.cardRemove);
      else removeCustomVideo(rmBtn.dataset.cardRemove);
      return;
    }
    var more = e.target.closest('[data-browse]');
    if (more) { openBrowse(more.dataset.browse); return; }
    var star = e.target.closest('.stars .star');
    if (star) {
      var wrap = star.closest('.stars');
      setStars(wrap.dataset.scope, wrap.dataset.key, parseInt(star.dataset.val, 10));
      // 刷新二级浏览页里的条目与排序
      if (state.browse) {
        if (state.browse.kind === 'folders') state.browse.items = (store.get('studyFolders') || []).slice();
        else if (state.browse.kind === 'added') state.browse.items = (store.get('customVideos') || []).slice();
        renderBrowse();
      }
      return;
    }
    var b = state.browse;
    if (!b) return;
    if (b.kind === 'folders') {
      var fcard = e.target.closest('[data-folder]');
      if (fcard) { openFolder(fcard.dataset.folder); }
      return;
    }
    if (b.kind === 'continue') {
      var hist = e.target.closest('[data-history]');
      if (hist) {
        var entry = (store.get('watchHistory') || []).find(function (h) { return h.key === hist.dataset.history; });
        if (entry) playHistoryEntry(entry);
      }
      return;
    }
    var vcard = e.target.closest('.card[data-id]');
    if (vcard) {
      var v = (store.get('customVideos') || []).find(function (x) {
        return String(x.id || x.bvid || x.bv_id) === String(vcard.dataset.id);
      });
      if (v) playVideo(v, v.kind === 'local' ? 'local' : 'mine');
    }
  }

  async function loadFolder(source) {
    state.videos = [];
    showView('folder');
    // 先把头部刷出来：返回键的文案取决于"是不是从添加内容钻进来的"，
    // 这一步不该等到接口成功之后（失败时头部就停在上一页的文案上，很误导）。
    renderHomeHeader();
    renderEmpty('加载中…', '正在读取收藏夹内容', null);
    var login = store.get('login');
    if (!login) {
      renderEmpty('尚未登录', '请先完成 B 站登录后再查看收藏夹', 'settings');
      return;
    }
    try {
      if (!state.folders.length || Date.now() - state.foldersFetchedAt > 10 * 60 * 1000) {
        state.folders = await api.folders(login.mid, creds());
        state.foldersFetchedAt = Date.now();
      }
      var folder = state.folders.find(function (f) { return String(f.id) === String(source.id); });
      if (!folder) {
        renderEmpty('收藏夹不可用', '该收藏夹可能已删除或改动了，请重新选择', 'source');
        return;
      }
      state.activeFolder = folder;
      state.pn = 1;
      var key = folder.id + ':1';
      var cached = state.videoPages.get(key);
      if (!cached || Date.now() - cached.at > 5 * 60 * 1000) {
        cached = await api.folderVideos(folder.id, 1, creds());
        cached.at = Date.now();
        state.videoPages.set(key, cached);
      }
      // 只展示视频稿件（type=2），过滤音频/合集等无法直接播放的条目
      state.videos = (cached.medias || []).filter(function (m) {
        return !m.type || m.type === 2;
      });
      state.hasMore = !!cached.hasMore;
      renderHomeHeader();
      renderGrid();
    } catch (e) {
      renderHomeHeader();
      renderEmpty('加载失败', e.message, null);
      if (/登录|无效|权限|失效|过期/.test(e.message)) checkLogin(true);
    }
  }

  function renderHomeHeader() {
    var source = store.get('source');
    var title = source ? source.name : '…';
    var meta = '';
    var ctxTab = state.pendingTabId ? findCustomTab(state.pendingTabId) : null;
    if (state.activeFolder) {
      var total = state.activeFolder.media_count != null
        ? state.activeFolder.media_count
        : state.videos.length;
      meta = '收藏夹 · 共 ' + total + ' 个视频';
    }
    // 这条上下文和"收藏夹加载成功与否"无关：只要是走「添加内容」进来的就要显示
    if (ctxTab) meta += (meta ? ' · ' : '') + '正在添加到「' + ctxTab.name + '」标签页';
    els.sourceTitle.textContent = title;
    els.sourceMeta.textContent = meta;
    // 返回键的文案要说清"回到哪一级"：从「添加内容」钻进来的收藏夹，上一级是选择器；
    // 从内容源直接进来的收藏夹，上一级才是主页。
    var backLabel = els.btnBackHome.querySelector('span');
    if (backLabel) backLabel.textContent = ctxTab ? '返回添加内容' : '返回主页';
    els.sortSelect.value = store.get('sort') || 'add';
  }

  function sortVideosInPlace(arr, sort) {
    sort = sort || 'add';
    if (sort === 'pub') {
      arr.sort(function (a, b) {
        return (b.pubtime || b.ctime || b.addedAt || 0) - (a.pubtime || a.ctime || a.addedAt || 0);
      });
    } else if (sort === 'star') {
      arr.sort(function (a, b) {
        return ((b.stars || 0) - (a.stars || 0)) ||
          ((b.addedAt || b.fav_time || 0) - (a.addedAt || a.fav_time || 0));
      });
    } else if (sort === 'play') {
      arr.sort(function (a, b) {
        return (playCount(b) - playCount(a)) ||
          ((b.addedAt || b.fav_time || 0) - (a.addedAt || a.fav_time || 0));
      });
    } else {
      arr.sort(function (a, b) {
        return (b.fav_time || b.addedAt || 0) - (a.fav_time || a.addedAt || 0);
      });
    }
  }

  function sortedVideos() {
    var arr = state.videos.slice();
    var q = (state.folderQuery || '').trim().toLowerCase();
    if (q) {
      arr = arr.filter(function (v) {
        var title = (v.title || v.name || '').toLowerCase();
        var up = ((v.upper && v.upper.name) || v.upper || '').toLowerCase();
        return title.indexOf(q) >= 0 || up.indexOf(q) >= 0;
      });
    }
    sortVideosInPlace(arr, store.get('sort') || 'add');
    return arr;
  }

  function playCount(v) {
    if (v && v.play) return v.play;
    if (v && v.cnt_info && v.cnt_info.play) return v.cnt_info.play;
    if (v && v.stat && v.stat.view) return v.stat.view;
    return 0;
  }

  /* ---------------- 星级评分 ---------------- */
  function starControl(key, stars, scope) {
    var html = '<span class="stars" data-scope="' + esc(scope) + '" data-key="' + esc(key) + '">';
    for (var i = 1; i <= 5; i++) {
      html += '<span class="star' + (i <= (stars || 0) ? ' on' : '') + '" data-val="' + i + '" title="' + i + ' 星">★</span>';
    }
    return html + '</span>';
  }

  function setStars(scope, key, val) {
    if (scope === 'video') {
      var list = store.get('customVideos') || [];
      var it = list.find(function (x) { return String(x.bvid || x.id) === String(key); });
      if (!it) return;
      it.stars = val;
      store.set({ customVideos: list });
    } else if (scope === 'folder' || scope === 'modal-folder') {
      var folders = store.get('studyFolders') || [];
      var f = folders.find(function (x) { return String(x.id) === String(key); });
      if (!f) return;
      f.stars = val;
      store.set({ studyFolders: folders });
    } else if (scope === 'studyUp') {
      var ups = store.get('studyUps') || [];
      var u = ups.find(function (x) { return String(x.mid) === String(key); });
      if (!u) return;
      u.stars = val;
      store.set({ studyUps: ups });
    } else {
      return;
    }
    if (state.currentView === 'dashboard') renderDashboard();
    if (document.getElementById('folderList')) loadFoldersIntoModal();
  }

  /* ---------------- 学习列表（视频库 / 收藏夹库） ---------------- */
  function isVideoAdded(bvid) {
    return (store.get('customVideos') || []).some(function (x) {
      return x.kind === 'bili' && x.bvid === bvid;
    });
  }

  /**
   * 保证收藏夹里的某个视频已进入「视频库」，返回库内 id。
   * 已在库中则直接返回既有 id；无法识别该视频时返回 ''（不写库）。
   */
  async function ensureVideoInLibrary(bvid, mediaOverride) {
    var dupe = (store.get('customVideos') || []).find(function (x) {
      return x.kind === 'bili' && String(x.bvid) === String(bvid);
    });
    if (dupe) return dupe.id;
    var v = mediaOverride || state.videos.find(function (x) { return String(x.bvid || x.bv_id) === String(bvid); });
    if (!v) return '';
    // 自动归类：多 P / 合集视为“列表（剧集）”
    var classify = { isSeries: false, seriesKey: '', episodeCount: 0, cid: (v.data && v.data.cid) || 0 };
    try {
      var info = await getVideoInfoCached(bvid);
      if (info) {
        var pages = info.pages || [];
        var season = info.ugc_season;
        classify.isSeries =
          pages.length > 1 || !!(season && season.sections && season.sections.length);
        if (season && season.sections && season.sections.length) {
          classify.seriesKey = 's:' + (season.season_id != null ? season.season_id : bvid);
          season.sections.forEach(function (sec) { classify.episodeCount += (sec.episodes || []).length; });
        } else if (pages.length > 1) {
          classify.seriesKey = 'p:' + bvid;
          classify.episodeCount = pages.length;
        }
        if (!classify.cid && pages[0]) classify.cid = pages[0].cid;
      }
    } catch (e) {
      /* 分类失败时按单视频处理 */
    }
    var item = {
      id: 'bili-' + bvid,
      kind: 'bili',
      bvid: bvid,
      title: v.title || '未命名视频',
      cover: (v.cover || '').replace(/^http:\/\//i, 'https://'),
      upper: (v.upper && v.upper.name) || '',
      duration: v.duration || (v.data && v.data.duration) || 0,
      addedAt: Date.now(),
      stars: 0,
      play: playCount(v),
      pubtime: v.pubtime || v.ctime || 0,
      page: (v.data && v.data.page) || v.page || 1,
      cid: classify.cid,
      isSeries: classify.isSeries,
      seriesKey: classify.seriesKey,
      episodeCount: classify.episodeCount
    };
    var list = store.get('customVideos') || [];
    list.unshift(item);
    store.set({ customVideos: list });
    return item.id;
  }

  /** 从收藏夹视频列表把单个视频加入“视频库”（mediaOverride 用于内容源搜索结果） */
  async function addFolderVideoToStudy(bvid, mediaOverride) {
    if (isVideoAdded(bvid)) {
      toast('该视频已在学习列表');
      return;
    }
    var id = await ensureVideoInLibrary(bvid, mediaOverride);
    if (!id) return;
    toast('已添加到学习列表', 'success');
    renderGrid();
  }

  /** 打开某个收藏夹的视频列表 */
  function openFolder(folderId) {
    state.folderQuery = '';
    if (els.folderSearch) els.folderSearch.value = '';
    var folder = state.folders.find(function (f) { return String(f.id) === String(folderId); });
    if (!folder) {
      folder = (store.get('studyFolders') || []).find(function (s) { return String(s.id) === String(folderId); });
    }
    if (!folder) return;
    store.set({ source: { kind: 'folder', id: folder.id, name: folder.title || folder.name } });
    loadFolder(store.get('source'));
  }

  /** 把收藏夹加入/移出“收藏夹库” */
  function toggleStudyFolder(folderId) {
    var folders = store.get('studyFolders') || [];
    var folder = state.folders.find(function (f) { return String(f.id) === String(folderId); });
    var idx = folders.findIndex(function (s) { return String(s.id) === String(folderId); });
    if (idx >= 0) {
      folders.splice(idx, 1);
      store.set({ studyFolders: folders });
      toast('已从收藏夹库移除');
    } else if (folder) {
      folders.unshift({
        id: folder.id,
        title: folder.title,
        cover: (folder.cover || '').replace(/^http:\/\//i, 'https://'),
        mediaCount: folder.media_count || 0,
        addedAt: Date.now(),
        stars: 0
      });
      store.set({ studyFolders: folders });
      toast('已加入收藏夹库', 'success');
    }
    if (document.getElementById('folderList')) loadFoldersIntoModal();
    if (state.currentView === 'dashboard') renderDashboard();
  }

  /* ---------------- 观看记录与续播 ---------------- */
  /**
   * 查找 entry 应归入的历史记录索引：
   * 1) 系列：同 seriesKey 的整季记录；
   * 2) 单视频：同 key（bvid:cid / local id）的记录；
   * 3) 兜底：同 bvid 或 episodes 已含该集的整季记录（首次播放系列集时系列信息未回填）。
   */
  function historyIndexFor(list, entry) {
    if (entry.seriesKey) {
      return list.findIndex(function (h) { return h.seriesKey === entry.seriesKey; });
    }
    var i = list.findIndex(function (h) { return h.key === entry.key; });
    if (i >= 0) return i;
    if (entry.bvid) {
      return list.findIndex(function (h) {
        return h.seriesKey && (String(h.bvid) === String(entry.bvid) || (h.episodes && h.episodes[entry.key]));
      });
    }
    return -1;
  }

  function findHistory(key) {
    var list = store.get('watchHistory') || [];
    for (var i = 0; i < list.length; i++) {
      var h = list[i];
      if (h.key === key) return h; // 单视频 / 本地 / 旧版单集记录
      if (h.episodes && h.episodes[key]) {
        // 整季唯一记录：按分集映射返回该集独立进度（用于续播定位）
        var ep = h.episodes[key];
        return {
          key: key,
          kind: h.kind,
          bvid: h.bvid,
          cid: h.cid,
          page: h.page,
          title: ep.title || h.title,
          cover: h.cover,
          upper: h.upper,
          seriesKey: h.seriesKey || '',
          progress: ep.progress || 0,
          duration: ep.duration || h.duration || 0
        };
      }
    }
    return null;
  }

  function saveHistory(entry) {
    var list = (store.get('watchHistory') || []).slice();
    var idx = historyIndexFor(list, entry);
    var existing = idx >= 0 ? list.splice(idx, 1)[0] : null;
    // 目标记录是整季（或本次播放属于系列）→ 按整季唯一记录归并，各集进度存分集映射
    var isSeries = !!entry.seriesKey || !!(existing && existing.seriesKey);
    var mergeKey = entry.seriesKey || (existing && existing.seriesKey) || (existing && existing.key) || (entry.bvid ? 'b:' + entry.bvid : entry.key);
    var rec;
    if (isSeries) {
      rec = existing || Object.assign({}, entry);
      if (entry.seriesKey) rec.seriesKey = entry.seriesKey;
      if (!rec.seriesKey) rec.seriesKey = mergeKey;
      rec.key = mergeKey;
      rec.bvid = entry.bvid;
      rec.cid = entry.cid;
      rec.page = entry.page || 1;
      rec.title = entry.title || rec.title;
      if (entry.cover) rec.cover = entry.cover;
      if (entry.upper) rec.upper = entry.upper;
      if (entry.seriesTitle) rec.seriesTitle = entry.seriesTitle;
      if (entry.episodeLabel) rec.episodeLabel = entry.episodeLabel;
      if (entry.episodeCount) rec.episodeCount = entry.episodeCount;
      if (typeof entry.danmaku === 'number') rec.danmaku = entry.danmaku;
      rec.progress = entry.progress;
      rec.duration = entry.duration;
      rec.watchedAt = entry.watchedAt;
      rec.episodes = rec.episodes || {};
      rec.episodes[entry.key] = {
        progress: entry.progress,
        duration: entry.duration,
        watchedAt: entry.watchedAt,
        title: entry.title || ''
      };
      // 兜底：并入同系列/同 bvid 的旧版单条记录（保留各集独立进度）
      for (var i = list.length - 1; i >= 0; i--) {
        var x = list[i];
        var same = x.seriesKey ? x.seriesKey === mergeKey : (entry.bvid && String(x.bvid) === String(entry.bvid));
        if (same) {
          if (!rec.episodes[x.key]) {
            rec.episodes[x.key] = {
              progress: x.progress || 0,
              duration: x.duration || 0,
              watchedAt: x.watchedAt || 0,
              title: x.title || '',
              finished: !!x.finished
            };
          }
          list.splice(i, 1);
        }
      }
    } else {
      rec = Object.assign({}, entry);
    }
    list.unshift(rec);
    if (list.length > 50) list.length = 50;
    // 用户重新开始观看该内容 → 自动恢复“继续学习”卡片（取消之前的隐藏标记）
    var hidden = store.get('hiddenHistoryKeys') || [];
    var hidIdx = hidden.indexOf(mergeKey);
    if (hidIdx >= 0) {
      hidden = hidden.slice();
      hidden.splice(hidIdx, 1);
    }
    store.set({ watchHistory: list, hiddenHistoryKeys: hidden });
  }

  function setProgressCtx(ctx) {
    state.progressCtx = ctx;
    progressLastSave = 0;
  }

  function saveProgressNow(force) {
    var ctx = state.progressCtx;
    var v = window.BiliNestPlayer ? BiliNestPlayer.getVideo() : null;
    if (!ctx || !v || !v.duration || isNaN(v.currentTime)) return;
    if (v.ended) return; // 已结束的由 markFinished 处理（写 progress 0），这里不覆盖
    // 恢复态（加载失败自动重试中）：视频可能在 0 附近，回写会污染历史，跳过
    if (window.BiliNestPlayer && typeof BiliNestPlayer.isRecovering === 'function' &&
        BiliNestPlayer.isRecovering() && v.currentTime < 5) return;
    // 回退保护：若已记录的真实进度较大，不要被“接近 0 的瞬时值”覆盖
    var list = store.get('watchHistory') || [];
    var idx = state.progressCtx ? historyIndexFor(list, state.progressCtx) : -1;
    if (!force && idx >= 0 && list[idx].progress >= 10 && v.currentTime < 5) return;
    var now = Date.now();
    if (!force && now - progressLastSave < 5000) return;
    progressLastSave = now;
    var dmCount = (window.BiliNestPlayer && BiliNestPlayer.getDanmakuCount) ? BiliNestPlayer.getDanmakuCount() : 0;
    saveHistory({
      key: ctx.key,
      kind: ctx.kind,
      bvid: ctx.bvid || '',
      cid: ctx.cid || '',
      page: ctx.page || 1,
      title: ctx.title || '未命名视频',
      cover: ctx.cover || '',
      upper: ctx.upper || '',
      seriesKey: ctx.seriesKey || '',
      seriesTitle: ctx.seriesTitle || '',
      episodeLabel: ctx.episodeLabel || '',
      episodeCount: ctx.episodeCount || 0,
      danmaku: dmCount,
      progress: Math.max(0, Math.round(v.currentTime)),
      duration: Math.round(v.duration || 0),
      watchedAt: now
    });
  }

  function markFinished() {
    var ctx = state.progressCtx;
    var v = window.BiliNestPlayer ? BiliNestPlayer.getVideo() : null;
    if (!ctx) return;
    progressLastSave = Date.now();
    var finishedAt = Date.now();
    var dur = Math.round((v && v.duration) || 0);
    var list = (store.get('watchHistory') || []).slice();
    var idx = historyIndexFor(list, ctx);
    var existing = idx >= 0 ? list.splice(idx, 1)[0] : null;
    if (existing && (existing.seriesKey || ctx.seriesKey)) {
      // 整季唯一记录：当前集标记为已看完，并自动切到下一个可续播的集
      // （避免“看完一集整张卡片消失”，也避免重复显示已看完的集）
      var rec = existing;
      if (!rec.seriesKey) rec.seriesKey = ctx.seriesKey;
      rec.episodes = rec.episodes || {};
      rec.episodes[ctx.key] = {
        progress: 0,
        duration: dur,
        watchedAt: finishedAt,
        title: ctx.title || '',
        finished: true
      };
      var next = seriesResume(rec.seriesKey || ctx.seriesKey);
      if (next) {
        var nextEp = rec.episodes[next.bvid + ':' + next.cid] || null;
        rec.bvid = next.bvid;
        rec.cid = next.cid;
        rec.page = next.page || 1;
        rec.title = next.title || rec.title;
        rec.progress = next.progress || 0;
        rec.duration = (nextEp && nextEp.duration) || rec.duration || dur;
        rec.episodeLabel = (nextEp && nextEp.title) || rec.episodeLabel || '';
        rec.watchedAt = finishedAt;
      } else {
        // 整季已全部看完
        rec.bvid = ctx.bvid;
        rec.cid = ctx.cid;
        rec.page = ctx.page || 1;
        rec.progress = 0;
        rec.duration = dur;
        rec.watchedAt = finishedAt;
      }
      list.unshift(rec);
      if (list.length > 50) list.length = 50;
      store.set({ watchHistory: list });
    } else {
      saveHistory({
        key: ctx.key,
        kind: ctx.kind,
        bvid: ctx.bvid || '',
        cid: ctx.cid || '',
        page: ctx.page || 1,
        title: ctx.title || '未命名视频',
        cover: ctx.cover || '',
        upper: ctx.upper || '',
        seriesKey: ctx.seriesKey || '',
        seriesTitle: ctx.seriesTitle || '',
        episodeLabel: ctx.episodeLabel || '',
        episodeCount: ctx.episodeCount || 0,
        danmaku: (window.BiliNestPlayer && BiliNestPlayer.getDanmakuCount) ? BiliNestPlayer.getDanmakuCount() : 0,
        progress: 0,
        duration: dur,
        watchedAt: finishedAt
      });
    }
  }

  /** 从“继续学习”卡片继续播放 */
  function playHistoryEntry(entry) {
    if (entry.kind === 'local') {
      var item = (store.get('customVideos') || []).find(function (x) { return x.id === entry.key; });
      if (!item) {
        toast('本地文件已不存在，请重新添加', 'error');
        return;
      }
      playVideo(item, 'local');
    } else if (entry.seriesKey) {
      // 整季唯一记录：续播最近未看完的一集（分集映射里 watchedAt 最新且未看完）
      var s = seriesResume(entry.seriesKey);
      if (!s) {
        toast('该系列没有可续播的剧集', 'error');
        return;
      }
      playVideo({
        kind: 'bili',
        bvid: s.bvid,
        title: entry.seriesTitle || entry.title || '未命名视频',
        cover: entry.cover || '',
        upper: entry.upper || '',
        duration: s.progress || entry.duration || 0,
        page: s.page || 1,
        data: { cid: s.cid }
      }, 'mine');
    } else {
      playVideo({
        kind: 'bili',
        bvid: entry.bvid,
        title: entry.title || '未命名视频',
        cover: entry.cover || '',
        upper: entry.upper || '',
        duration: entry.duration || 0,
        page: entry.page || 1,
        data: { cid: entry.cid }
      }, 'mine');
    }
  }

  /**
   * 整季续播定位：在系列记录的分集映射里找“最近观看且未看完”的一集。
   * 已看完的集跳过；没有分集映射时退回整季记录的当前集。
   */
  function seriesResume(seriesKey) {
    var h = (store.get('watchHistory') || []).find(function (x) { return x.seriesKey === seriesKey; });
    if (!h) return null;
    if (h.episodes) {
      var bestKey = '';
      var bestAt = -1;
      var bestScore = -1;
      Object.keys(h.episodes).forEach(function (pk) {
        var ep = h.episodes[pk];
        if (!ep || ep.finished) return;
        // 有实质进度的集优先，其次最近观看的集
        var score = (ep.progress || 0) >= 10 ? 2 : ((ep.progress || 0) > 0 ? 1 : 0);
        if (score > bestScore || (score === bestScore && (ep.watchedAt || 0) > bestAt)) {
          bestScore = score;
          bestAt = ep.watchedAt || 0;
          bestKey = pk;
        }
      });
      if (bestKey) {
        var ci = bestKey.indexOf(':');
        return {
          bvid: bestKey.slice(0, ci),
          cid: bestKey.slice(ci + 1),
          page: h.page || 1,
          progress: h.episodes[bestKey].progress || 0,
          title: h.episodes[bestKey].title || h.title
        };
      }
      // 有分集映射但全部已看完（或全部无进度）→ 没有可续播的集
      return null;
    }
    return { bvid: h.bvid, cid: h.cid, page: h.page || 1, progress: h.progress || 0, title: h.title };
  }

  /**
   * 历史记录唯一化迁移：把旧版“每集一条”的记录按系列/视频归并为一条，
   * 各集独立进度存入 episodes 映射，避免继续学习栏出现重复卡片或误读进度。
   */
  function normalizeHistory() {
    var list = store.get('watchHistory') || [];
    if (!list.length) return;
    // 第一遍：建立 bvid -> seriesKey 映射（含整季记录分集映射里的所有集），
    // 让旧版“无 seriesKey 的单集记录”也能归并到同一整季记录
    var bvidToSeries = new Map();
    list.forEach(function (h) {
      if (!h.seriesKey) return;
      bvidToSeries.set(String(h.bvid), h.seriesKey);
      if (h.episodes) {
        Object.keys(h.episodes).forEach(function (pk) {
          var ci = pk.indexOf(':');
          if (ci > 0) bvidToSeries.set(pk.slice(0, ci), h.seriesKey);
        });
      }
    });
    var map = new Map();
    var changed = false;
    list.forEach(function (h) {
      var mk = h.seriesKey || (h.bvid ? (bvidToSeries.get(String(h.bvid)) || 'b:' + h.bvid) : h.key);
      if (!map.has(mk)) {
        map.set(mk, h);
        return;
      }
      changed = true;
      var cur = map.get(mk);
      var older = (h.watchedAt || 0) <= (cur.watchedAt || 0) ? h : cur;
      var newer = older === h ? cur : h;
      newer.episodes = newer.episodes || {};
      // 确保“当前”记录自身也进入分集映射（键为 bvid:cid；系列记录 key 是 seriesKey，需换算）
      var selfKey = newer.kind === 'local' ? newer.key : ((newer.bvid && newer.cid) ? newer.bvid + ':' + newer.cid : newer.key);
      if (selfKey && !newer.episodes[selfKey]) {
        newer.episodes[selfKey] = {
          progress: newer.progress || 0,
          duration: newer.duration || 0,
          watchedAt: newer.watchedAt || 0,
          title: newer.title || '',
          finished: !!newer.finished
        };
      }
      // 先把 older 已有的分集映射整体并入（older 可能是前面合并过的记录，含多集进度）
      var oldEp = older.episodes || {};
      Object.keys(oldEp).forEach(function (k) {
        if (!newer.episodes[k]) newer.episodes[k] = oldEp[k];
      });
      // 再补 older 自身这一集（分集键：bvid:cid / local id，避免记录 key 被改成合并键后误写）
      var oldSelfKey = older.kind === 'local' ? older.key : ((older.bvid && older.cid) ? older.bvid + ':' + older.cid : older.key);
      if (oldSelfKey && !newer.episodes[oldSelfKey]) {
        newer.episodes[oldSelfKey] = {
          progress: older.progress || 0,
          duration: older.duration || 0,
          watchedAt: older.watchedAt || 0,
          title: older.title || '',
          finished: !!older.finished
        };
      }
      newer.key = mk; // 归并后的记录以合并键为唯一标识
      map.set(mk, newer);
    });
    if (!changed) return;
    var out = [];
    map.forEach(function (v) { out.push(v); });
    out.sort(function (a, b) { return (b.watchedAt || 0) - (a.watchedAt || 0); });
    if (out.length > 50) out.length = 50;
    store.set({ watchHistory: out });
  }

  /**
   * 后台回填“孤儿”记录：旧版可能留下无 seriesKey 的单集记录（不同 bvid 属于同一合集）。
   * 逐个查一次视频信息（限量、静默），识别出系列后补 seriesKey 并归并，
   * 避免继续学习栏出现同一系列的重复卡片。
   */
  async function backfillOrphanSeries() {
    var list = store.get('watchHistory') || [];
    var orphans = list.filter(function (h) {
      return h.kind === 'bili' && !h.seriesKey && h.bvid && h.cid;
    });
    if (!orphans.length) return;
    var changed = false;
    for (var i = 0; i < orphans.length && i < 8; i++) {
      var o = orphans[i];
      try {
        var info = await getVideoInfoCached(o.bvid);
        if (!info) continue;
        var season = info.ugc_season;
        var pages = info.pages || [];
        var isSeries = pages.length > 1 || !!(season && season.sections && season.sections.length);
        if (!isSeries) continue;
        var sk = (season && season.sections && season.sections.length)
          ? 's:' + (season.season_id != null ? season.season_id : o.bvid)
          : 'p:' + o.bvid;
        var cur = store.get('watchHistory') || [];
        var rec = cur.find(function (x) { return x.key === o.key; });
        if (rec && !rec.seriesKey) {
          rec.seriesKey = sk;
          if (!rec.seriesTitle && season && season.title) rec.seriesTitle = season.title;
          changed = true;
        }
      } catch (e) {
        /* 单个失败静默，继续下一个 */
      }
    }
    if (changed) normalizeHistory();
  }

  /**
   * 卡片的显示名：用户自定义名优先（右键卡片→重命名），否则用源标题。
   * 本地文件 / 本地文件夹列表的"源标题"就是文件名 / 文件夹名。
   */
  function titleOf(v) {
    if (!v) return '未命名';
    return v.customTitle || v.title || v.name || '未命名';
  }

  /** 卡片右上角「更多操作」的图标：三个实心点（比文字版 ⋯ 稳、也对得齐） */
  function menuDotsIcon() {
    return (
      '<svg class="card-menu-icon" viewBox="0 0 24 24" aria-hidden="true">' +
        '<circle cx="5.5" cy="12" r="2.1"></circle>' +
        '<circle cx="12" cy="12" r="2.1"></circle>' +
        '<circle cx="18.5" cy="12" r="2.1"></circle>' +
      '</svg>'
    );
  }

  /** 找到库里那条内容（视频库条目或收藏夹库条目） */
  function findLibraryEntry(kind, id) {
    var list = kind === 'folder' ? (store.get('studyFolders') || []) : (store.get('customVideos') || []);
    return list.find(function (x) {
      return String(x.id || x.bvid || x.bv_id) === String(id);
    }) || null;
  }

  /** 改名（只改本地显示，不动源站）；同时把观看记录里跟着显示的那份标题一起改掉 */
  function renameLibraryEntry(kind, id, name) {
    var target = findLibraryEntry(kind, id);
    if (!target) return;
    var key = kind === 'folder' ? 'studyFolders' : 'customVideos';
    var list = (store.get(key) || []).slice();
    var patch = {};
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id || list[i].bvid || list[i].bv_id) !== String(id)) continue;
      if (name) list[i].customTitle = name;
      else delete list[i].customTitle;
      patch[key] = list;
      break;
    }
    // 「继续学习」里的卡片用的是观看记录里的标题，改名后一起同步，
    // 否则会出现"库里叫新名字、继续学习里还是旧名字"
    var hist = (store.get('watchHistory') || []).slice();
    var touched = false;
    var targetBvid = target.bvid || (target.kind === 'bili' ? target.bv_id : '') || '';
    for (var j = 0; j < hist.length; j++) {
      var hit = false;
      if (target.seriesKey) hit = hist[j].seriesKey === target.seriesKey;
      else if (target.kind === 'local' && target.isSeries) hit = false;
      else if (targetBvid) hit = hist[j].bvid === targetBvid;
      else hit = hist[j].key === target.id;
      if (!hit) continue;
      hist[j].customTitle = name || undefined;
      touched = true;
    }
    if (touched) patch.watchHistory = hist;
    store.set(patch);
  }

  /** 卡片标题内联改名（右键卡片 → 重命名） */
  function startCardRename(cardEl, kind, id) {
    // 传进来的可能是「⋯」按钮（菜单就是从它弹出的），先归一到卡片本身
    if (cardEl && cardEl.closest) cardEl = cardEl.closest('.card') || cardEl;
    var h = cardEl && cardEl.querySelector('.card-title');
    if (!h) return;
    var entry = findLibraryEntry(kind, id);
    if (!entry) return;
    closeActionMenu();
    var cur = titleOf(entry);
    h.innerHTML = '<input class="card-title-input" type="text" maxlength="60" value="' + esc(cur) + '">';
    var input = h.querySelector('input');
    input.focus();
    input.select();
    var done = false;
    var commit = function (save) {
      if (done) return;
      done = true;
      var name = (input.value || '').trim();
      if (save && name && name !== cur) {
        renameLibraryEntry(kind, id, name);
        toast('已重命名为「' + name + '」', 'success');
      }
      renderDashboard();
      if (state.currentView === 'browse') renderBrowse();
    };
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
      e.stopPropagation();
    });
    input.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('blur', function () { commit(true); });
  }

  /* ---------------- 封面占位（没有封面图时） ---------------- */

  /** 人工挑过的 10 套配色（只存基准色相，CSS 里派生另外两个色斑） */
  var COVER_HUES = [212, 24, 156, 280, 336, 190, 44, 258, 12, 172];

  /** 名字 → 固定配色下标：同一条内容每次打开颜色都一样 */
  function coverHue(name) {
    var s = String(name || '');
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return COVER_HUES[h % COVER_HUES.length];
  }

  /** 取首字：跳过空白 / 括号 / 标点 / emoji，拿第一个"有意义的字" */
  function firstGlyph(name) {
    var chars = Array.from(String(name || '').trim());
    var skip = /[\s\u3000【】「」『』（）()\[\]{}<>《》〈〉“”"'‘’·、，,。.！!？?：:；;～~—\-_/\\|]/;
    var i = 0;
    while (i < chars.length && (skip.test(chars[i]) || /\p{Extended_Pictographic}/u.test(chars[i]))) i++;
    return chars[i] || chars[0] || '#';
  }

  /** 海报模式那行"数据"：本地文件夹 → 几个视频；本地单视频 → 多大；合集 → 共几集 */
  function coverDataLine(v) {
    var epCount = (v.episodes && v.episodes.length) || v.episodeCount || 0;
    if (v.kind === 'local') {
      if (v.isSeries && epCount) return epCount + ' 个视频';
      // 单个本地视频：大小那行本来就由卡片下方的元数据行负责（"137.0 KB"），这里只标类型
      return '本地视频';
    }
    if (v.isSeries && epCount) return '共 ' + epCount + ' 集';
    return (v.upper && v.upper.name) || v.upper || 'B站视频';
  }

  /** 占位封面里最初渲染的"海报标题"（量完放不下就换掉） */
  function posterTitleHtml(title) {
    return '<span class="ph-title" data-title="' + esc(title) + '">' + esc(title) + '</span>';
  }

  /**
   * 量一遍所有海报标题：
   *   · 装得下（≥16px）→ 字号换算成 cqw，跟着卡片宽度等比缩放；
   *   · 装不下 → 这一张退回"首字大字"，并把完整标题还给卡片下方那行。
   * 容差 3px：line-height 的小数会被布局取整，scrollHeight 常比 clientHeight 大 1~3px。
   */
  var PH_MIN_FONT = 16;
  var PH_MAX_FONT = 30;      // 海报标题的字号上限：再大就把封面吃掉了
  function fitPosterTitles(root) {
    if (!root) return;
    var list = root.querySelectorAll('.card-cover.ph--poster .ph-title');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var w = el.clientWidth;
      if (!w) continue;                     // 隐藏视图里量不了，保持默认字号
      var coverW = (el.closest('.card-cover') || el).clientWidth || w;
      var lo = PH_MIN_FONT, hi = PH_MAX_FONT, best = 0;
      for (var k = 0; k < 8; k++) {
        var mid = (lo + hi) / 2;
        el.style.fontSize = mid + 'px';
        var fits = el.scrollHeight <= el.clientHeight + 3 && el.scrollWidth <= w + 1;
        if (fits) { best = mid; lo = mid; } else { hi = mid; }
      }
      if (best >= PH_MIN_FONT) {
        // cqw 是相对**封面宽度**的（容器查询单位），所以按封面宽换算，卡片变宽变窄自动等比
        el.style.fontSize = (best / coverW * 100).toFixed(2) + 'cqw';
        continue;
      }
      switchToGlyphCover(el);
    }
  }

  /** 名字放不下：封面改成首字大字，卡片下方恢复完整标题 */
  function switchToGlyphCover(titleEl) {
    var cover = titleEl.closest('.card-cover');
    var card = titleEl.closest('.card') || titleEl.closest('.hcard');
    var title = titleEl.getAttribute('data-title') || titleEl.textContent || '';
    titleEl.remove();
    if (cover) {
      cover.classList.remove('ph--poster');
      cover.classList.add('ph--glyph');
      var glyph = document.createElement('span');
      glyph.className = 'ph-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = firstGlyph(title);
      cover.insertBefore(glyph, cover.firstChild);
    }
    var h3 = card && card.querySelector('.card-title');
    if (h3) {
      h3.textContent = title;
      h3.classList.remove('card-title--data');
    }
  }

  /**
   * 视频卡片右上角「⋯」的菜单（右键卡片也走这里）：重命名 / 恢复原名 / 删除。
   * 收藏夹、UP主、继续学习三类卡片不参与改名，仍是原来的 ✕，见各自的渲染函数。
   * ctx.tabId 存在时（自定义标签页内），最后一项是"从本标签页移除"（不动库）。
   */
  function openCardMenu(anchor, kind, id, ctx) {
    if (kind !== 'video') return;
    ctx = ctx || {};
    var entry = findLibraryEntry(kind, id);
    if (!entry) return;
    var items = [{ label: '重命名', onClick: function () { startCardRename(anchor, kind, id); } }];
    if (entry.customTitle) {
      items.push({
        label: '恢复原名',
        onClick: function () {
          renameLibraryEntry(kind, id, '');
          toast('已恢复原名', 'success');
          renderDashboard();
          if (state.currentView === 'browse') renderBrowse();
        }
      });
    }
    if (ctx.tabId) {
      items.push({
        label: '从本标签页移除',
        note: true,
        onClick: function () { removeFromTab(ctx.tabId, ctx.tabKind || kind, id); }
      });
    } else {
      items.push({ label: '删除', danger: true, onClick: function () { removeCustomVideo(id); } });
    }
    openActionMenu(anchor, items);
  }

  /** 右键库里的卡片 → 重命名菜单（视频库条目 / 收藏夹库条目） */
  function bindCardMenus() {
    [els.dashboard, els.browseGrid].forEach(function (root) {
      if (!root || root.dataset.cardMenuBound) return;
      root.dataset.cardMenuBound = '1';
      root.addEventListener('contextmenu', function (e) {
        // 只有视频卡片能改名；其它卡片的 ✕ 各管各的
        var card = e.target.closest('.card[data-id]');
        if (!card) return;
        e.preventDefault();
        // 「⋯」按钮上带着 tab 上下文，右键时直接借用它，省得在卡片上再挂一份
        var btn = card.querySelector('[data-card-menu]');
        var id = (btn && btn.dataset.cardMenu) || card.dataset.id;
        openCardMenu(card, 'video', id, btn && btn.dataset.tabId ? { tabId: btn.dataset.tabId, tabKind: btn.dataset.tabKind } : null);
      });
    });
  }

  function videoCard(v, ctx) {
    var dur = v.duration || (v.data && v.data.duration) || 0;
    // 官方接口可能返回 http:// 的封面，统一转 https 避免被 CSP / 混合内容拦截
    var cover = (v.cover || v.pic || '').replace(/^http:\/\//i, 'https://');
    var upName = (v.upper && v.upper.name) || v.upper || '';
    var isFolder = !!state.activeFolder && !v.kind;
    var isAdded = !!(v.kind || v.addedAt);
    var epCount = (v.episodes && v.episodes.length) || v.episodeCount || 0;
    var localSeries = v.kind === 'local' && v.isSeries && epCount > 0;
    // 本地文件现在也能读到时长（添加时用 <video> 探过），有就照常显示。
    // 本地文件夹列表：封面角标放"总大小"（"几个视频"那行移到卡片下方，见 coverDataLine）
    var localBytes = 0;
    if (localSeries) {
      (v.episodes || []).forEach(function (ep) { localBytes += ep.size || 0; });
    }
    var durLabel = v.kind === 'local'
      ? (localSeries ? (localBytes ? fmtSize(localBytes) : epCount + ' 个视频') : (dur ? fmtDuration(dur) : '本地'))
      : fmtDuration(dur);
    var timeLabel = '';
    if (v.kind === 'local') {
      timeLabel = localSeries ? '文件夹' : (v.size ? fmtSize(v.size) : '本地视频');
    } else {
      var sort = store.get('sort') || 'add';
      var ts = sort === 'pub' ? (v.pubtime || v.ctime) : (v.fav_time || v.addedAt);
      if (ts) timeLabel = (sort === 'pub' ? '发布于 ' : '添加于 ') + fmtDate(ts);
    }
    var badge = isFolder ? '<span class="fav-flag">已收藏</span>' : '';
    if (!isFolder && isAdded && v.isSeries) {
      badge = '<span class="series-flag">列表 · ' + (v.episodeCount || '') + ' 集</span>';
    }
    var addBtn = '';
    if (state.activeFolder && v.bvid && !v.kind) {
      // 右上角状态区：蓝✓ = 在学习列表（库）；绿✓ = 在某个自定义标签页
      //  · 从自定义标签页进来：只出现一个淡绿 +（一次完成入库 + 入页），加完变两个 ✓
      //  · 从右上角内容源进来：原有蓝色 +/✓ 保留，另加一个「添加到」用于选标签页
      var added = isVideoAdded(v.bvid);
      var libId = 'bili-' + v.bvid;
      var ctxTab = state.pendingTabId ? findCustomTab(state.pendingTabId) : null;
      var inTabs = customTabs().filter(function (t) { return tabHasItem(t, 'video', libId); });
      var flags = '';
      if (ctxTab) {
        var inCtxTab = tabHasItem(ctxTab, 'video', libId);
        var addTabBtn = '<button type="button" class="card-add card-add-tab" data-video-add-tab="' + esc(v.bvid) +
          '" title="添加到「' + esc(ctxTab.name) + '」标签页（同时加入学习列表）">+</button>';
        if (!added && !inCtxTab) {
          flags += addTabBtn;
        } else {
          if (added) flags += '<span class="card-flag card-flag-lib" title="已在学习列表">✓</span>';
          if (inCtxTab) flags += '<span class="card-flag card-flag-tab" title="已在「' + esc(ctxTab.name) + '」标签页">✓</span>';
          else flags += addTabBtn;
        }
      } else {
        flags += added
          ? '<span class="card-flag card-flag-lib" title="已在学习列表">✓</span>'
          : '<button type="button" class="card-add" data-video-add="' + esc(v.bvid) + '" title="添加到学习列表">+</button>';
        if (inTabs.length) {
          flags += '<span class="card-flag card-flag-tab" title="已在「' + esc(inTabs[0].name) + '」标签页">✓</span>';
        }
        flags += '<button type="button" class="card-add card-add-pick" data-video-pick-tab="' + esc(v.bvid) +
          '" title="添加到自定义标签页…">添加到</button>';
      }
      addBtn = '<div class="card-flags">' + flags + '</div>';
    }
    var stars = isAdded
      ? '<div class="card-stars">' + starControl(v.bvid || v.id, v.stars || 0, 'video') + '</div>'
      : '';
    var cardId = v.id || v.bvid || v.bv_id || '';
    // 视频库的卡片：右下角“×”删除按钮（点击弹确认框；列表/剧集整季删除）
    // 右上角「⋯」：重命名 / 恢复原名 / 删除（自定义标签页里是"从本页移除"）
    var removeBtn = '';
    if ((ctx && ctx.tab) || (isAdded && !state.activeFolder)) {
      removeBtn =
        '<button type="button" class="card-menu" data-card-menu="' + esc(cardId) +
        '" data-card-menu-kind="video"' +
        (ctx && ctx.tab ? ' data-tab-id="' + esc(ctx.tab) + '" data-tab-kind="video"' : '') +
        ' title="更多操作（重命名 / 删除）" aria-label="更多操作">' + menuDotsIcon() + '</button>';
    }
    var title = titleOf(v);
    var ph = !cover;
    return (
      '<article class="card" role="button" tabindex="0" data-id="' + esc(cardId) +
      '" title="' + esc(title) + '">' +
        '<div class="card-cover' + (ph ? ' ph ph--poster' : '') + '"' +
          (ph ? ' style="--h:' + coverHue(title) + '"' : '') + '>' +
          (ph ? posterTitleHtml(title) : '') +
          (cover ? '<img src="' + esc(cover) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '') +
          '<span class="dur">' + esc(durLabel) + '</span>' +
          badge +
          addBtn +
          // ✕ 也放到画面上（与续播卡一致，也和「+ / ✓」用同一种材质）；
          // 它与 addBtn 互斥：flags 只在内容源里出现，✕ 只在库里出现。
          removeBtn +
        '</div>' +
        '<div class="card-body">' +
          (ph
            ? '<h3 class="card-title card-title--data">' + esc(coverDataLine(v)) + '</h3>'
            : '<h3 class="card-title">' + esc(title) + '</h3>') +
          '<div class="card-meta">' +
            '<span class="up">' + esc(upName) + '</span>' +
            '<span>' + esc(timeLabel) + '</span>' +
          '</div>' +
          (isAdded
            ? '<div class="card-foot">' + stars + '</div>'
            : '') +
        '</div>' +
      '</article>'
    );
  }

  function renderGrid() {
    var items = sortedVideos();
    if (!items.length) {
      if ((state.folderQuery || '').trim()) {
        renderEmpty('没有匹配的视频', '换个关键词试试', null);
        return;
      }
      renderEmpty(
        state.activeFolder ? '这个收藏夹里还没有视频' : '还没有视频',
        state.activeFolder ? '' : '点击「内容源」添加单个视频或本地视频',
        state.activeFolder ? null : 'source'
      );
      return;
    }
    els.grid.innerHTML = items.map(videoCard).join('');
    // 封面加载失败时隐藏图片（保留深色底），避免出现破图
    var imgs = els.grid.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      imgs[i].addEventListener('error', function () {
        this.style.display = 'none';
      });
    }
    // 搜索时只作用于已加载内容，隐藏“加载更多”
    els.loadMoreWrap.hidden = !(state.hasMore && state.activeFolder && !(state.folderQuery || '').trim());
    // 从内容源搜索跳转定位：渲染完成后尝试定位目标视频（未加载完则自动翻页）
    if (state.jumpToBvid && !state.jumpBusy) {
      setTimeout(jumpToFolderVideo, 60);
    }
  }

  /** 在已加载的收藏夹列表中定位目标视频卡片并高亮；找到返回 true */
  function tryLocateJumpTarget() {
    if (!state.jumpToBvid) return false;
    var v = (state.videos || []).find(function (x) {
      return String(x.bvid || x.bv_id || x.id) === String(state.jumpToBvid);
    });
    if (!v) return false;
    var cardId = v.id || v.bvid || v.bv_id;
    var card = els.grid.querySelector('.card[data-id="' + String(cardId) + '"]');
    if (!card) return false;
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.add('card-highlight');
    state.jumpToBvid = null;
    setTimeout(function () { card.classList.remove('card-highlight'); }, 2600);
    return true;
  }

  /** 从内容源搜索结果跳到收藏夹具体位置：先在已加载列表定位，找不到则自动翻页 */
  async function jumpToFolderVideo() {
    if (state.jumpBusy || !state.jumpToBvid) return;
    state.jumpBusy = true;
    try {
      if (tryLocateJumpTarget()) return;
      var tries = 0;
      while (state.hasMore && state.activeFolder && state.currentView === 'folder' && tries < 10) {
        tries++;
        await loadMore();
        if (tryLocateJumpTarget()) return;
      }
      if (state.jumpToBvid) {
        toast('未在当前收藏夹中找到该视频（可能已失效或已删除）', 'error');
        state.jumpToBvid = null;
      }
    } finally {
      state.jumpBusy = false;
    }
  }

  function renderEmpty(title, sub, actionKind) {
    var btn = '';
    if (actionKind === 'source') {
      btn = '<button type="button" id="btnEmptyAction" class="btn primary">打开内容源</button>';
    } else if (actionKind === 'settings') {
      btn = '<button type="button" id="btnEmptyAction" class="btn primary">前往设置</button>';
    }
    els.grid.innerHTML =
      '<div class="empty">' +
        '<p class="empty-title">' + esc(title) + '</p>' +
        (sub ? '<p>' + esc(sub) + '</p>' : '') +
        btn +
      '</div>';
    els.loadMoreWrap.hidden = true;
  }

  /* ---------------- 播放 ---------------- */
  function buildPlayerUrl(bvid, cid, page) {
    var p = new URLSearchParams({
      bvid: bvid || '',
      page: String(page || 1),
      isOutside: 'true',   // 官方站外播放器标准参数
      danmaku: '1',        // 显示弹幕（官方嵌入播放器本身不提供弹幕输入框）
      autoplay: '1',
      high_quality: '1'
    });
    if (cid) p.set('cid', String(cid));
    return 'https://player.bilibili.com/player.html?' + p.toString();
  }

  /** 渲染播放页 UP 名字；拿到 mid 时显示为可点击链接（悬停变色，跳转 B 站 UP 主页） */
  function renderPlayerUp(name, mid) {
    if (!name) {
      els.playerUp.textContent = '';
      return;
    }
    if (mid) {
      els.playerUp.innerHTML =
        'UP：<a class="up-link" href="https://space.bilibili.com/' +
        encodeURIComponent(mid) +
        '" target="_blank" rel="noopener noreferrer" title="打开 ' +
        esc(name) + ' 的主页">' + esc(name) + '</a>';
    } else {
      els.playerUp.textContent = 'UP：' + name;
    }
  }

  /**
   * 播放一个本地条目（单视频 / 本地列表里的一集）。
   * @param {object} entry {id, name, kind:'local', ...}
   * @param {boolean} keepEpisodes 是否保留当前选集面板（本地列表切集时用）
   */
  async function playLocalEntry(entry, keepEpisodes) {
    // 每次播放都取一个**新的** blob 地址：ArtPlayer 换源时会 revoke 上一个，
    // 复用同一个地址会让第二次播放直接报"地址不支持"（详见 localfiles.js）。
    var url = await local.freshUrl(entry);
    if (!url) {
      toast('无法读取本地文件：权限已失效或文件被移动，请重新添加', 'error', 6000);
      loadDashboard();
      return;
    }
    setProgressCtx({
      key: entry.id, kind: 'local', title: entry.name || '本地视频',
      cover: '', upper: '', bvid: '', cid: '', page: 1
    });
    var rec = findHistory(entry.id);
    var resumeSec =
      rec && rec.progress >= 10 && (!rec.duration || rec.progress < rec.duration - 10)
        ? rec.progress
        : 0;
    els.playerTitle.textContent = entry.name || '本地视频';
    els.playerTitle.title = els.playerTitle.textContent;
    if (!keepEpisodes) {
      els.episodePanel.hidden = true;
      els.playerLayout.classList.remove('has-episodes');
    }
    BiliNestPlayer.loadLocal(url, resumeSec);
  }

  async function playVideo(v, sourceKind) {
    state.activeVideo = v;
    state.episodes = [];
    updateEpisodeNav(); // 新视频开始时先隐藏上一集/下一集
    state.seriesInfo = null;
    state.prevView = state.currentView;
    /*
     * 记住"从列表的哪个位置进来的"：播放页返回时回到原处，而不是跳回顶部。
     * showView() 每次都 scrollTo(0)，一集看完回到列表就从第一屏重新开始找 ——
     * 这是"要不要把播放页开在新标签页"背后真正的痛点，用记住/恢复滚动位置就能解决，
     * 不必引入第二个标签页和跨标签同步。
     */
    if (state.currentView !== 'player') {
      state.listReturn = { view: state.currentView, y: window.scrollY || 0 };
    }
    showView('player');
    els.playerTitle.textContent = titleOf(v);
    // 标题最多显示两行（见 .player-title）：完整标题留给悬停查看
    els.playerTitle.title = els.playerTitle.textContent;
    var upName = (v.upper && v.upper.name) || v.upper || '';
    var upMid = (v.upper && v.upper.mid) || 0;
    renderPlayerUp(upName, upMid);
    // 手动添加等来源只存了 UP 名没存 mid：用 view 接口补一次，能拿到再变成可点击链接
    if (!upMid && v.kind === 'bili' && v.bvid) {
      getVideoInfoCached(v.bvid)
        .then(function (info) {
          if (!info || state.activeVideo !== v) return; // 已切换到其它视频则忽略
          var mid = info.owner && info.owner.mid;
          if (mid) renderPlayerUp(upName, mid);
        })
        .catch(function () { /* 拿不到 mid 就保持纯文本 */ });
    }
    els.favBadge.hidden = sourceKind !== 'folder';
    els.episodePanel.hidden = true;
    els.playerLayout.classList.remove('has-episodes');

    if (v.kind === 'local') {
      // 本地视频：复用 ArtPlayer 内核（无弹幕/清晰度），支持自动续播
      BiliNestPlayer.stop();
      els.biliFrame.hidden = true;
      // 本地文件夹列表：把文件当"剧集"，先摆好选集面板，再接着最近看的那一集播
      if (v.isSeries && v.episodes && v.episodes.length) {
        state.episodes = v.episodes.map(function (ep) {
          return {
            kind: 'local',
            id: ep.id,
            cid: ep.id,          // 复用 cid 字段当"当前集标识"，选集面板的高亮逻辑直接可用
            page: 1,
            title: ep.name,
            duration: ep.duration || 0,
            entry: ep
          };
        });
        var pickIdx = 0;
        var newestAt = -1;
        for (var ei = 0; ei < state.episodes.length; ei++) {
          var h = findHistory(state.episodes[ei].id);
          if (h && (h.watchedAt || 0) > newestAt) { newestAt = h.watchedAt || 0; pickIdx = ei; }
        }
        var target = state.episodes[pickIdx];
        state.activeEpisode = { id: target.id, cid: target.cid, page: 1 };
        els.episodePanel.hidden = false;
        els.playerLayout.classList.add('has-episodes');
        sizeEpisodePanel();
        renderEpisodeList(target.cid, 1, true);
        updateEpisodeNav();
        await playLocalEntry(target.entry, true);
        return;
      }
      await playLocalEntry(v, false);
      return;
    }

    var bvid = v.bvid || v.bv_id;
    var cid = (v.data && v.data.cid) || v.cid || '';
    var page = (v.data && v.data.page) || v.page || 1;
    // 剧集（列表）条目：若存在观看记录，自动继续最近未看完的剧集，
    // 而不是每次都从第 1 集开始
    if (v.kind === 'bili' && v.isSeries && v.seriesKey) {
      var sr = seriesResume(v.seriesKey);
      if (sr) {
        bvid = sr.bvid;
        cid = sr.cid;
        page = sr.page || 1;
      }
    }
    state.activeEpisode = { bvid: bvid, cid: cid, page: page };
    // 先加载系列/选集信息（失败不阻塞播放），确保进度上下文带正确的 seriesKey：
    // 避免首播、从收藏夹播放系列集时把进度写成独立单条记录（无法归并到整季）
    try {
      await loadEpisodes(bvid, cid, page);
    } catch (e) {
      /* 选集加载失败不阻塞播放 */
    }
    await playBiliStream(bvid, cid, page);
  }

  /**
   * 播放 B 站视频：优先用 ArtPlayer 播放器（应用内画质切换，不跳官网）；
   * 播放地址获取失败时降级到官方嵌入播放器。
   */
  async function playBiliStream(bvid, cid, page) {
    els.biliFrame.hidden = true;
    // 部分来源（手动添加的链接、个别收藏夹条目）可能没有 cid，
    // 播放前按分 P 页码从 pagelist 接口解析出正确的 cid。
    if (!cid && bvid) {
      var resolved = await resolveCid(bvid, page);
      if (resolved) {
        cid = resolved.cid;
        page = resolved.page;
        if (state.activeEpisode) state.activeEpisode.cid = cid;
      }
    }
    // 切换剧集前，先保存上一集的进度（旧上下文 + 旧视频）
    saveProgressNow(true);
    var av = state.activeVideo || {};
    var rec = findHistory(bvid + ':' + cid);
    var resumeSec =
      rec && rec.progress >= 10 && (!rec.duration || rec.progress < rec.duration - 10)
        ? rec.progress
        : 0;
    try {
      await BiliNestPlayer.load(bvid, cid, resumeSec, {
        poster: (av.cover || av.pic || '').replace(/^http:\/\//i, 'https://')
      });
    } catch (e) {
      // 降级：官方嵌入播放器
      BiliNestPlayer.stop();
      els.biliFrame.hidden = false;
      els.biliFrame.src = buildPlayerUrl(bvid, cid, page);
      toast('播放地址服务暂不可用（' + e.message + '），已切换官方播放器', 'error');
    }
    // 加载完成后才切换进度上下文：避免 load() 内部 pause 旧视频时，
    // 用“新集的上下文 + 旧视频的时间”误写历史记录
    var curEp = (state.episodes || []).find(function (ep) { return String(ep.cid) === String(cid); });
    var si = state.seriesInfo;
    setProgressCtx({
      key: bvid + ':' + cid,
      kind: 'bili',
      bvid: bvid,
      cid: cid,
      page: page,
      title: (curEp && curEp.title) || av.title || '',
      cover: av.cover || '',
      upper: (av.upper && av.upper.name) || av.upper || '',
      seriesKey: si ? si.seriesKey : '',
      seriesTitle: si ? si.seriesTitle : '',
      episodeLabel: curEp ? curEp.title : (si ? si.episodeLabel : ''),
      episodeCount: si ? si.episodeCount : 0
    });
  }

  /** 按 bvid + 页码解析 cid（解析失败返回 null） */
  async function resolveCid(bvid, page) {
    try {
      var list = await api.pagelist(bvid, creds());
      if (!list || !list.length) return null;
      var idx = Math.max(0, Math.min((parseInt(page, 10) || 1) - 1, list.length - 1));
      return { cid: list[idx].cid, page: idx + 1 };
    } catch (e) {
      return null;
    }
  }

  async function loadEpisodes(bvid, cid, page) {
    var info = await getVideoInfoCached(bvid);
    if (!info) {
      els.episodePanel.hidden = true;
      return;
    }
    var episodes = [];
    var season = info.ugc_season;
    // 判定并记录“列表（剧集）”信息：多 P 或合集都视为一个列表
    var isSeries =
      !!(season && season.sections && season.sections.length) ||
      !!(info.pages && info.pages.length > 1);
    var seriesKey = '';
    var seriesTitle = '';
    var episodeLabel = '';
    var episodeCount = 0;
    if (season && season.sections && season.sections.length) {
      seriesKey = 's:' + (season.season_id != null ? season.season_id : bvid);
      seriesTitle = season.title || info.title || '';
      var allEps = [];
      season.sections.forEach(function (sec) {
        allEps = allEps.concat(sec.episodes || []);
      });
      episodeCount = allEps.length;
      var curEp = allEps.find(function (ep) { return String(ep.cid) === String(cid); });
      episodeLabel = curEp ? (curEp.title || '') : '';
    } else if (info.pages && info.pages.length > 1) {
      seriesKey = 'p:' + bvid;
      seriesTitle = info.title || '';
      episodeCount = info.pages.length;
      episodeLabel = '第 ' + (page || 1) + ' 集';
    }
    state.seriesInfo = {
      isSeries: isSeries,
      seriesKey: seriesKey,
      seriesTitle: seriesTitle,
      episodeLabel: episodeLabel,
      episodeCount: episodeCount
    };
    // 回填进度上下文与已保存的历史条目，确保列表信息不丢失
    var pc = state.progressCtx;
    if (pc && pc.bvid === bvid) {
      pc.seriesKey = seriesKey;
      pc.seriesTitle = seriesTitle;
      pc.episodeLabel = episodeLabel;
      pc.episodeCount = episodeCount;
    }
    // 旧版本入库的视频没有列表信息：首次播放时自动补上归类
    if (seriesKey && state.activeVideo && state.activeVideo.kind === 'bili' && !state.activeVideo.isSeries) {
      var cl = store.get('customVideos') || [];
      var ci = cl.find(function (x) { return x.kind === 'bili' && String(x.bvid) === String(bvid); });
      if (ci) {
        ci.isSeries = isSeries;
        ci.seriesKey = seriesKey;
        ci.episodeCount = episodeCount;
        if (!ci.cid) ci.cid = cid;
        store.set({ customVideos: cl });
      }
    }
    if (season && season.sections && season.sections.length) {
      season.sections.forEach(function (sec) {
        (sec.episodes || []).forEach(function (ep) {
          episodes.push({
            kind: 'season',
            section: sec.title || '',
            bvid: ep.bvid,
            cid: ep.cid,
            page: ep.page || 1,
            title: ep.title || '',
            // 合集的每集时长不在 ep.duration 上，而在 ep.arc.duration 里
            // （实测：多 P 用 pages[].duration，合集必须读 arc.duration，否则整列都是 0:00）
            duration: ep.duration || (ep.arc && ep.arc.duration) || 0
          });
        });
      });
    } else if (info.pages && info.pages.length > 1) {
      info.pages.forEach(function (p, i) {
        episodes.push({
          kind: 'page',
          section: '',
          bvid: bvid,
          cid: p.cid,
          page: i + 1,
          title: p.part || ('P' + (i + 1)),
          duration: p.duration || 0
        });
      });
    }
    if (!episodes.length) {
      els.episodePanel.hidden = true;
      updateEpisodeNav();
      return;
    }
    // 给同一剧集的所有历史条目补齐 seriesKey（整季一个进度，避免出现多个集）
    var epKeys = new Set();
    episodes.forEach(function (ep) { epKeys.add(String(ep.bvid) + ':' + String(ep.cid)); });
    var hlist = store.get('watchHistory') || [];
    var histChanged = false;
    hlist.forEach(function (h) {
      var inEp = epKeys.has(String(h.bvid) + ':' + String(h.cid));
      var sameBvid = !!h.bvid && h.bvid === bvid;
      if (!h.seriesKey && (inEp || sameBvid)) {
        h.seriesKey = seriesKey;
        h.seriesTitle = seriesTitle;
        if (!h.episodeCount) h.episodeCount = episodeCount;
        if (pc && h.key === pc.key) h.episodeLabel = episodeLabel;
        histChanged = true;
      }
    });
    if (histChanged) store.set({ watchHistory: hlist });
    // 旧版“每集一条”记录归并为整季一条（保留各集独立进度）
    normalizeHistory();
    state.episodes = episodes;
    els.episodePanel.hidden = false;
    els.playerLayout.classList.add('has-episodes');
    sizeEpisodePanel();
    renderEpisodeList(cid, page, true);
    updateEpisodeNav();
  }

  /** 播放指定索引的剧集（上一集 / 下一集 / 点击选集共用） */
  function playEpisodeAt(idx) {
    var ep = state.episodes[idx];
    if (!ep) return;
    // 本地列表里的一集：换文件即可，选集面板保持不动
    if (ep.kind === 'local') {
      state.activeEpisode = { id: ep.id, cid: ep.cid, page: 1 };
      renderEpisodeList(ep.cid, 1);
      updateEpisodeNav();
      playLocalEntry(ep.entry || { id: ep.id, name: ep.title, kind: 'local' }, true);
      return;
    }
    state.activeEpisode = { bvid: ep.bvid, cid: ep.cid, page: ep.page || 1 };
    if (ep.bvid !== (state.activeVideo && state.activeVideo.bvid)) {
      els.playerTitle.textContent = ep.title || els.playerTitle.textContent;
      els.playerTitle.title = els.playerTitle.textContent;
    }
    renderEpisodeList(ep.cid, ep.page || 1);
    updateEpisodeNav();
    playBiliStream(ep.bvid, ep.cid, ep.page || 1);
  }

  /** 当前正在播放的剧集在选集列表中的索引（-1 表示不在列表中） */
  function currentEpisodeIndex() {
    var ae = state.activeEpisode;
    if (!ae || !state.episodes || !state.episodes.length) return -1;
    return state.episodes.findIndex(function (ep) {
      return String(ep.cid) === String(ae.cid) && String(ep.page || 1) === String(ae.page || 1);
    });
  }

  /** 根据选集列表更新播放器里的上一集 / 下一集按钮显隐 */
  function updateEpisodeNav() {
    if (!window.BiliNestPlayer) return;
    var hasList = !!(state.episodes && state.episodes.length > 1);
    var idx = currentEpisodeIndex();
    window.BiliNestPlayer.updateEpisodeNav({
      visible: hasList && idx >= 0,
      prev: hasList && idx > 0,
      next: hasList && idx >= 0 && idx < state.episodes.length - 1
    });
    // 播放结束浮层：仅列表（多 P / 合集）视频显示；最后一集只显示“重温”
    window.BiliNestPlayer.setEndNav({
      show: hasList,
      next: hasList && idx >= 0 && idx < state.episodes.length - 1
    });
  }

  /** 让右侧选集面板与视频窗口等高对齐（窄屏时恢复自动高度） */
  function sizeEpisodePanel() {
    if (!els.episodePanel || els.episodePanel.hidden) return;
    if (window.innerWidth <= 960) {
      els.episodePanel.style.maxHeight = '';
      return;
    }
    var h = els.playerShell.offsetHeight;
    if (h > 0) els.episodePanel.style.maxHeight = h + 'px';
  }

  function renderEpisodeList(currentCid, currentPage, scrollToActive) {
    var html = '';
    var lastSection = null;
    state.episodes.forEach(function (ep, i) {
      if (ep.section && ep.section !== lastSection) {
        html += '<div class="episode-section">' + esc(ep.section) + '</div>';
        lastSection = ep.section;
      }
      var active = String(ep.cid) === String(currentCid) &&
        String(ep.page) === String(currentPage || 1);
      html +=
        '<button type="button" class="episode-row' + (active ? ' active' : '') + '" data-ep="' + i +
        '" data-title="' + esc(ep.title) + '">' +
          '<span class="ep-index">' + (i + 1) + '</span>' +
          '<span class="ep-name">' + esc(ep.title) + '</span>' +
          '<span class="ep-dur">' + fmtDuration(ep.duration) + '</span>' +
        '</button>';
    });
    els.episodeList.innerHTML = html;
    if (scrollToActive) requestAnimationFrame(scrollEpisodeToActive);
  }

  function scrollEpisodeToActive() {
    var panel = els.episodePanel;
    if (!panel || panel.hidden) return;
    var active = panel.querySelector('.episode-row.active');
    if (!active) return;
    var rowH = active.offsetHeight || 40;
    var target = Math.max(0, active.offsetTop - rowH * 2);
    if (Math.abs(panel.scrollTop - target) > rowH) {
      panel.scrollTop = target;
    }
  }

  async function getVideoInfoCached(bvid) {
    var hit = videoInfoCache.get(bvid);
    if (hit && Date.now() - hit.at < 3600 * 1000) return hit.data;
    try {
      var data = await api.videoInfo(bvid, creds());
      videoInfoCache.set(bvid, { at: Date.now(), data: data });
      return data;
    } catch (e) {
      return null;
    }
  }

  function showView(view) {
    var from = state.currentView;
    state.currentView = view;
    els.dashboardView.hidden = view !== 'dashboard';
    els.homeView.hidden = view !== 'folder';
    els.browseView.hidden = view !== 'browse';
    els.playerView.hidden = view !== 'player';
    if (view === 'dashboard') {
      state.activeFolder = null;
      state.pendingTabId = '';   // 回主页即结束「往某个标签页加内容」的上下文
    }
    if (view !== 'player') {
      /*
       * 离开播放页前先把进度写回。
       * 原来只靠播放器的 pause 事件兜底，但 stopPlayer() 会紧接着把媒体元素拆掉
       * （dash.js reset + 清 blob 地址），pause 事件是异步派发的，拆掉之后就不一定
       * 还能到 —— 实测"返回列表"时进度会停在上一次 5 秒节流保存的位置。
       * 这里趁视频还在、时间还是真的，补一次强制保存。
       */
      if (from === 'player') saveProgressNow(true);
      stopPlayer();
    }
    window.scrollTo({ top: 0 });
  }

  /**
   * 从播放页回到列表时，把滚动位置还原到"进播放页之前"。
   * 只在回到同一个视图时还原（从收藏夹进播放页、又退回收藏夹），视图换了就当没有。
   */
  function restoreListScroll() {
    var r = state.listReturn;
    state.listReturn = null;
    if (!r || r.view !== state.currentView || !r.y) return;
    // 等这一帧渲染完再滚：showView / renderXxx 刚把内容换掉，高度还没稳定
    requestAnimationFrame(function () { window.scrollTo({ top: r.y }); });
  }

  function stopPlayer() {
    // 停止自研播放器
    BiliNestPlayer.stop();
    // 重建 iframe 节点以彻底停止播放（避免 CSP 对 about:blank 的兼容问题）
    if (els.biliFrame && els.biliFrame.parentNode) {
      var fresh = makeBiliFrame();
      els.biliFrame.replaceWith(fresh);
      els.biliFrame = fresh;
    }
  }

  function makeBiliFrame() {
    var f = document.createElement('iframe');
    f.id = 'biliFrame';
    f.className = 'player-frame';
    f.hidden = true;
    f.title = 'B站视频播放器';
    f.scrolling = 'no';
    f.setAttribute('allowfullscreen', '');
    f.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
    f.referrerPolicy = 'origin';
    return f;
  }

  /* ---------------- 内容源弹窗 ---------------- */
  function openSourceModal() {
    state.jumpToBvid = null; // 打开内容源时取消未完成的收藏夹定位
    var login = store.get('login');
    openModal(
      '<div class="modal-head"><h2>内容源</h2><button type="button" class="icon-btn" data-close aria-label="关闭">×</button></div>' +
      '<div class="modal-body">' +
        '<input id="sourceSearch" class="search-input" type="search" placeholder="搜索收藏夹 / 收藏夹内的视频…" autocomplete="off" value="' + esc(state.sourceQuery) + '">' +
        '<section><h3>收藏夹</h3>' +
          (login
            ? '<div id="folderList" class="folder-list"><p class="muted">加载中…</p></div>'
            : '<p class="muted">尚未登录，请先到「设置」完成 B 站登录，才能读取收藏夹。</p>') +
          '<div id="folderVideoResults" class="folder-video-results"></div>' +
        '</section>' +
        // 这里只负责"往里加"，加进来的东西统一在「视频库」里看 ——
        // 以前这里还挂一份列表，和视频库重复，已经去掉。
        '<section><h3>添加视频</h3>' +
          '<form id="addVideoForm" class="add-video">' +
            '<input id="addVideoInput" type="text" placeholder="粘贴 B 站视频链接 / BV 号 / av 号" autocomplete="off">' +
            '<button type="submit" class="btn primary">添加</button>' +
          '</form>' +
          '<p class="muted small">粘贴单集链接，或加本地内容；加进来的都会出现在「视频库」标签页里。</p>' +
          '<div class="row">' +
            '<button id="btnPickLocal" type="button" class="btn ghost">添加本地视频 / 文件夹…</button>' +
          '</div>' +
        '</section>' +
      '</div>',
      { wide: true }
    );
    bindClose();
    bindSourceModalEvents();
    if (login) loadFoldersIntoModal();
  }

  async function loadFoldersIntoModal() {
    var listEl = document.getElementById('folderList');
    if (!listEl) return;
    try {
      if (!state.folders.length || Date.now() - state.foldersFetchedAt > 10 * 60 * 1000) {
        state.folders = await api.folders(store.get('login').mid, creds());
        state.foldersFetchedAt = Date.now();
      }
      var current = store.get('source');
      if (!state.folders.length) {
        listEl.innerHTML = '<p class="muted">还没有创建任何收藏夹。</p>';
        return;
      }
      var q = (state.sourceQuery || '').trim().toLowerCase();
      var folders = state.folders;
      if (q) {
        folders = folders.filter(function (f) { return (f.title || '').toLowerCase().indexOf(q) >= 0; });
      }
      if (!folders.length) {
        listEl.innerHTML = '<p class="muted">没有匹配的收藏夹。</p>';
        return;
      }
      listEl.innerHTML = folders.map(function (f) {
        var active = current && current.kind === 'folder' && String(current.id) === String(f.id);
        var count = f.media_count != null ? f.media_count : '';
        var study = (store.get('studyFolders') || []).find(function (s) { return String(s.id) === String(f.id); });
        return (
          '<div class="folder-row' + (active ? ' active' : '') + '" data-folder="' + esc(f.id) + '">' +
            '<div class="folder-info">' +
              '<span class="folder-name">' + esc(f.title) + '</span>' +
              '<span class="folder-count">' + esc(count ? count + ' 个视频' : '') + '</span>' +
            '</div>' +
            starControl(f.id, study ? study.stars : 0, 'modal-folder') +
            '<button type="button" class="btn ghost small" data-folder-use="' + esc(f.id) + '">' + (active ? '当前' : '使用') + '</button>' +
            '<button type="button" class="btn ghost small' + (study ? ' on' : '') + '" data-folder-study="' + esc(f.id) + '" title="' + (study ? '从收藏夹库移除' : '加入收藏夹库') + '">' + (study ? '已加入学习' : '加入学习') + '</button>' +
          '</div>'
        );
      }).join('');
    } catch (e) {
      listEl.innerHTML = '<p class="muted">收藏夹加载失败：' + esc(e.message) + '</p>';
    }
  }

  /**
   * 内容源一级菜单里搜索各收藏夹内的视频：
   * 逐收藏夹拉取前 2 页（最多约 40 个/夹，最多 10 个夹），带 5 分钟缓存；
   * 结果边搜边渲染，命中 12 条即停。搜索期间更换关键词会丢弃过期批次。
   */
  async function searchFolderVideos(query) {
    var seq = ++state.folderSearchSeq;
    var box = document.getElementById('folderVideoResults');
    if (!box) return;
    if (!query || !store.get('login')) {
      box.innerHTML = '';
      state.folderSearchMatches = [];
      return;
    }
    box.innerHTML = '<p class="muted small">正在搜索收藏夹内的视频…</p>';
    var folders = state.folders || [];
    var FOLDER_CAP = Math.min(folders.length, 10);
    var PER_FOLDER_PAGES = 2;
    var matches = [];
    var scanned = 0;
    var done = false;
    outer:
    for (var fi = 0; fi < FOLDER_CAP; fi++) {
      var folder = folders[fi];
      for (var pn = 1; pn <= PER_FOLDER_PAGES; pn++) {
        if (seq !== state.folderSearchSeq) return; // 查询已变化，丢弃
        var key = String(folder.id) + ':' + pn;
        var cached = state.videoPages.get(key);
        if (!cached || Date.now() - cached.at > 5 * 60 * 1000) {
          try {
            cached = await api.folderVideos(folder.id, pn, creds());
            cached.at = Date.now();
            state.videoPages.set(key, cached);
          } catch (e) {
            cached = null;
          }
        }
        if (!cached || !cached.medias) continue;
        var medias = cached.medias.filter(function (m) { return !m.type || m.type === 2; });
        scanned += medias.length;
        medias.forEach(function (m) {
          if (seq !== state.folderSearchSeq) return;
          var title = (m.title || '').toLowerCase();
          var up = ((m.upper && m.upper.name) || '').toLowerCase();
          if (title.indexOf(query) >= 0 || up.indexOf(query) >= 0) {
            matches.push({ folder: folder, media: m });
          }
        });
        if (seq === state.folderSearchSeq) {
          state.folderSearchMatches = matches.slice();
          renderFolderVideoResults(box, query, matches, scanned, false);
        }
        if (matches.length >= 12) break outer;
        if (!cached.hasMore) break;
      }
    }
    if (seq !== state.folderSearchSeq) return;
    done = true;
    state.folderSearchMatches = matches.slice();
    renderFolderVideoResults(box, query, matches, scanned, done);
  }

  function renderFolderVideoResults(box, query, matches, scanned, done) {
    if (!matches.length) {
      box.innerHTML = done
        ? '<p class="muted small">收藏夹内未找到匹配的视频（已搜索前 ' + scanned + ' 个）。可打开对应收藏夹后搜索全部内容。</p>'
        : '<p class="muted small">正在搜索收藏夹内的视频…</p>';
      return;
    }
    var truncated = matches.length >= 12;
    var html =
      '<h3 class="fv-title">收藏夹内匹配（' + matches.length + '）</h3>' +
      '<ul class="mine-list">' +
      matches.map(function (m, i) {
        var added = isVideoAdded(m.media.bvid);
        var cover = (m.media.cover || m.media.pic || '').replace(/^http:\/\//i, 'https://');
        var thumb = cover
          ? '<img class="mine-thumb" src="' + esc(cover) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
          : '';
        // 整行可点击：跳到该视频所在收藏夹并定位；按钮点击互不冲突
        return (
          '<li class="mine-row clickable" data-fv-open="' + i + '" title="打开收藏夹定位该视频">' +
            thumb +
            '<div class="mine-info">' +
              '<span class="mine-name">' + esc(m.media.title || '未命名') + '</span>' +
              '<span class="muted">' + esc(m.folder.title || '') + '</span>' +
            '</div>' +
            '<button type="button" class="fv-play" data-fv-play="' + i + '" title="播放" aria-label="播放">' +
              '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>' +
            '</button>' +
            '<button type="button" class="btn ghost small' + (added ? ' on' : '') + '" data-fv-add="' + i + '">' + (added ? '已添加' : '加入学习') + '</button>' +
          '</li>'
        );
      }).join('') +
      '</ul>' +
      '<p class="muted small">已搜索前 ' + scanned + ' 个视频' +
        (truncated ? '，命中较多仅显示前 12 条，可打开对应收藏夹内搜索全部。' : '') +
      '</p>';
    box.innerHTML = html;
    hideBrokenThumbs(box);
  }

  /** 缩略图加载失败时隐藏，避免出现破碎图标（CSP 禁止内联 onerror，改用事件监听） */
  function hideBrokenThumbs(root) {
    if (!root) return;
    Array.prototype.forEach.call(root.querySelectorAll('img.mine-thumb'), function (img) {
      img.addEventListener('error', function () { img.style.display = 'none'; });
    });
  }

  function bindSourceModalEvents() {
    var sourceSearch = document.getElementById('sourceSearch');
    if (sourceSearch) {
      sourceSearch.addEventListener('input', function () {
        state.sourceQuery = this.value;
        loadFoldersIntoModal();
        clearTimeout(state.sourceSearchTimer);
        var q = state.sourceQuery.trim().toLowerCase();
        if (!q) {
          state.folderSearchSeq++;
          state.folderSearchMatches = [];
          var box = document.getElementById('folderVideoResults');
          if (box) box.innerHTML = '';
          return;
        }
        state.sourceSearchTimer = setTimeout(function () {
          searchFolderVideos(q);
        }, 350);
      });
    }
    var fvResults = document.getElementById('folderVideoResults');
    if (fvResults) {
      fvResults.addEventListener('click', function (e) {
        var playBtn = e.target.closest('[data-fv-play]');
        if (playBtn) {
          var m = state.folderSearchMatches[Number(playBtn.dataset.fvPlay)];
          if (!m) return;
          closeModal();
          var media = m.media;
          playVideo({
            kind: 'bili',
            bvid: media.bvid || media.id,
            title: media.title || '未命名视频',
            cover: (media.cover || '').replace(/^http:\/\//i, 'https://'),
            upper: media.upper || '',
            duration: media.duration || (media.data && media.data.duration) || 0,
            page: (media.data && media.data.page) || media.page || 1,
            data: { cid: media.data && media.data.cid }
          }, 'folder');
          return;
        }
        var addBtn = e.target.closest('[data-fv-add]');
        if (addBtn) {
          var m2 = state.folderSearchMatches[Number(addBtn.dataset.fvAdd)];
          if (!m2) return;
          addFolderVideoToStudy(m2.media.bvid || m2.media.id, m2.media).then(function () {
            var q2 = (state.sourceQuery || '').trim().toLowerCase();
            if (q2) searchFolderVideos(q2);
          });
          return;
        }
        // 点击整行：关闭弹窗，打开该收藏夹并自动定位到这条视频
        var row = e.target.closest('[data-fv-open]');
        if (row) {
          var m3 = state.folderSearchMatches[Number(row.dataset.fvOpen)];
          if (!m3) return;
          closeModal();
          state.jumpToBvid = m3.media.bvid || m3.media.id;
          openFolder(m3.folder.id);
          return;
        }
      });
    }
    var folderList = document.getElementById('folderList');
    if (folderList) {
      folderList.addEventListener('click', function (e) {
        var useBtn = e.target.closest('[data-folder-use]');
        if (useBtn) {
          var folder = state.folders.find(function (f) { return String(f.id) === String(useBtn.dataset.folderUse); });
          if (folder) {
            closeModal();
            openFolder(folder.id);
          }
          return;
        }
        var studyBtn = e.target.closest('[data-folder-study]');
        if (studyBtn) {
          toggleStudyFolder(studyBtn.dataset.folderStudy);
          return;
        }
        var star = e.target.closest('.stars .star');
        if (star) {
          var wrap = star.closest('.stars');
          setStars(wrap.dataset.scope, wrap.dataset.key, parseInt(star.dataset.val, 10));
          return;
        }
        var row = e.target.closest('[data-folder]');
        if (!row) return;
        var folder = state.folders.find(function (f) { return String(f.id) === String(row.dataset.folder); });
        if (!folder) return;
        closeModal();
        openFolder(folder.id);
      });
    }

    document.getElementById('addVideoForm').addEventListener('submit', onAddVideo);
    // 一个入口，点了再选"文件还是文件夹"：浏览器把这两种系统对话框分开了，
    // showOpenFilePicker 选不了文件夹、showDirectoryPicker 选不了单个文件，
    // 所以用一层小菜单让用户自己表明意图 —— 选文件按单视频处理，选文件夹按列表处理。
    document.getElementById('btnPickLocal').addEventListener('click', function () {
      openActionMenu(this, [
        { label: '选择视频文件…', onClick: function () { onPickLocal(); } },
        { label: '选择文件夹（整个文件夹当一个列表）', onClick: function () { onPickFolder(); } }
      ]);
    });
  }

  async function onAddVideo(e) {
    e.preventDefault();
    var input = document.getElementById('addVideoInput');
    var submitBtn = e.target.querySelector('button[type=submit]');
    var ref = api.parseVideoRef(input.value);
    if (!ref) {
      toast('无法识别：请粘贴 bilibili.com/video/ 完整链接、BV 号或 av 号', 'error');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = '解析中…';
    try {
      var info = await api.videoInfo(ref.id, creds());
      // 自动归类：多 P / 合集视为“列表（剧集）”，单视频为普通视频
      var pages = info.pages || [];
      var season = info.ugc_season;
      var isSeries = pages.length > 1 || !!(season && season.sections && season.sections.length);
      var seriesKey = '';
      var episodeCount = 0;
      if (season && season.sections && season.sections.length) {
        seriesKey = 's:' + (season.season_id != null ? season.season_id : info.bvid);
        season.sections.forEach(function (sec) { episodeCount += (sec.episodes || []).length; });
      } else if (pages.length > 1) {
        seriesKey = 'p:' + info.bvid;
        episodeCount = pages.length;
      }
      var item = {
        id: 'bili-' + (info.bvid || ref.id),
        kind: 'bili',
        bvid: info.bvid || ref.id,
        title: info.title || '未命名视频',
        cover: info.pic || '',
        upper: (info.owner && info.owner.name) || '',
        duration: info.duration || 0,
        addedAt: Date.now(),
        stars: 0,
        play: (info.stat && info.stat.view) || 0,
        pubtime: info.pubdate || 0,
        page: ref.page || 1,
        cid: pages[0] ? pages[0].cid : 0,
        isSeries: isSeries,
        seriesKey: seriesKey,
        episodeCount: episodeCount
      };
      var list = store.get('customVideos') || [];
      var exists = list.some(function (x) { return x.kind === 'bili' && x.bvid === item.bvid; });
      if (!exists) list.unshift(item);
      store.set({ customVideos: list, source: { kind: 'mine', name: '我的视频' } });
      closeModal();
      await loadDashboard();
      toast(exists ? '该视频已在列表中' : '已添加：' + item.title, 'success');
    } catch (err) {
      toast('添加失败：' + err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '添加';
    }
  }

  async function onPickLocal() {
    var entries = null;
    try {
      entries = await local.pickFiles();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      toast('无法打开文件选择器：' + e.message, 'error');
      return;
    }
    if (!entries) {
      // File System Access API 不可用：回退到隐藏的 <input type=file>
      els.fileInput.click();
      return;
    }
    addLocalEntries(entries);
  }

  function addLocalEntries(entries) {
    if (!entries || !entries.length) {
      toast('这个文件浏览器放不了（支持 mp4 / m4v / mov / webm / mkv）', 'error', 6000);
      return;
    }
    var list = store.get('customVideos') || [];
    for (var i = 0; i < entries.length; i++) list.unshift(entries[i]);
    store.set({ customVideos: list, source: { kind: 'mine', name: '我的视频' } });
    closeModal();
    loadDashboard();
    toast('已添加 ' + entries.length + ' 个本地视频', 'success');
  }

  /**
   * 添加一个"本地文件夹列表"：文件夹里的视频合成一个卡片（和 B 站合集一样是列表），
   * 卡片标题用文件夹名，点进播放页后在选集面板里按文件名挑。
   */
  function addLocalFolder(res) {
    if (!res || !res.episodes || !res.episodes.length) {
      toast('这个文件夹里没有找到视频文件（支持 mp4 / mkv / webm / mov / avi / flv / ts / m4v）', 'error');
      return;
    }
    var seriesId = 'locdir-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    var item = {
      id: seriesId,
      kind: 'local',
      isSeries: true,
      seriesKey: 'dir:' + seriesId,
      title: res.name,
      name: res.name,
      episodes: res.episodes,
      episodeCount: res.episodes.length,
      addedAt: Date.now(),
      stars: 0
    };
    var list = store.get('customVideos') || [];
    list.unshift(item);
    store.set({ customVideos: list, source: { kind: 'mine', name: '我的视频' } });
    closeModal();
    loadDashboard();
    toast('已添加文件夹「' + res.name + '」（' + res.episodes.length + ' 个视频' +
      (res.skipped ? '，跳过 ' + res.skipped + ' 个浏览器放不了的' : '') +
      '）· 点卡片右上角 ⋯ 可改名', 'success', res.skipped ? 7000 : 5000);
  }

  async function onPickFolder() {
    var res = null;
    try {
      toast('正在读取文件夹…（会逐个确认能不能播）', 'info', 6000);
      res = await local.pickDirectory();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      toast('无法打开文件夹选择器：' + (e.message || e), 'error');
      return;
    }
    if (!res) {
      // 不支持 showDirectoryPicker：回退到隐藏的 <input webkitdirectory>
      els.dirInput.click();
      return;
    }
    addLocalFolder(res);
  }

  async function onDirInputChange() {
    if (!els.dirInput.files || !els.dirInput.files.length) return;
    toast('正在读取文件夹…（会逐个确认能不能播）', 'info', 6000);
    var res = await local.entriesFromDirFiles(els.dirInput.files);
    els.dirInput.value = '';
    addLocalFolder(res);
  }

  /**
   * 从“视频库”删除：列表/剧集整季删除（含所有分P/合集），并清理对应观看记录。
   * 单视频按 bvid/id 匹配；合集按 seriesKey 匹配。
   */
  function removeCustomVideo(cardId) {
    var list = store.get('customVideos') || [];
    var item = list.find(function (x) {
      return String(x.id || x.bvid || x.bv_id) === String(cardId);
    });
    if (!item) return;
    var scopeKey = item.seriesKey || (item.bvid ? 'b:' + item.bvid : 'id:' + item.id);
    var isSeries = !!item.seriesKey;
    confirmAction(
      '确定删除「' + esc(item.title || item.name || '未命名') + '」？' +
      (isSeries ? '<br>将删除整个列表（含所有分 P / 合集），不会遗漏。' : ''),
      function () { doRemoveCustomVideo(item, scopeKey); }
    );
  }

  function doRemoveCustomVideo(item, scopeKey, silent) {
    var isSeries = !!item.seriesKey;
    var list = store.get('customVideos') || [];
    if (item.kind === 'local') {
      // 本地文件夹列表：每个文件都有各自的句柄，要一起清掉
      if (item.isSeries && item.episodes && item.episodes.length) {
        item.episodes.forEach(function (ep) {
          try { local.removeEntry(ep); } catch (e) { /* ignore */ }
        });
      } else {
        local.removeEntry(item);
      }
    }
    var remain = list.filter(function (x) {
      var k = x.seriesKey || (x.bvid ? 'b:' + x.bvid : 'id:' + x.id);
      return k !== scopeKey;
    });
    // 清理对应的观看记录（整季），避免“已删除”却仍出现在继续学习
    var hist = (store.get('watchHistory') || []).filter(function (h) {
      if (isSeries && h.seriesKey === item.seriesKey) return false;
      if (item.bvid && h.bvid === item.bvid) return false;
      if (!item.bvid && h.key === item.id) return false;
      return true;
    });
    store.set({ customVideos: remain, watchHistory: hist });
    if (store.get('source') && store.get('source').kind === 'mine' && remain.length === 0) {
      store.set({ source: null });
    }
    if (!silent) toast('已删除' + (isSeries ? '整个列表' : '该视频'), 'success');
    if (state.currentView === 'dashboard') renderDashboard();
    else if (state.currentView === 'browse') {
      state.browse.items = remain.slice();
      renderBrowse();
    }
  }

  /** 从“继续学习”栏移除卡片：确认弹框内可勾选“同时清理历史记录” */
  function removeHistoryCard(hKey) {
    var list = store.get('watchHistory') || [];
    var h = list.find(function (x) { return x.key === hKey; });
    if (!h) return;
    // 与继续学习栏合并逻辑一致：系列按 seriesKey、单视频按 bvid、本地按 key
    var mergeKey = h.seriesKey || (h.bvid ? 'b:' + h.bvid : h.key);
    var isSeries = !!h.seriesKey;
    var title = isSeries ? (h.seriesTitle || h.title) : h.title;
    confirmAction(
      '确定移除「' + esc(title) + '」的继续学习卡片？' +
      (isSeries ? '<br>将移除整个系列的卡片，不会遗漏。' : '') +
      '<label class="confirm-check"><input type="checkbox" id="chkPurgeHistory"> 同时清理历史记录（不可恢复）</label>',
      function (purge) {
        var hidden = store.get('hiddenHistoryKeys') || [];
        hidden = hidden.filter(function (k) { return k !== mergeKey; });
        var hlist = list;
        if (purge) {
          // 彻底清理该视频/系列的所有历史记录
          hlist = hlist.filter(function (x) {
            return (x.seriesKey || (x.bvid ? 'b:' + x.bvid : x.key)) !== mergeKey;
          });
        } else {
          // 仅隐藏卡片，历史数据保留；之后重新观看会自动恢复卡片
          hidden = hidden.concat([mergeKey]);
        }
        store.set({ watchHistory: hlist, hiddenHistoryKeys: hidden });
        toast(purge ? '已移除卡片并清理历史记录' : '已移除卡片（历史记录已保留）', 'success');
        if (state.currentView === 'dashboard') renderDashboard();
        else if (state.currentView === 'browse' && state.browse && state.browse.kind === 'continue') {
          state.browse.items = mergedHistoryList();
          renderBrowse();
        }
      },
      function () {
        var el = document.getElementById('chkPurgeHistory');
        return !!(el && el.checked);
      }
    );
  }

  /** 从“收藏夹库”移除（确认后） */
  function removeStudyFolder(folderId) {
    var folders = store.get('studyFolders') || [];
    var f = folders.find(function (s) { return String(s.id) === String(folderId); });
    var name = (f && (f.title || f.name)) || '该收藏夹';
    confirmAction('确定从收藏夹库中移除「' + esc(name) + '」？', function () {
      var next = folders.filter(function (s) { return String(s.id) !== String(folderId); });
      store.set({ studyFolders: next });
      toast('已从收藏夹库移除', 'success');
      if (state.currentView === 'dashboard') renderDashboard();
      else if (state.currentView === 'browse') {
        state.browse.items = next.slice();
        renderBrowse();
      }
    });
  }

  /** 通用确认弹框；beforeClose 在关闭弹窗前调用，返回值会传给 onConfirm（用于读取表单选项） */
  function confirmAction(messageHtml, onConfirm, beforeClose) {
    openModal(
      '<div class="modal-head"><h2>确认操作</h2><button type="button" class="icon-btn" data-close aria-label="关闭">×</button></div>' +
      '<div class="modal-body">' +
        '<p>' + messageHtml + '</p>' +
        '<div class="row">' +
          '<button type="button" id="btnConfirmOk" class="btn danger">确定</button>' +
          '<button type="button" class="btn ghost" data-close>取消</button>' +
        '</div>' +
      '</div>'
    );
    bindClose();
    document.getElementById('btnConfirmOk').addEventListener('click', function () {
      var payload = beforeClose ? beforeClose() : undefined;
      closeModal();
      onConfirm(payload);
    });
  }

  /* ---------------- 设置弹窗（左侧栏位 + 右侧内容） ---------------- */
  var SETTINGS_TABS = [
    { key: 'login', label: '登录与授权' },
    { key: 'general', label: '外观' },
    { key: 'data', label: '数据' },
    { key: 'about', label: '关于' }
  ];

  function currentSettingsTab() {
    var k = store.get('settingsTab') || 'login';
    for (var i = 0; i < SETTINGS_TABS.length; i++) {
      if (SETTINGS_TABS[i].key === k) return k;
    }
    return 'login';
  }

  function showSettingsTab(key) {
    var panels = els.modalRoot.querySelectorAll('[data-settings-panel]');
    for (var i = 0; i < panels.length; i++) {
      panels[i].classList.toggle('active', panels[i].dataset.settingsPanel === key);
    }
    var items = els.modalRoot.querySelectorAll('[data-settings-tab]');
    for (var j = 0; j < items.length; j++) {
      items[j].classList.toggle('active', items[j].dataset.settingsTab === key);
    }
  }

  function openSettingsModal() {
    var login = store.get('login');
    var hasCookie = !!store.getCookie();
    var hasSid = !!store.get('sid');
    var theme = store.get('theme') || 'auto';
    var statusHtml;
    if (login) statusHtml = '<span class="ok">已登录 · ' + esc(login.uname) + '</span>';
    else if (hasCookie || hasSid) statusHtml = '<span class="warn">已保存凭据，但校验未通过（可能已过期）</span>';
    else statusHtml = '未登录';

    var oauthBtn = '';
    var oauthNote = '';
    if (state.backend && state.backend.oauthEnabled) {
      oauthBtn = '<button id="btnOAuth" type="button" class="btn ghost">使用 B 站 OAuth 登录</button>';
    } else {
      oauthNote =
        '<p class="muted small">OAuth 方式需在 B 站开放平台注册应用并配置环境变量（详见 README），未配置时不可用。</p>';
    }

    var guideBtn = '';
    if (state.backend && state.backend.ok) {
      guideBtn = '<button id="btnGuide" type="button" class="btn ghost">查看使用引导</button>';
    }

    var tab = currentSettingsTab();
    var navHtml = SETTINGS_TABS.map(function (t) {
      return '<button type="button" class="settings-nav-item' + (t.key === tab ? ' active' : '') +
        '" data-settings-tab="' + t.key + '">' + t.label + '</button>';
    }).join('');

    openModal(
      '<div class="modal-head"><h2>设置</h2><button type="button" class="icon-btn" data-close aria-label="关闭">×</button></div>' +
      '<div class="modal-body settings-body">' +
        '<nav class="settings-nav">' + navHtml + '</nav>' +
        '<div class="settings-panels">' +
        '<section class="settings-panel' + (tab === 'login' ? ' active' : '') + '" data-settings-panel="login">' +
          '<h3>登录与授权</h3>' +
          '<p class="muted">登录状态：' + statusHtml + '</p>' +
          '<label class="field-label" for="cookieInput">SESSDATA / Cookie（推荐）</label>' +
          '<input id="cookieInput" class="text-input" type="password" placeholder="粘贴 SESSDATA 或完整 Cookie" autocomplete="off">' +
          '<label class="check"><input id="persistCookie" type="checkbox" checked> 保存到本地浏览器。<b>Cookie 等同账号凭证，请仅在个人设备上使用。</b></label>' +
          '<div class="row">' +
            '<button id="btnQrLogin" type="button" class="btn ghost">扫码登录（推荐）</button>' +
            '<button id="btnSaveCookie" type="button" class="btn primary">保存并验证</button>' +
            '<button id="btnClearAuth" type="button" class="btn ghost danger">清除登录</button>' +
            oauthBtn +
          '</div>' +
          '<details class="help">' +
            '<summary>如何获取 SESSDATA？（仅当扫码登录不便时使用）</summary>' +
            '<p class="muted small">更推荐使用上方「扫码登录」：打开二维码、用 B 站 App 扫一下即可，无需手动复制。</p>' +
            '<ol class="steps">' +
              '<li>在浏览器中登录 <b>bilibili.com</b>；</li>' +
              '<li>按 <b>F12</b> 打开开发者工具 → <b>应用（Application）</b> → <b>Cookie</b> → 选中 <code>https://www.bilibili.com</code>；</li>' +
              '<li>找到 <b>SESSDATA</b>，复制它的值（也可以直接复制整段 Cookie 粘贴进来）；</li>' +
              '<li>粘贴到上方输入框 → 勾选是否保存 → 点击「保存并验证」。</li>' +
            '</ol>' +
          '</details>' +
          oauthNote +
        '</section>' +
        '<section class="settings-panel' + (tab === 'general' ? ' active' : '') + '" data-settings-panel="general">' +
          '<h3>外观</h3>' +
          '<label class="field-label" for="themeSelect">主题</label>' +
          '<select id="themeSelect" class="select">' +
            '<option value="auto"' + (theme === 'auto' ? ' selected' : '') + '>跟随系统</option>' +
            '<option value="light"' + (theme === 'light' ? ' selected' : '') + '>浅色</option>' +
            '<option value="dark"' + (theme === 'dark' ? ' selected' : '') + '>深色</option>' +
          '</select>' +
        '</section>' +
        '<section class="settings-panel' + (tab === 'data' ? ' active' : '') + '" data-settings-panel="data">' +
          '<h3>数据</h3>' +
          '<div class="row">' +
            '<button id="btnClearData" type="button" class="btn ghost danger">清除全部本地数据</button>' +
            '<button id="btnShutdown" type="button" class="btn ghost danger">停止本地服务</button>' +
            '<button id="btnRestoreBackup" type="button" class="btn ghost">从备份恢复</button>' +
          '</div>' +
          '<p class="muted small">清除本地数据不会影响 B 站账号；停止服务后，双击桌面快捷方式可重新启动。<br>' +
            '备份会自动保存在本机（%APPDATA%\\BiliNest\\state-backup.json）：换浏览器、换端口或清过浏览器数据后会自动取回；两边都有数据时以较新的一份为准（改动晚的一方胜出，不会用旧快照覆盖新数据）。「从备份恢复」可强制用备份覆盖当前数据。<br>' +
            '⚠️ 这个备份文件里是<b>明文</b>的登录凭据（SESSDATA），请不要分享、同步到网盘或上传；共用电脑上建议用完就清除。</p>' +
        '</section>' +
        '<section class="settings-panel' + (tab === 'about' ? ' active' : '') + '" data-settings-panel="about">' +
          '<h3>关于</h3>' +
          '<p class="muted small">BiliNest ' +
            (state.backend && state.backend.appVersion ? 'v' + state.backend.appVersion : '（版本未知：本地服务未连接，或仍在跑旧版）') +
            ' · <b>非官方</b>第三方开源项目，与哔哩哔哩无隶属、合作或授权关系，也不使用其商标与标识；仅供个人学习自用。<br>' +
            '不破解付费 / 会员内容，不绕过账号权限，不提供下载、批量抓取、去水印或地区限制绕过能力；凭据只存在本机，不会发给任何第三方。<br>' +
            '第三方客户端通常不符合平台的用户协议与 API 使用规范，账号风险由使用者自行承担。<br>播放器内核版本：' +
            (window.BiliNestPlayer && window.BiliNestPlayer.VERSION ? 'v' + window.BiliNestPlayer.VERSION : '未知') +
            '（若低于 v3，请强制刷新页面 Ctrl+F5 后重试）</p>' +
          /*
           * 版本更新：检查走本地服务代理 GitHub 的 release 接口（见 server.mjs 的
           * /api/update/check），所以前端不用碰跨域、也不需要 token。
           * 是 git 检出的话还能直接"拉取源码更新"；否则给安装包下载。
           */
          '<h3>更新</h3>' +
          '<div class="row update-row">' +
            '<button id="btnRunUpdate" type="button" class="btn primary">检查更新</button>' +
            '<label class="update-mode"><span class="muted small">检查方式</span>' +
              '<select id="updateMode" class="select">' +
                '<option value="auto"' + ((store.get('updateCheck') || 'auto') === 'auto' ? ' selected' : '') + '>自动（打开时）</option>' +
                '<option value="manual"' + (store.get('updateCheck') === 'manual' ? ' selected' : '') + '>仅手动</option>' +
              '</select>' +
            '</label>' +
          '</div>' +
          '<p id="updateStatus" class="muted small">点「检查更新」看看有没有新版本；有的话会问你要不要拉取并重启服务。</p>' +
          '<details id="updateNotesWrap" class="help" hidden><summary>这次更新了什么</summary><div id="updateNotes" class="update-notes"></div></details>' +
          '<div class="row">' + guideBtn + '</div>' +
        '</section>' +
        '</div>' +
      '</div>',
      { wide: true, cls: 'modal-settings' }
    );
    bindClose();
    bindSettingsEvents();
  }

  /* ---------------- 版本更新（设置 → 关于） ---------------- */

  function fmtMB(bytes) {
    return bytes ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : '';
  }

  function fmtDay(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  var updateCheckedOnce = false;
  var lastUpdate = null;        // 最近一次检查结果（打开设置时据此直接渲染，不用再等网络）

  /** 检查更新：manual=true 时绕过服务端缓存 */
  async function fetchUpdate(manual) {
    var res = await fetch('/api/update/check' + (manual ? '?force=1' : ''), { cache: 'no-store' });
    var d = await res.json();
    lastUpdate = d;
    return d;
  }

  /** 把检查结果画到设置面板上（面板没打开就只更新按钮上的小圆点） */
  function renderUpdateResult(d) {
    // 设置图标上的小圆点：自动检查发现新版本时提示，不打扰
    if (els.btnSettings) els.btnSettings.classList.toggle('has-update', !!(d && d.ok && d.hasUpdate));

    var status = document.getElementById('updateStatus');
    if (!status) return;
    var notesWrap = document.getElementById('updateNotesWrap');
    var notes = document.getElementById('updateNotes');
    var btn = document.getElementById('btnRunUpdate');
    if (notesWrap) notesWrap.hidden = true;
    if (btn) btn.textContent = '检查更新';

    if (!d || !d.ok) {
      status.textContent = '检查失败：' + ((d && d.message) || '未知错误') + '。可以稍后再试，或到 Releases 页面看看。';
      return;
    }
    if (!d.hasUpdate) {
      status.textContent = '已是最新版本 v' + d.current +
        (d.publishedAt ? '（最新版发布于 ' + fmtDay(d.publishedAt) + '）' : '') + '。';
      return;
    }
    status.textContent = '有新版本：v' + d.current + ' → v' + d.latest +
      (d.publishedAt ? '，发布于 ' + fmtDay(d.publishedAt) : '') + '。';
    if (btn) btn.textContent = '更新到 v' + d.latest;
    if (d.notes && notes && notesWrap) {
      notes.textContent = d.notes;
      notesWrap.hidden = false;
    }
  }

  /**
   * 拉取源码后等新服务起来（端口不变，起来就刷新页面，新前端一起生效）。
   *
   * 必须等"先掉下去、再起来"：旧进程还在应答时直接返回，页面会在旧服务上刷新一遍 ——
   * 看起来"更新成功"，其实版本一点没变（这个坑实测踩过）。
   * 所以要么亲眼看到一次请求失败，要么看到版本号真的变了。
   */
  async function waitForServerBack(prevVersion) {
    var deadline = Date.now() + 45000;
    var seenDown = false;
    await new Promise(function (r) { setTimeout(r, 700); });
    while (Date.now() < deadline) {
      var ok = false;
      var ver = '';
      try {
        var res = await fetch('/api/health', { cache: 'no-store' });
        if (res.ok) {
          var d = await res.json();
          ok = !!(d && d.app === 'bilinest');
          ver = (d && d.appVersion) || '';
        }
      } catch (e) { /* 服务不在了 */ }
      if (!ok) seenDown = true;
      else if (seenDown || (prevVersion && ver && ver !== prevVersion)) return true;
      await new Promise(function (r) { setTimeout(r, 400); });
    }
    return false;
  }

  /** 一键更新：git 检出 → 拉取 + 重启 + 自动刷新；安装包版 → 下载安装包 */
  async function runUpdate() {
    var status = document.getElementById('updateStatus');
    var btn = document.getElementById('btnRunUpdate');
    if (btn) btn.disabled = true;
    if (status) status.textContent = '正在检查更新…';
    var d;
    try {
      d = await fetchUpdate(true);
    } catch (e) {
      if (status) status.textContent = '检查更新失败：' + (e.message || '网络错误');
      if (btn) btn.disabled = false;
      return;
    }
    renderUpdateResult(d);
    if (btn) btn.disabled = false;
    if (!d || !d.ok) return;
    if (!d.hasUpdate) {
      toast('已是最新版本 v' + d.current, 'success');
      return;
    }

    var setup = (d.assets || []).find(function (a) { return /Setup\.exe$/i.test(a.name); });
    if (d.canGitPull) {
      // 源码版：拉取 + 重启 + 重新打开页面，全自动
      confirmAction(
        '发现新版本：v' + d.current + ' → <b>v' + d.latest + '</b>。<br>' +
        '<span class="muted small">将执行 git pull，然后重启本地服务并重新打开页面（约几秒，期间页面会短暂断开）。' +
        '本地有未提交的改动时会中止，不会动你的工作区。</span>',
        async function () {
          var st = document.getElementById('updateStatus');
          if (st) st.textContent = '正在拉取新代码并重启服务…';
          try {
            var res = await fetch('/api/update/apply', { method: 'POST' });
            var r = await res.json();
            if (!r.ok) {
              if (st) st.textContent = '更新失败：' + (r.message || '未知错误');
              toast('更新失败，已保持原状', 'error');
              return;
            }
            if (r.restarting === false) {
              if (st) st.textContent = '代码已更新，但自动重启没成功 —— 请关掉本地服务的窗口，再双击桌面快捷方式重启。';
              toast('已更新，请手动重启服务', 'info', 6000);
              return;
            }
            toast(r.changed ? '已拉取新版本，正在重启服务…' : '代码已是最新，正在重启服务…', 'info', 4000);
            var back = await waitForServerBack(d.current);
            if (back) location.reload();
            else if (st) st.textContent = '服务重启超时，请手动关闭服务窗口后重新双击快捷方式。';
          } catch (e) {
            if (st) st.textContent = '更新失败：' + (e.message || '网络错误') + '（服务可能正在重启，刷新页面试试）';
          }
        }
      );
      return;
    }

    if (setup) {
      // 安装包版：不做文件替换，交给安装程序（它会停掉旧服务、装完重启）
      confirmAction(
        '发现新版本：v' + d.current + ' → <b>v' + d.latest + '</b>。<br>' +
        '<span class="muted small">现在开始下载安装包（' + fmtMB(setup.size) + '）？下载完运行它即可完成更新 —— ' +
        '安装程序会自动停掉旧服务并重启，数据不会动。</span>',
        function () {
          window.open(setup.url, '_blank', 'noopener');
          var st = document.getElementById('updateStatus');
          if (st) st.textContent = '已开始下载安装包。运行它即可更新到 v' + d.latest + '（数据不受影响）。';
        }
      );
      return;
    }

    // 既不能拉取、也没有安装包（例如只有源码压缩包）：去 release 页面
    confirmAction(
      '发现新版本：v' + d.current + ' → <b>v' + d.latest + '</b>。<br>' +
      '<span class="muted small">打开下载页面手动更新？</span>',
      function () { window.open(d.htmlUrl, '_blank', 'noopener'); }
    );
  }

  /** 自动检查（打开页面时跑一次；服务端有 10 分钟缓存，代价很低） */
  async function autoCheckUpdate() {
    if ((store.get('updateCheck') || 'auto') === 'manual') return;
    try {
      renderUpdateResult(await fetchUpdate(false));
    } catch (e) { /* 自动检查失败就静默，别打扰 */ }
  }

  function bindSettingsEvents() {
    document.getElementById('btnQrLogin').addEventListener('click', openQrLoginModal);
    document.getElementById('btnSaveCookie').addEventListener('click', onSaveCookie);
    document.getElementById('btnClearAuth').addEventListener('click', onClearAuth);
    var oa = document.getElementById('btnOAuth');
    if (oa) oa.addEventListener('click', onOAuth);
    document.getElementById('themeSelect').addEventListener('change', function (e) {
      store.set({ theme: e.target.value });
      applyTheme();
    });
    document.getElementById('btnClearData').addEventListener('click', onClearData);
    var restoreBtn = document.getElementById('btnRestoreBackup');
    if (restoreBtn) restoreBtn.addEventListener('click', onRestoreBackup);
    var guideBtnEl = document.getElementById('btnGuide');
    if (guideBtnEl) guideBtnEl.addEventListener('click', openGuideModal);
    var shutdownBtn = document.getElementById('btnShutdown');
    if (shutdownBtn) shutdownBtn.addEventListener('click', onShutdown);
    var runUpdateBtn = document.getElementById('btnRunUpdate');
    if (runUpdateBtn) runUpdateBtn.addEventListener('click', runUpdate);
    var modeSelect = document.getElementById('updateMode');
    if (modeSelect) {
      modeSelect.addEventListener('change', function (e) {
        store.set({ updateCheck: e.target.value === 'manual' ? 'manual' : 'auto' });
        toast(e.target.value === 'manual' ? '只在点「检查更新」时检查' : '打开页面时自动检查是否有新版本', 'success');
      });
    }
    // 打开设置时把上次的结果画出来（没有结果就静默查一次）
    if (lastUpdate) renderUpdateResult(lastUpdate);
    else if (!updateCheckedOnce) { updateCheckedOnce = true; autoCheckUpdate(); }
    // 用户已经看到过提示：把设置图标上的小圆点撤掉
    if (els.btnSettings) els.btnSettings.classList.remove('has-update');
    // 左侧栏位切换
    var navItems = els.modalRoot.querySelectorAll('[data-settings-tab]');
    for (var i = 0; i < navItems.length; i++) {
      navItems[i].addEventListener('click', function () {
        var key = this.dataset.settingsTab;
        store.set({ settingsTab: key });
        showSettingsTab(key);
      });
    }
  }

  /* ---------------- 首次启动 / 使用引导 ---------------- */
  function openQrLoginModal() {
    if (!state.backend || !state.backend.ok) {
      toast('需要本地代理服务支持，请先通过桌面快捷方式启动 BiliNest', 'error');
      return;
    }
    openModal(
      '<div class="modal-head"><h2>扫码登录 B 站</h2><button type="button" class="icon-btn" data-close aria-label="关闭">×</button></div>' +
      '<div class="modal-body">' +
        '<div class="qr-box">' +
          '<canvas id="qrCanvas" width="280" height="280"></canvas>' +
          '<div id="qrStatus" class="qr-status">正在生成二维码…</div>' +
        '</div>' +
        '<div class="row qr-actions">' +
          '<button id="btnQrRefresh" type="button" class="btn ghost">刷新二维码</button>' +
          '<label class="check"><input id="qrPersist" type="checkbox" checked> 保存登录状态（下次自动登录）</label>' +
        '</div>' +
        '<details class="help">' +
          '<summary>手机不便扫码？</summary>' +
          '<p class="muted small">在<b>已登录哔哩哔哩</b>的手机浏览器中打开下面的链接，并点击「确认登录」即可：</p>' +
          '<p class="qr-link-wrap"><a id="qrLink" href="#" target="_blank" rel="noopener">正在生成链接…</a></p>' +
        '</details>' +
        '<p class="muted small">扫码登录不会泄露密码；成功后无需再手动粘贴 Cookie。</p>' +
      '</div>'
    );
    bindClose();
    document.getElementById('btnQrRefresh').addEventListener('click', startQrLogin);
    startQrLogin();
  }

  /** 请求生成二维码并渲染到 canvas，然后开始轮询 */
  async function startQrLogin() {
    clearInterval(qrPollTimer);
    qrPollTimer = null;
    var canvas = document.getElementById('qrCanvas');
    var status = document.getElementById('qrStatus');
    var link = document.getElementById('qrLink');
    if (!canvas || !status) return; // 弹窗已关闭
    var g = canvas.getContext('2d');
    status.textContent = '正在生成二维码…';
    status.dataset.state = '';
    link.href = '#';
    link.textContent = '正在生成链接…';
    try {
      var data = await fetchQrGenerate();
      if (typeof window.qrcode !== 'function') throw new Error('二维码库未加载');
      var qr = window.qrcode(0, 'M');
      qr.addData(data.url);
      qr.make();
      var count = qr.getModuleCount();
      var cell = Math.max(2, Math.floor(280 / (count + 8)));
      var size = cell * (count + 8);
      canvas.width = size;
      canvas.height = size;
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, size, size);
      g.fillStyle = '#000000';
      for (var r = 0; r < count; r++) {
        for (var c = 0; c < count; c++) {
          if (qr.isDark(r, c)) g.fillRect((c + 4) * cell, (r + 4) * cell, cell, cell);
        }
      }
      status.textContent = '请用 B 站 App 扫码，并在手机上点击「确认登录」';
      status.dataset.state = 'wait';
      link.href = data.url;
      link.textContent = data.url;
      qrPollTimer = setInterval(function () { pollQrLogin(data.qrcode_key); }, 2500);
    } catch (e) {
      status.textContent = '生成失败：' + e.message;
      status.dataset.state = 'error';
    }
  }

  async function fetchQrGenerate() {
    var base = state.backend.base || '';
    var res = await fetch(base + '/api/qr/generate');
    var json = await res.json();
    if (!json || json.code !== 0 || !json.data) {
      throw new Error((json && json.message) || '二维码生成失败');
    }
    return json.data;
  }

  async function pollQrLogin(key) {
    var status = document.getElementById('qrStatus');
    if (!status) {
      clearInterval(qrPollTimer);
      qrPollTimer = null;
      return;
    }
    try {
      var base = state.backend.base || '';
      var res = await fetch(base + '/api/qr/poll?key=' + encodeURIComponent(key));
      var json = await res.json();
      if (json.code === 0 && json.cookie) {
        // 登录成功：保存会话 Cookie（复用现有登录体系）
        clearInterval(qrPollTimer);
        qrPollTimer = null;
        var persist = true;
        var cb = document.getElementById('qrPersist');
        if (cb) persist = cb.checked;
        store.setCookie(json.cookie, persist);
        status.textContent = '登录成功！';
        status.dataset.state = 'ok';
        var info = await checkLogin(true);
        if (info) toast('扫码登录成功：' + info.uname, 'success');
        closeModal();
        // 尽力把 B 站会话同步进浏览器（供嵌入播放器的高画质/弹幕使用）
        tryBrowserCookieSync(key);
        loadDashboard();
      } else if (json.code === 86090) {
        status.textContent = '已扫码，请在手机上点击「确认登录」';
        status.dataset.state = 'scan';
      } else if (json.code === 86101) {
        status.textContent = '请用 B 站 App 扫码，并在手机上点击「确认登录」';
        status.dataset.state = 'wait';
      } else if (json.code === 86038 || json.code === 86039 || json.code === 86058) {
        clearInterval(qrPollTimer);
        qrPollTimer = null;
        status.textContent = '二维码已过期，请点击「刷新二维码」';
        status.dataset.state = 'error';
      } else {
        status.textContent = '扫码状态异常（' + json.code + '）' + (json.message ? '：' + json.message : '');
        status.dataset.state = 'error';
      }
    } catch (e) {
      /* 网络抖动时忽略，等待下一次轮询 */
    }
  }

  /**
   * 让浏览器直接访问一次官方轮询接口，尝试把 B 站会话 Cookie 写入浏览器。
   * 说明：嵌入播放器使用浏览器自身的 B 站登录态；若浏览器开启了第三方
   * Cookie 拦截，此同步可能不生效，此时需要先在浏览器中登录一次 bilibili.com。
   * 使用隐藏 iframe（后台执行，不影响界面）。
   */
  function tryBrowserCookieSync(key) {
    try {
      var f = document.createElement('iframe');
      f.style.cssText =
        'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
      f.src =
        'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' +
        encodeURIComponent(key);
      document.body.appendChild(f);
      setTimeout(function () { f.remove(); }, 5000);
    } catch (e) {
      /* 同步失败不影响应用内登录 */
    }
  }

  function openGuideModal() {
    openModal(
      '<div class="modal-head"><h2>使用引导</h2><button type="button" class="icon-btn" data-close aria-label="关闭">×</button></div>' +
      '<div class="modal-body">' +
        '<p class="muted">首次使用请先启动本地代理：Windows 双击桌面上的 <b>BiliNest</b> 快捷方式（或项目目录里的 <code>launcher.vbs</code>），macOS / Linux 运行 <code>./start.sh</code>（或通用 <code>npm start</code>），否则收藏夹与 B 站接口不可用。详见仓库 README「快速开始」。</p>' +
        '<section><h3>① 登录 B 站账号</h3>' +
          '<ol class="steps">' +
            '<li>点击右上角「设置」→ <b>扫码登录（推荐）</b>；</li>' +
            '<li>用 B 站 App 扫描页面上的二维码，在手机上点击「确认登录」；</li>' +
            '<li>不方便扫码时，也可以在「设置」中手动粘贴 SESSDATA。</li>' +
          '</ol>' +
          '<p class="muted small">登录后即可读取收藏夹；不登录也能添加单个视频或本地视频。</p>' +
        '</section>' +
        '<section><h3>② 选择学习内容</h3>' +
          '<ol class="steps">' +
            '<li>点击右上角「内容源」，选择收藏夹：<b>设为内容源</b> 只显示它，<b>加入学习</b> 会显示在收藏夹库；</li>' +
            '<li>进入收藏夹后，点视频卡片上的 <b>+</b> 可把其中单个视频加入学习列表；内容源搜索到的收藏夹视频也能直接「加入学习」；</li>' +
            '<li>也可以粘贴 B 站视频链接 / BV 号添加单个视频，或点「选择本地视频」；</li>' +
            '<li>给视频和收藏夹点星星打分（5 星最重要，优先显示），排序支持：添加时间 / 发布时间 / 星级 / 播放量。</li>' +
          '</ol>' +
        '</section>' +
        '<section><h3>③ 主页标签页</h3>' +
          '<ol class="steps">' +
            '<li>主页分四个系统标签：<b>继续学习</b>（有观看记录时置顶，点击自动从上次位置继续）、<b>视频库</b>、<b>收藏夹库</b>、<b>学习 UP主</b>；每个标签「展开全部」可翻页 / 搜索 / 排序。</li>' +
            '<li>标签栏末尾的 <b>＋</b> 可以新建<b>自定义标签页</b>（例如「动画课程」）：双击标签改名，按住标签左右拖动可排序，标签再多也不会挤出屏幕（横向滚动）。</li>' +
            '<li>自定义标签页里的「＋ 添加内容」能从 <b>源收藏夹 / 视频库 / 收藏夹库 / 学习 UP主</b> 里挑内容（都带封面便于辨认）；卡片右下角 ✕ 移除时可选是否连库内一并删除。</li>' +
          '</ol>' +
        '</section>' +
        '<section><h3>④ 播放器小技巧</h3>' +
          '<ul class="steps">' +
            '<li>双击画面全屏 / 退出全屏，单击播放 / 暂停，鼠标滚轮调音量；</li>' +
            '<li>画质在页面内切换，不跳转 B 站官网；弹幕只显示、不能发送；</li>' +
            '<li>字幕默认关闭，点「字幕」开启；旁边的「Aa」里能选字号（小/中/大/特大）和位置（贴底/中间/最高），选完记住；</li>' +
            '<li>选集自动定位到当前集；支持上一集 / 下一集；播完自动连播下一集（5 秒倒计时）或「重温一遍」；</li>' +
            '<li>点视频下方的 UP 名字可直接打开其 B 站主页；观看进度自动记录，随时可续播。</li>' +
          '</ul>' +
        '</section>' +
        '<section><h3>⑤ 免责与隐私</h3>' +
          '<ul class="faq">' +
            '<li>BiliNest 是<b>非官方</b>第三方开源项目，与哔哩哔哩没有隶属、合作或授权关系，也不使用其商标与标识；仅供个人学习自用。</li>' +
            '<li>不破解付费 / 会员内容，不绕过账号权限，不提供下载、批量抓取、去水印或地区限制绕过能力；请求只发往本机代理。</li>' +
            '<li>登录凭据只存在你这台电脑上，不会发给任何第三方；但备份文件是<b>明文</b>，请不要分享或同步 <code>%APPDATA%\\BiliNest</code> 目录。</li>' +
            '<li>第三方客户端通常不符合平台的用户协议与 API 使用规范，请自行判断是否使用，账号风险由使用者承担。</li>' +
          '</ul>' +
        '</section>' +
        '<section><h3>常见问题</h3>' +
          '<ul class="faq">' +
            '<li><b>提示“已切换官方播放器”？</b> 说明播放地址服务暂时不可用（多为网络或风控），已自动降级；稍后可重试。</li>' +
            '<li><b>提示 412 或频繁失败？</b> 属于 B 站风控，请稍后再试，避免短时间内反复刷新。</li>' +
            '<li><b>字幕按钮置灰 / 没有字幕？</b> 说明该视频没有 CC 字幕，或字幕加载失败；换一集或刷新页面重试。</li>' +
            '<li><b>想用 OAuth 登录？</b> 需自行在 B 站开放平台注册应用并配置环境变量，见 README。</li>' +
            '<li><b>数据存在哪里？</b> 保存在本机浏览器里，同时会自动备份到 <code>%APPDATA%\\BiliNest\\state-backup.json</code>：换浏览器、换端口或清过浏览器数据后打开会自动取回，两边都有数据时以较新的一份为准；「设置 → 数据」里可一键清除或手动恢复。</li>' +
          '</ul>' +
        '</section>' +
        '<div class="row guide-actions">' +
          '<button id="btnGuideOk" type="button" class="btn primary">开始使用</button>' +
          '<label class="check"><input id="guideNoMore" type="checkbox" checked> 下次启动不再显示</label>' +
        '</div>' +
      '</div>'
    );
    bindClose();
    document.getElementById('btnGuideOk').addEventListener('click', function () {
      store.set({ guideSeen: document.getElementById('guideNoMore').checked });
      closeModal();
    });
  }

  async function onShutdown() {
    if (!window.confirm('确定停止本地 BiliNest 服务吗？停止后请双击桌面快捷方式重新启动。')) return;
    var base = state.backend && state.backend.base ? state.backend.base : '';
    try {
      await fetch(base + '/api/shutdown');
    } catch (e) {
      /* 服务可能已经停止 */
    }
    closeModal();
    toast('本地服务已停止，页面已不可用');
  }

  /** 从用户输入中提取 SESSDATA 等关键 Cookie（只保留必要字段） */
  function parseCookie(raw) {
    var parts = String(raw).split(/[;\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
    var pairs = {};
    for (var i = 0; i < parts.length; i++) {
      var idx = parts[i].indexOf('=');
      if (idx > 0) pairs[parts[i].slice(0, idx).trim()] = parts[i].slice(idx + 1).trim();
    }
    // 用户可能只粘贴了 SESSDATA 本体（不含等号的单串）
    if (!pairs.SESSDATA && !String(raw).includes('=')) pairs.SESSDATA = String(raw).trim();
    if (!pairs.SESSDATA) return null;
    var keep = ['SESSDATA', 'buvid3', 'buvid4', 'DedeUserID', 'DedeUserID__ckMd5', 'bili_jct'];
    var out = [];
    keep.forEach(function (k) { if (pairs[k]) out.push(k + '=' + pairs[k]); });
    return out.join('; ');
  }

  async function onSaveCookie() {
    var input = document.getElementById('cookieInput');
    var persist = document.getElementById('persistCookie').checked;
    var parsed = parseCookie(input.value);
    if (!parsed) {
      toast('未能从输入中识别出 SESSDATA', 'error');
      return;
    }
    store.setCookie(parsed, persist);
    input.value = '';
    var info = await checkLogin(true);
    if (info) toast('登录成功：' + info.uname, 'success');
    else toast('登录校验失败，请检查 Cookie 是否完整有效', 'error');
    openSettingsModal();
  }

  function onClearAuth() {
    store.clearCookie();
    store.set({ sid: null, login: null });
    closeModal();
    loadDashboard();
    toast('已清除登录凭据');
  }

  function onOAuth() {
    var base = state.backend ? state.backend.base : '';
    window.open(base + '/api/oauth/login', 'bilinest-oauth', 'width=560,height=680,popup=yes');
  }

  async function onClearData() {
    if (!window.confirm('确定清除全部本地数据吗？将移除登录凭据、收藏夹选择与自定义视频列表。')) return;
    var items = store.get('customVideos') || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'local') {
        try { await local.removeEntry(items[i]); } catch (e) { /* ignore */ }
      }
    }
    state.folders = [];
    state.videoPages.clear();
    state.videos = [];
    store.clearAll();
    closeModal();
    await loadDashboard();
    toast('已清除全部本地数据');
  }

  /** 设置 →「从备份恢复」：用服务端保存的备份覆盖本地 */
  async function onRestoreBackup() {
    if (!window.confirm('用本机保存的备份覆盖当前数据吗？页面会刷新一次。')) return;
    var ok = await store.restoreFromBackup();
    if (!ok) {
      toast('没有可用的备份（或本地服务未运行）', 'error');
      return;
    }
    location.reload();
  }

  /* ---------------- 弹窗 / Toast 通用 ---------------- */
  function openModal(html, opts) {
    opts = opts || {};
    els.modalRoot.innerHTML =
      '<div class="overlay"><div class="modal' + (opts.wide ? ' wide' : '') + (opts.cls ? ' ' + opts.cls : '') + '">' +
      html + '</div></div>';
  }

  function bindClose() {
    var overlay = els.modalRoot.firstElementChild;
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) closeModal();
    });
    var closes = overlay.querySelectorAll('[data-close]');
    for (var i = 0; i < closes.length; i++) {
      closes[i].addEventListener('click', closeModal);
    }
  }

  function closeModal() {
    clearInterval(qrPollTimer);
    qrPollTimer = null;
    // 退场要和进场对称：先打上 data-closing 让遮罩与弹窗一起反向补间，
    // 等过渡结束（或兜底超时）再真正移除节点。以前直接清空 innerHTML，
    // 弹窗是"啪"地消失的——这是最刺眼的一处观感问题。
    var overlay = els.modalRoot.firstElementChild;
    if (!overlay) return;
    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      els.modalRoot.innerHTML = '';
    };
    overlay.setAttribute('data-closing', '');
    overlay.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 300);   // 兜底：减弱动效模式下可能没有过渡事件
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    els.btnTheme.addEventListener('click', function () {
      store.set({ theme: effectiveTheme() === 'dark' ? 'light' : 'dark' });
      applyTheme();
    });
    els.btnSettings.addEventListener('click', openSettingsModal);
    els.btnSource.addEventListener('click', openSourceModal);
    els.btnHome.addEventListener('click', loadDashboard);
    els.btnHome.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        loadDashboard();
      }
    });
    els.btnBackHome.addEventListener('click', function () {
      // 从「添加内容 → 源收藏夹」钻进收藏夹时，"上一级"是那个选择器而不是首页：
      // 回到自定义标签页并**把选择器原样打开**（分区 / 搜索词 / 勾选都还在），
      // 用户可以接着挑别的收藏夹或切到视频库/UP主，不用从头点一遍。
      var ctxTabId = state.pendingTabId;
      loadDashboard();                       // showView('dashboard') 会清掉 pendingTabId
      if (ctxTabId) openContentPicker(ctxTabId, true);
    });
    els.btnBack.addEventListener('click', function () {
      if (state.prevView === 'folder') {
        showView('folder');
      } else if (state.prevView === 'browse') {
        showView('browse');
        renderBrowse();
      } else {
        showView('dashboard');
        renderDashboard();
      }
      // 回到列表时停在原来的位置（进播放页之前看到哪儿，回来还是那儿）
      restoreListScroll();
    });
    els.btnRetryBackend.addEventListener('click', onRetryBackend);

    els.grid.addEventListener('click', function (e) {
      var action = e.target.closest('#btnEmptyAction');
      if (action) {
        if (action.textContent.indexOf('设置') > -1) openSettingsModal();
        else openSourceModal();
        return;
      }
      var addBtn = e.target.closest('[data-video-add]');
      if (addBtn) {
        if (!addBtn.classList.contains('added')) addFolderVideoToStudy(addBtn.dataset.videoAdd);
        return;
      }
      var addTabBtn = e.target.closest('[data-video-add-tab]');
      if (addTabBtn) {
        e.stopPropagation();
        if (state.pendingTabId) addVideoToTab(addTabBtn.dataset.videoAddTab, state.pendingTabId);
        return;
      }
      var pickTabBtn = e.target.closest('[data-video-pick-tab]');
      if (pickTabBtn) {
        e.stopPropagation();
        openTabChooser(pickTabBtn.dataset.videoPickTab, pickTabBtn);
        return;
      }
      var card = e.target.closest('.card');
      if (!card) return;
      var v = state.videos.find(function (x) {
        return String(x.id || x.bvid || x.bv_id) === String(card.dataset.id);
      });
      if (v) playVideo(v, v.kind === 'local' ? 'local' : (v.kind === 'bili' ? 'mine' : 'folder'));
    });

    // 主页（仪表盘）委托：继续学习 / 星级 / 收藏夹卡片 / 移除
    els.dashboard.addEventListener('click', onDashboardClick);
    // 双击自定义标签 → 内联重命名
    els.dashboard.addEventListener('dblclick', function (e) {
      var tabBtn = e.target.closest('.dash-tab.custom[data-tab-custom]');
      if (!tabBtn) return;
      if (e.target.closest('.dash-tab-more')) return;
      e.preventDefault();
      startTabRename(tabBtn.dataset.tabCustom);
    });
    // 自定义标签页：按住拖动排序（指针实现，见 beginTabDrag 一带的说明）
    els.dashboard.addEventListener('pointerdown', onTabPointerDown);
    window.addEventListener('pointermove', onTabPointerMove);
    window.addEventListener('pointerup', onTabPointerUp);
    window.addEventListener('pointercancel', onTabPointerUp);
    window.addEventListener('keydown', onTabDragKey);
    // 拖拽后的那次"补发 click"在捕获阶段丢掉，别让它落到标签页的切换逻辑上
    els.dashboard.addEventListener('click', function (e) {
      if (!tabDragEndedAt || Date.now() - tabDragEndedAt > 400) return;
      tabDragEndedAt = 0;
      if (!e.target || !e.target.closest || !e.target.closest('.dash-tab')) return;
      e.stopPropagation();
      e.preventDefault();
    }, true);
    window.addEventListener('resize', syncTabsScroll);
    // 标签栏：滚轮上下滚 → 横向滚动（标签多了才需要）
    els.dashboard.addEventListener('wheel', function (e) {
      var sc = e.target.closest('.dash-tabs-scroll');
      if (!sc || sc.scrollWidth <= sc.clientWidth) return;
      var delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!delta) return;
      e.preventDefault();
      sc.scrollLeft += delta;
    }, { passive: false });
    els.dashboard.addEventListener('input', function (e) {
      if (e.target && e.target.id === 'dashSearch') {
        var custom = findCustomTab(state.activeDashTab);
        var wrap = els.dashboard.querySelector('#dashContent');
        if (custom) {
          state.tabQuery[custom.id] = e.target.value;
          if (wrap) wrap.innerHTML = renderCustomTab(custom);
        } else {
          state.dashQuery = e.target.value;
          if (wrap) wrap.innerHTML = renderAddedVideosSection();
        }
        // 结果数写在大标题下面 —— 输入时它也该跟着动
        var subEl = els.dashboard.querySelector('.dash-page-sub');
        if (subEl) subEl.textContent = dashHeadSubText(state.activeDashTab, custom);
      }
    });
    els.dashboard.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'dashSort') {
        store.set({ sort: e.target.value });
        renderDashboard();
      }
    });

    // 二级浏览页：搜索 / 排序 / 翻页 / 返回 / 点击
    els.browseSearch.addEventListener('input', function () {
      if (!state.browse) return;
      state.browse.query = this.value;
      state.browse.page = 1;
      renderBrowse();
    });
    els.browseSort.addEventListener('change', function () {
      if (!state.browse) return;
      state.browse.sort = this.value;
      state.browse.page = 1;
      renderBrowse();
    });
    els.btnBrowsePrev.addEventListener('click', function () {
      if (state.browse && state.browse.page > 1) {
        state.browse.page--;
        renderBrowse();
      }
    });
    els.btnBrowseNext.addEventListener('click', function () {
      if (state.browse) {
        state.browse.page++;
        renderBrowse();
      }
    });
    els.btnBrowseBack.addEventListener('click', function () {
      var back = state.prevView || 'dashboard';
      showView(back);
      if (back === 'dashboard') renderDashboard();
    });
    els.browseGrid.addEventListener('click', onBrowseClick);

    // 收藏夹视图内搜索
    els.folderSearch.addEventListener('input', function () {
      state.folderQuery = this.value;
      renderGrid();
    });

    // 观看进度记录（节流保存；暂停/结束/离开页面时立即保存）
    // 播放器内核（ArtPlayer）由 player.js 管理，进度事件通过自定义事件转发
    window.addEventListener('bilinest-timeupdate', function () {
      sampleWatchTime();          // 先记下"这一小段真的看了多久"，再存进度
      saveProgressNow(false);
    });
    window.addEventListener('bilinest-pause', function () { saveProgressNow(true); });
    window.addEventListener('bilinest-ended', markFinished);
    window.addEventListener('beforeunload', function () { saveProgressNow(true); });
    // B 站视频续播成功提示（由 player.js 触发）
    window.addEventListener('bilinest-resumed', function (e) {
      if (e.detail && e.detail.seconds) {
        toast('已从 ' + fmtDuration(e.detail.seconds) + ' 继续播放');
      }
    });

    els.grid.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var card = e.target.closest('.card');
      if (!card) return;
      e.preventDefault();
      card.click();
    });

    els.sortSelect.addEventListener('change', function (e) {
      store.set({ sort: e.target.value });
      renderGrid();
    });
    window.addEventListener('resize', sizeEpisodePanel);
    // 标签指示条是量出来的，窗口尺寸变化（含 720px 断点）后要重新对齐
    window.addEventListener('resize', syncTabIndicator);

    // 顶栏：滚动时才浮现分隔线。
    // 常驻的 1px 硬线会把「浮在内容之上的玻璃」说成"一个固定的条"；
    // 内容真的滑到玻璃下面了，才需要那条线来分离（Apple §12 滚动边缘效果）。
    var topbarEl = document.querySelector('.topbar');
    if (topbarEl) {
      var syncTopbar = function () {
        topbarEl.classList.toggle('scrolled', window.scrollY > 4);
      };
      syncTopbar();
      window.addEventListener('scroll', syncTopbar, { passive: true });
    }
    els.btnLoadMore.addEventListener('click', loadMore);
    els.episodeList.addEventListener('click', onEpisodeClick);
    els.fileInput.addEventListener('change', onFileInputChange);
    els.dirInput.addEventListener('change', onDirInputChange);
    bindCardMenus();

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && els.modalRoot.innerHTML) closeModal();
    });

    // OAuth 弹窗通过 postMessage 回传会话 id
    window.addEventListener('message', onOAuthMessage);
  }

  /** 主页（仪表盘）点击委托 */
  function onDashboardClick(e) {
    // 新建标签页（标签栏末尾的 ＋）
    var newTabBtn = e.target.closest('[data-tab-new]');
    if (newTabBtn) {
      createCustomTab();
      return;
    }
    // 自定义标签页的「⋯」菜单
    var tabMenuBtn = e.target.closest('[data-tab-menu]');
    if (tabMenuBtn) {
      e.stopPropagation();
      openTabMenu(tabMenuBtn.dataset.tabMenu, tabMenuBtn);
      return;
    }
    // 标签页切换
    var tabBtn = e.target.closest('[data-dash-tab]');
    if (tabBtn) {
      var tabKey = tabBtn.dataset.dashTab;
      // 双击自定义标签 → 改名。第一次点击已经重渲染过标签栏、换掉了节点，
      // 所以这里用 click 的 detail 兜住第二次点击（纯 dblclick 事件会丢）。
      if (e.detail >= 2 && tabBtn.classList.contains('custom') && !e.target.closest('.dash-tab-more')) {
        e.preventDefault();
        startTabRename(tabBtn.dataset.tabCustom);
        return;
      }
      // 已经在这个标签页：不再重渲染，否则第二次点击落在新节点上、双击事件丢失
      if (String(state.activeDashTab) === String(tabKey)) return;
      state.activeDashTab = tabKey;
      store.set({ activeDashTab: tabKey });
      renderDashboard();
      return;
    }
    var histRm = e.target.closest('[data-history-remove]');
    if (histRm) {
      e.stopPropagation();
      removeHistoryCard(histRm.dataset.historyRemove);
      return;
    }
    // 卡片右上角「⋯」菜单（重命名 / 恢复原名 / 删除都在里面）
    var menuBtn = e.target.closest('[data-card-menu]');
    if (menuBtn) {
      e.stopPropagation();
      openCardMenu(menuBtn, menuBtn.dataset.cardMenuKind, menuBtn.dataset.cardMenu,
        menuBtn.dataset.tabId ? { tabId: menuBtn.dataset.tabId, tabKind: menuBtn.dataset.tabKind } : null);
      return;
    }
    var rmBtn = e.target.closest('[data-card-remove]');
    if (rmBtn) {
      e.stopPropagation();
      // 收藏夹库卡片 → 移除收藏夹；其余 → 从视频库删除
      if (rmBtn.closest('.folder-card')) removeStudyFolder(rmBtn.dataset.cardRemove);
      else removeCustomVideo(rmBtn.dataset.cardRemove);
      return;
    }
    var upRm = e.target.closest('[data-up-remove]');
    if (upRm) {
      e.stopPropagation();
      removeStudyUp(upRm.dataset.upRemove);
      return;
    }
    // 自定义标签页内卡片 → 只从本页移除
    var tabRm = e.target.closest('[data-tab-remove]');
    if (tabRm) {
      e.stopPropagation();
      removeFromTab(tabRm.dataset.tabId, tabRm.dataset.tabKind, tabRm.dataset.tabRemove);
      return;
    }
    // 「继续学习」标题行里的学习记录入口
    var studyOpen = e.target.closest('[data-study-open]');
    if (studyOpen) {
      openStudySheet();
      return;
    }
    // 自定义标签页「＋ 添加内容」
    var tabAdd = e.target.closest('[data-tab-add]');
    if (tabAdd) {
      openContentPicker(tabAdd.dataset.tabAdd);
      return;
    }
    var more = e.target.closest('[data-browse]');
    if (more) {
      openBrowse(more.dataset.browse);
      return;
    }
    var action = e.target.closest('#btnEmptyAction');
    if (action) {
      openSourceModal();
      return;
    }
    var emptyAddUp = e.target.closest('#btnEmptyAddUp');
    if (emptyAddUp) {
      openAddUpModal();
      return;
    }
    // 星级
    var star = e.target.closest('.stars .star');
    if (star) {
      var wrap = star.closest('.stars');
      setStars(wrap.dataset.scope, wrap.dataset.key, parseInt(star.dataset.val, 10));
      return;
    }
    // UP主 卡片 → 跳转 B站主页
    var upCard = e.target.closest('.up-card[data-up-mid]');
    if (upCard && !upCard.classList.contains('up-add-card')) {
      window.open('https://space.bilibili.com/' + encodeURIComponent(upCard.dataset.upMid), '_blank');
      return;
    }
    // 继续学习
    var hist = e.target.closest('[data-history]');
    if (hist) {
      var entry = (store.get('watchHistory') || []).find(function (h) { return h.key === hist.dataset.history; });
      if (entry) playHistoryEntry(entry);
      return;
    }
    // 收藏夹库卡片
    var fcard = e.target.closest('[data-folder]');
    if (fcard) {
      openFolder(fcard.dataset.folder);
      return;
    }
   // 视频库卡片
    var vcard = e.target.closest('.grid .card[data-id]');
    if (vcard) {
      var v = (store.get('customVideos') || []).find(function (x) {
        return String(x.id || x.bvid || x.bv_id) === String(vcard.dataset.id);
      });
      if (v) playVideo(v, v.kind === 'local' ? 'local' : 'mine');
      return;
    }
    // 添加 UP主 按钮
    var addUpBtn = e.target.closest('#btnAddUp');
    if (addUpBtn) {
      openAddUpModal();
      return;
    }
  }

  async function onRetryBackend() {
    toast('正在检测本地代理…');
    state.backend = await api.init();
    if (state.backend.ok) {
      els.backendBanner.hidden = true;
      await checkLogin();
      await loadDashboard();
      toast('本地代理已连接', 'success');
    } else {
      toast('仍未检测到本地代理，请先运行 npm start', 'error');
    }
  }

  function onOAuthMessage(e) {
    var data = e.data;
    if (!data || data.type !== 'bilinest-oauth' || !data.sid) return;
    var expected = state.backend && state.backend.base ? state.backend.base : location.origin;
    if (expected && expected !== 'null' && e.origin !== expected) {
      toast('OAuth 回调来源异常，已忽略', 'error');
      return;
    }
    store.set({ sid: data.sid });
    closeModal();
    checkLogin(true).then(function (info) {
      if (info) {
        toast('OAuth 登录成功：' + info.uname, 'success');
        loadDashboard();
      }
    });
  }

  async function loadMore() {
    if (!state.activeFolder || state.loading) return;
    state.loading = true;
    els.btnLoadMore.disabled = true;
    els.btnLoadMore.textContent = '加载中…';
    try {
      var next = (state.pn || 1) + 1;
      var key = state.activeFolder.id + ':' + next;
      var cached = state.videoPages.get(key);
      if (!cached || Date.now() - cached.at > 5 * 60 * 1000) {
        cached = await api.folderVideos(state.activeFolder.id, next, creds());
        cached.at = Date.now();
        state.videoPages.set(key, cached);
      }
      state.pn = next;
      state.videos = state.videos.concat(
        (cached.medias || []).filter(function (m) {
          return !m.type || m.type === 2;
        })
      );
      state.hasMore = !!cached.hasMore;
      renderGrid();
    } catch (e) {
      toast('加载更多失败：' + e.message, 'error');
    } finally {
      state.loading = false;
      els.btnLoadMore.disabled = false;
      els.btnLoadMore.textContent = '加载更多';
    }
  }

  function onEpisodeClick(e) {
    var row = e.target.closest('[data-ep]');
    if (!row) return;
    playEpisodeAt(Number(row.dataset.ep));
  }

  async function onFileInputChange() {
    if (!els.fileInput.files || !els.fileInput.files.length) return;
    var entries = await local.entriesFromFiles(els.fileInput.files);
    els.fileInput.value = '';
    addLocalEntries(entries);
  }

  /* ---------------- 选集悬浮完整名称提示 ---------------- */
  // 选集列表里长标题会被省略号截断；悬浮时在旁边弹一个小标签显示完整集名。
  // 标签挂在 document.body 上（portal 方式），避免被选集面板的 overflow 裁剪。
  var epTooltipEl = null;

  function getEpTooltip() {
    if (!epTooltipEl) {
      epTooltipEl = document.createElement('div');
      epTooltipEl.className = 'bilinest-ep-tooltip';
      epTooltipEl.hidden = true;
      document.body.appendChild(epTooltipEl);
    }
    return epTooltipEl;
  }

  /** 在悬浮的选集行旁边显示完整集名（优先放右侧，不挡播放画面；放不下再放左侧） */
  function showEpisodeTooltip(row) {
    var title = String(row.getAttribute('data-title') || '').trim();
    if (!title) return;
    var tip = getEpTooltip();
    tip.textContent = title;
    tip.hidden = false;
    // 先放到屏幕外量出实际宽高，再按空间计算最终位置
    tip.style.left = '-9999px';
    tip.style.top = '0';
    var rect = row.getBoundingClientRect();
    var tw = tip.offsetWidth;
    var th = tip.offsetHeight;
    var gap = 10;
    var left = rect.right + gap; // 首选：行的右侧
    if (left + tw > window.innerWidth - 8) left = rect.left - gap - tw; // 右侧放不下再放左侧
    if (left < 8) left = 8; // 两侧都放不下时贴左边缘
    var top = Math.min(
      Math.max(8, rect.top + rect.height / 2 - th / 2),
      window.innerHeight - th - 8
    );
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
  }

  function hideEpisodeTooltip() {
    if (epTooltipEl && !epTooltipEl.hidden) epTooltipEl.hidden = true;
  }

  /** 事件委托：悬浮选集行显示完整名称；滚动 / 缩放时收起 */
  function bindEpisodeTooltip() {
    var list = els.episodeList;
    if (!list) return;
    list.addEventListener('mouseover', function (e) {
      var row = e.target && e.target.closest ? e.target.closest('.episode-row') : null;
      if (row) showEpisodeTooltip(row);
    });
    list.addEventListener('mouseout', function (e) {
      var row = e.target && e.target.closest ? e.target.closest('.episode-row') : null;
      if (row) hideEpisodeTooltip();
    });
    if (els.episodePanel) els.episodePanel.addEventListener('scroll', hideEpisodeTooltip);
    window.addEventListener('resize', hideEpisodeTooltip);
  }

  /* ==================================================================
   * UP主 功能
   * ================================================================== */

  function sortStudyUpsInPlace(list) {
    var sort = store.get('sort') || 'star';
    if (sort === 'star' || sort === 'pub') {
      list.sort(function (a, b) { return (b.stars || 0) - (a.stars || 0) || (b.addedAt || 0) - (a.addedAt || 0); });
    } else if (sort === 'add') {
      list.sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); });
    } else if (sort === 'play') {
      list.sort(function (a, b) { return (b.videos || 0) - (a.videos || 0) || (b.addedAt || 0) - (a.addedAt || 0); });
    } else {
      list.sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); });
    }
    return list;
  }

  function studyUpCard(up, ctx) {
    // 卡片列宽和视频库对齐（274px）之后，"粉丝 · 视频"两个数字并排会被挤成省略号。
    // 卡面上只留主数字（粉丝数），完整统计进 title —— 想看的悬停一下，不想看的不用被它占位。
    var stats = '';
    if (up.fans > 0) stats += fmtCount(up.fans) + ' 粉丝';
    if (up.videos > 0) stats += (stats ? ' · ' : '') + fmtCount(up.videos) + ' 视频';
    var meta = up.fans > 0 ? fmtCount(up.fans) + ' 粉丝' : (up.videos > 0 ? fmtCount(up.videos) + ' 视频' : '');
    var tip = up.name + ' 的 B站主页' + (stats ? ' · ' + stats : '');
    return (
      '<div class="card up-card" data-up-mid="' + up.mid + '" role="link" tabindex="0" title="' + esc(tip) + '">' +
        '<div class="up-avatar"><img src="' + esc(fixAvatar(up.face)) + '" alt="' + esc(up.name) + '" loading="lazy" referrerpolicy="no-referrer"></div>' +
        '<div class="up-info">' +
          '<div class="up-name">' + esc(up.name) + '</div>' +
          '<div class="up-sign">' + esc(up.sign || '') + '</div>' +
          '<div class="up-meta">' +
            '<span class="muted small">' + meta + '</span>' +
            starControl(up.mid, up.stars, 'studyUp') +
          '</div>' +
        '</div>' +
        (ctx && ctx.tab
          ? '<button type="button" class="card-remove" data-tab-remove="' + esc(String(up.mid)) + '" data-tab-id="' + esc(ctx.tab) + '" data-tab-kind="up" title="从本标签页移除（不会移出学习 UP主）" aria-label="从本标签页移除">✕</button>'
          : '<button type="button" class="card-remove" data-up-remove="' + esc(String(up.mid)) + '" title="移除 UP主" aria-label="移除">✕</button>') +
      '</div>'
    );
  }

  function renderStudyUpsSection() {
    var list = sortStudyUpsInPlace((store.get('studyUps') || []).slice());
    var cards = list.map(studyUpCard).join('');
    return (
      '<div class="dash-section">' +
        '<div class="up-grid">' +
          '<div class="card up-card up-add-card" id="btnAddUp">' +
            '<div class="up-avatar up-avatar-add"><span class="up-add-icon">+</span></div>' +
            '<div class="up-info">' +
              '<div class="up-name muted">添加 UP主</div>' +
              '<div class="up-sign muted small">输入 UID 添加</div>' +
            '</div>' +
          '</div>' +
          cards +
        '</div>' +
      '</div>'
    );
  }

  function openAddUpModal() {
    var input = prompt('输入 UP主 UID（数字）：');
    if (!input) return;
    var mid = parseInt(input.trim(), 10);
    if (!mid || mid <= 0) { toast('UID 格式不正确', 'error'); return; }
    addStudyUp(mid);
  }

  async function addStudyUp(mid) {
    mid = parseInt(mid, 10);
    if (!mid) return;
    var ups = store.get('studyUps') || [];
    if (ups.some(function (u) { return String(u.mid) === String(mid); })) {
      toast('该 UP主 已在学习列表中');
      return;
    }
    toast('正在获取 UP主 信息…');
    try {
      var data = await api.userCard(mid, { creds: creds() });
      var card = (data && data.card) || {};
      var up = {
        mid: mid,
        name: card.name || '',
        face: fixAvatar(card.face),
        sign: card.sign || '',
        fans: parseInt(card.fans || 0, 10),
        videos: parseInt((data && data.archive_count) || 0, 10),
        level: parseInt(card.level || 0, 10),
        addedAt: Date.now(),
        stars: 0
      };
      ups.push(up);
      store.set({ studyUps: ups });
      toast('已添加：' + up.name, 'success');
      if (state.currentView === 'dashboard') renderDashboard();
    } catch (e) {
      toast('获取 UP主 信息失败：' + e.message, 'error');
    }
  }

  /** 从“学习 UP主”移除（确认后） */
  function removeStudyUp(mid) {
    var ups = store.get('studyUps') || [];
    var u = ups.find(function (s) { return String(s.mid) === String(mid); });
    var name = (u && u.name) || '该 UP主';
    confirmAction('确定从学习 UP主中移除「' + esc(name) + '」？', function () {
      var next = ups.filter(function (s) { return String(s.mid) !== String(mid); });
      store.set({ studyUps: next });
      toast('已移除 ' + name, 'success');
      if (state.currentView === 'dashboard') renderDashboard();
    });
  }

  /* ---------------- 新建 / 重命名 / 删除自定义标签页 ---------------- */

  /** 新建标签页：直接创建，并立刻进入内联重命名 */
  function createCustomTab() {
    var list = customTabs();
    var id = 'tab-' + Date.now();
    list.push({ id: id, name: nextDefaultTabName(), createdAt: Date.now(), items: [] });
    store.set({ customTabs: list });
    state.activeDashTab = id;
    store.set({ activeDashTab: id });
    renderDashboard();
    startTabRename(id);
  }

  /**
   * 新标签页的默认名：取当前未被占用的最小序号。
   * 已有「新标签页」就依次叫「新标签页2」「新标签页3」…；
   * 若某个默认名被改掉（例如改成了「日语」），该序号会被重新空出来复用。
   */
  function nextDefaultTabName() {
    var used = {};
    customTabs().forEach(function (t) { used[String(t.name)] = true; });
    if (!used['新标签页']) return '新标签页';
    for (var i = 2; i < 1000; i++) {
      var name = '新标签页' + i;
      if (!used[name]) return name;
    }
    return '新标签页' + Date.now();
  }

  /** 把自定义标签页挪到目标标签页前/后（targetId 为空表示放到最后） */
  function moveCustomTab(srcId, targetId, after) {
    var list = customTabs();
    var srcIdx = -1;
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(srcId)) { srcIdx = i; break; }
    }
    if (srcIdx < 0) return;
    var moved = list.splice(srcIdx, 1)[0];
    if (targetId) {
      var tgt = -1;
      for (var j = 0; j < list.length; j++) {
        if (String(list[j].id) === String(targetId)) { tgt = j; break; }
      }
      if (tgt < 0) {
        list.splice(srcIdx, 0, moved);   // 目标不存在：放回原位
        return;
      }
      list.splice(after ? tgt + 1 : tgt, 0, moved);
    } else {
      list.push(moved);
    }
    store.set({ customTabs: list });
    // 落位动画（FLIP）：先记下每个自定义标签的旧位置，重排渲染后再用 WAAPI
    // 从旧位置补间回 0 —— 标签是"让位滑过去"，而不是瞬移。
    var beforeLefts = {};
    var oldTabs = els.dashboard.querySelectorAll('.dash-tab.custom');
    for (var k = 0; k < oldTabs.length; k++) {
      var tid = oldTabs[k].dataset.tabCustom;
      if (tid) beforeLefts[tid] = oldTabs[k].getBoundingClientRect().left;
    }
    renderDashboard();
    animateTabsMove(beforeLefts);
  }

  /** 拖拽排序落位：把标签从旧位置补间到新位置（见 moveCustomTab） */
  function animateTabsMove(beforeLefts) {
    // 减弱动效：不做补间，直接就位
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var played = false;
    var tabs = els.dashboard.querySelectorAll('.dash-tab.custom');
    for (var i = 0; i < tabs.length; i++) {
      var id = tabs[i].dataset.tabCustom;
      if (!id || beforeLefts[id] === undefined) continue;
      var dx = beforeLefts[id] - tabs[i].getBoundingClientRect().left;
      if (Math.abs(dx) < 1) continue;
      try {
        tabs[i].animate(
          [{ transform: 'translateX(' + dx + 'px)' }, { transform: 'translateX(0)' }],
          // 松手落位：用强 ease-out，不带过冲。
          // 之前用的是带 2% 过冲的弹簧曲线，配合"让位"一起看就是整条标签栏在弹 ——
          // 短距离的落位（一个标签宽）本来也看不出弹性，只剩下抖动感。
          { duration: 240, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }
        );
        played = true;
      } catch (e) { /* 不支持 WAAPI 就让它瞬移 */ }
    }
    // 补间期间如果正好发生横向滚动 / 窗口 resize，指示条会被"飞行中"的位置带偏；
    // 落位结束时再对齐一次，保证最终状态一定是对的。
    if (played) setTimeout(syncTabIndicator, 260);
  }

  /** 标签内联重命名（双击标签 / 新建后立即进入） */
  function startTabRename(tabId) {
    var tab = findCustomTab(tabId);
    var btn = els.dashboard.querySelector('.dash-tab[data-tab-custom="' + tabId + '"]');
    if (!tab || !btn) return;
    closeActionMenu();
    btn.innerHTML = '<input class="dash-tab-input" type="text" maxlength="20" value="' + esc(tab.name) + '">';
    var input = btn.querySelector('input');
    input.focus();
    input.select();
    var done = false;
    var commit = function (save) {
      if (done) return;
      done = true;
      var name = (input.value || '').trim();
      if (save && name && name !== tab.name) {
        var list = customTabs();
        var t = list.find(function (x) { return String(x.id) === String(tabId); });
        if (t) {
          t.name = name;
          store.set({ customTabs: list });
          toast('已重命名为「' + name + '」', 'success');
        }
      }
      renderDashboard();
    };
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', function () { commit(true); });
    input.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  /** 删除标签页（只删容器，库内容不动） */
  function deleteCustomTab(tabId) {
    var tab = findCustomTab(tabId);
    if (!tab) return;
    var n = (tab.items || []).length;
    confirmAction(
      '删除标签页「' + esc(tab.name) + '」？<br><span class="muted small">只删除这个标签页；其中 ' + n + ' 项内容仍保留在各自的栏目里。</span>',
      function () {
        store.set({ customTabs: customTabs().filter(function (t) { return String(t.id) !== String(tabId); }) });
        delete state.tabQuery[tabId];
        if (String(state.activeDashTab) === String(tabId)) {
          state.activeDashTab = 'continue';
          store.set({ activeDashTab: 'continue' });
        }
        renderDashboard();
        toast('已删除标签页', 'success');
      }
    );
  }

  /* 通用小面板（挂到 body，避免被容器裁切）：标签页操作、选择标签页等都用它 */
  var actionMenuEl = null;

  function closeActionMenu() {
    if (actionMenuEl) {
      actionMenuEl.remove();
      actionMenuEl = null;
    }
    document.removeEventListener('mousedown', onActionMenuDocDown);
    window.removeEventListener('resize', closeActionMenu);
  }

  function onActionMenuDocDown(e) {
    if (actionMenuEl && !actionMenuEl.contains(e.target)) closeActionMenu();
  }

  /** items: [{ label, note?, danger?, onClick }] */
  function openActionMenu(anchor, items) {
    closeActionMenu();
    if (!items.length) return;
    var pop = document.createElement('div');
    pop.className = 'tab-menu-pop';
    pop.innerHTML = items.map(function (it, i) {
      return '<button type="button" class="tab-menu-item' + (it.danger ? ' danger' : '') + (it.note ? ' note' : '') +
        '" data-menu-idx="' + i + '">' + esc(it.label) + '</button>';
    }).join('');
    document.body.appendChild(pop);
    var r = anchor.getBoundingClientRect();
    pop.style.top = (r.bottom + 6) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    actionMenuEl = pop;
    var btns = pop.querySelectorAll('[data-menu-idx]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        var item = items[Number(this.dataset.menuIdx)];
        closeActionMenu();
        if (item && item.onClick) item.onClick();
      });
    }
    setTimeout(function () {
      document.addEventListener('mousedown', onActionMenuDocDown);
      window.addEventListener('resize', closeActionMenu);
    }, 0);
  }

  function openTabMenu(tabId, anchor) {
    openActionMenu(anchor, [
      { label: '重命名', onClick: function () { startTabRename(tabId); } },
      { label: '删除标签页', danger: true, onClick: function () { deleteCustomTab(tabId); } }
    ]);
  }

  /**
   * 把收藏夹里的视频加入指定自定义标签页。
   * 规则同前：先入库（学习列表）再入页；已在库/已在页都不会重复写。
   */
  async function addVideoToTab(bvid, tabId) {
    var tab = findCustomTab(tabId);
    if (!tab) return;
    var media = state.videos.find(function (x) { return String(x.bvid || x.bv_id) === String(bvid); });
    var id = await ensureVideoInLibrary(bvid, media);
    if (!id) {
      toast('无法添加该视频', 'error');
      return;
    }
    var list = customTabs();
    var t = list.find(function (x) { return String(x.id) === String(tabId); });
    if (t && !tabHasItem(t, 'video', id)) {
      t.items = t.items || [];
      t.items.push({ kind: 'video', id: String(id) });
      store.set({ customTabs: list });
      toast('已加入「' + t.name + '」标签页', 'success');
    }
    // 停留在收藏夹视图时刷新卡片状态；若已跳到仪表盘（新建标签页那条路径）则重渲染标签页
    if (state.currentView === 'folder') renderGrid();
    else if (state.currentView === 'dashboard') renderDashboard();
  }

  /** 从右上角内容源进来时：选一个自定义标签页把它加进去 */
  function openTabChooser(bvid, anchor) {
    var items = customTabs().map(function (t) {
      return {
        label: '加入「' + t.name + '」',
        onClick: function () { addVideoToTab(bvid, t.id); }
      };
    });
    items.push({
      label: '＋ 新建标签页并加入',
      note: true,
      onClick: function () {
        createCustomTab();
        addVideoToTab(bvid, state.activeDashTab);
      }
    });
    openActionMenu(anchor, items);
  }

  /** 在库里查找成员对应的实体（找不到返回 null） */
  function findLibraryItem(kind, id) {
    if (kind === 'video') {
      return (store.get('customVideos') || []).find(function (x) {
        return String(x.id || x.bvid) === String(id);
      }) || null;
    }
    if (kind === 'folder') {
      return (store.get('studyFolders') || []).find(function (x) { return String(x.id) === String(id); }) || null;
    }
    if (kind === 'up') {
      return (store.get('studyUps') || []).find(function (x) { return String(x.mid) === String(id); }) || null;
    }
    return null;
  }

  function libraryItemName(kind, id) {
    var it = findLibraryItem(kind, id);
    if (!it) return '';
    return it.title || it.name || String(id);
  }

  /** 库内实体被删除后，把所有自定义标签页里的引用一并摘掉（不留悬空引用） */
  function dropMemberEverywhere(kind, id) {
    var key = memberKey(kind, id);
    var list = customTabs();
    var changed = false;
    list.forEach(function (t) {
      var before = (t.items || []).length;
      t.items = (t.items || []).filter(function (it) { return memberKey(it.kind, it.id) !== key; });
      if (t.items.length !== before) changed = true;
    });
    if (changed) store.set({ customTabs: list });
  }

  /** 直接从库中删除（不弹确认，确认由调用方负责）；返回是否真的删掉了 */
  function deleteFromLibrary(kind, id) {
    if (kind === 'video') {
      var item = findLibraryItem('video', id);
      if (!item) return false;
      doRemoveCustomVideo(item, item.seriesKey || (item.bvid ? 'b:' + item.bvid : 'id:' + item.id), true);
      dropMemberEverywhere(kind, id);
      return true;
    }
    if (kind === 'folder') {
      var folders = store.get('studyFolders') || [];
      var next = folders.filter(function (s) { return String(s.id) !== String(id); });
      if (next.length === folders.length) return false;
      store.set({ studyFolders: next });
      dropMemberEverywhere(kind, id);
      return true;
    }
    if (kind === 'up') {
      var ups = store.get('studyUps') || [];
      var nextUps = ups.filter(function (s) { return String(s.mid) !== String(id); });
      if (nextUps.length === ups.length) return false;
      store.set({ studyUps: nextUps });
      dropMemberEverywhere(kind, id);
      return true;
    }
    return false;
  }

  /**
   * 自定义标签页里卡片上的 ✕：二级确认。
   * 默认只从本标签页移除；勾选「同时从库中删除」才连库一起删（默认不勾）。
   */
  function removeFromTab(tabId, kind, id) {
    var tab = findCustomTab(tabId);
    if (!tab) return;
    var name = libraryItemName(kind, id) || '该项';
    var libName = { video: '视频库', folder: '收藏夹库', up: '学习 UP主' }[kind] || '库';
    confirmAction(
      '从「' + esc(tab.name) + '」标签页移除「' + esc(name) + '」？' +
        '<br><label class="check"><input type="checkbox" id="alsoDeleteFromLib"> ' +
        '同时从库中删除（从「' + libName + '」里一并删掉，其它标签页里的它也会消失）</label>',
      function (alsoDelete) {
        var list = customTabs();
        var t = list.find(function (x) { return String(x.id) === String(tabId); });
        if (t) {
          var k = memberKey(kind, id);
          t.items = (t.items || []).filter(function (it) { return memberKey(it.kind, it.id) !== k; });
          store.set({ customTabs: list });
        }
        var deleted = alsoDelete ? deleteFromLibrary(kind, id) : false;
        if (state.currentView === 'dashboard') renderDashboard();
        toast(deleted ? '已从标签页和库中删除' : '已从本标签页移除');
      },
      function () {
        var cb = document.getElementById('alsoDeleteFromLib');
        return !!(cb && cb.checked);
      }
    );
  }

  /* ---------------- 内容选择器（把源 / 库里的内容加入标签页） ---------------- */

  var PICKER_SECTIONS = [
    { key: 'folder', label: '源收藏夹' },
    { key: 'video', label: '视频库' },
    { key: 'folderLib', label: '收藏夹库' },
    { key: 'up', label: '学习 UP主' }
  ];

  var pickerState = null;

  /**
   * 打开「添加内容到『X』」选择器。
   * reuse=true 表示这是从收藏夹视图"返回上一级"回来的：保留上次的分区 / 搜索词 /
   * 勾选与排序，用户接着刚才的位置继续挑，而不是被弹回第一步。
   */
  function openContentPicker(tabId, reuse) {
    var tab = findCustomTab(tabId);
    if (!tab) return;
    var keep = reuse && pickerState && String(pickerState.tabId) === String(tabId);
    if (!keep) {
      pickerState = {
        tabId: tabId,
        section: 'folder',
        query: '',
        sel: {},
        // 各分区各自的排序方式（源收藏夹沿用内容源的做法：外部列表不排序）
        sortBy: { video: 'star', folderLib: 'star', up: 'star' }
      };
    }
    openModal(
      '<div class="modal-head"><h2>添加内容到「' + esc(tab.name) + '」</h2><button type="button" class="icon-btn" data-close aria-label="关闭">×</button></div>' +
      '<div class="modal-body">' +
        '<div class="picker-tabs">' +
          PICKER_SECTIONS.map(function (s) {
            return '<button type="button" class="picker-tab' + (s.key === pickerState.section ? ' active' : '') +
              '" data-picker-tab="' + s.key + '">' + s.label + '</button>';
          }).join('') +
        '</div>' +
        '<div class="picker-tools">' +
          '<input id="pickerSearch" class="search-input" type="search" placeholder="搜索…" autocomplete="off">' +
          '<select id="pickerSort" class="select picker-sort" aria-label="排序"></select>' +
        '</div>' +
        '<p class="muted small" id="pickerHint"></p>' +
        '<div id="pickerList" class="picker-list"></div>' +
        '<div class="row picker-foot">' +
          '<span class="muted small" id="pickerCount">已选 0 项</span>' +
          '<button type="button" class="btn ghost" data-close>取消</button>' +
          '<button type="button" class="btn primary" id="btnPickerAdd" disabled>添加</button>' +
        '</div>' +
      '</div>',
      { wide: true }
    );
    bindClose();
    bindPickerEvents();
    renderPickerList();
    loadPickerFolders();
    // 复用上次状态时把搜索框的内容也还原（否则列表按旧关键词过滤、输入框却是空的）
    var qEl = document.getElementById('pickerSearch');
    if (qEl) qEl.value = pickerState.query || '';
  }

  function bindPickerEvents() {
    var tabs = document.querySelectorAll('.picker-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        pickerState.section = this.dataset.pickerTab;
        pickerState.query = '';
        var input = document.getElementById('pickerSearch');
        if (input) input.value = '';
        var all = document.querySelectorAll('.picker-tab');
        for (var j = 0; j < all.length; j++) all[j].classList.toggle('active', all[j] === this);
        renderPickerSort();
        renderPickerList();
        if (pickerState.section === 'folder') loadPickerFolders();
      });
    }
    document.getElementById('pickerSearch').addEventListener('input', function () {
      pickerState.query = this.value;
      renderPickerList();
    });
    var sortEl = document.getElementById('pickerSort');
    if (sortEl) {
      sortEl.addEventListener('change', function () {
        pickerState.sortBy[pickerState.section] = this.value;
        renderPickerList();
      });
    }
    document.getElementById('pickerList').addEventListener('click', function (e) {
      if (!pickerState) return;
      var row = e.target.closest('[data-pick-key]');
      if (!row) return;
      var toggle = e.target.closest('[data-pick-toggle]');
      // 源收藏夹：点整行进入收藏夹视图挑视频（点左侧方框仍是「选中这个收藏夹」）
      if (row.dataset.pickOpenId && !toggle) {
        enterFolderFromPicker(row.dataset.pickOpenId);
        return;
      }
      if (row.classList.contains('disabled')) return;
      togglePick((toggle && toggle.dataset.pickToggle) || row.dataset.pickKey);
    });
    document.getElementById('btnPickerAdd').addEventListener('click', commitPicker);
    renderPickerSort();
  }

  function togglePick(key) {
    if (!pickerState || !key) return;
    if (pickerState.sel[key]) delete pickerState.sel[key];
    else pickerState.sel[key] = true;
    renderPickerList();
  }

  /**
   * 从选择器进入收藏夹视图挑视频：复用内容源的收藏夹浏览（自带排序 / 搜索 / 分页），
   * 只额外带上「正在往哪个标签页加」的上下文，卡片右上角据此换一套状态显示。
   */
  function enterFolderFromPicker(folderId) {
    var tabId = pickerState ? pickerState.tabId : '';
    var tab = findCustomTab(tabId);
    closeModal();
    // 注意：这里**不清空 pickerState**。从收藏夹视图点"返回添加内容"时要回到刚才那一层
    // （同一个分区、同一个搜索词、同一批勾选），否则用户得从第一步重新点一遍。
    state.pendingTabId = tabId;
    openFolder(folderId);
    if (tab) toast('正在添加到「' + tab.name + '」：点视频右上角的绿色 +', 'info', 5000);
  }

  var PICKER_SORTS = {
    video: [['star', '星级'], ['add', '添加时间'], ['play', '播放量'], ['pub', '发布时间']],
    folderLib: [['star', '星级'], ['add', '添加时间'], ['count', '视频数']],
    up: [['star', '星级'], ['add', '添加时间'], ['fans', '粉丝数']]
  };

  /** 库侧分区的排序下拉（源收藏夹沿用内容源，不显示排序） */
  function renderPickerSort() {
    var el = document.getElementById('pickerSort');
    if (!el || !pickerState) return;
    var opts = PICKER_SORTS[pickerState.section];
    if (!opts) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    el.style.display = '';
    var cur = pickerState.sortBy[pickerState.section] || 'star';
    el.innerHTML = opts.map(function (o) {
      return '<option value="' + o[0] + '"' + (cur === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');
    el.value = cur;
  }

  function sortPickerRows(list) {
    var by = pickerState.sortBy[pickerState.section] || 'star';
    var cmp = {
      star: function (a, b) { return (b.stars || 0) - (a.stars || 0) || (b.addedAt || 0) - (a.addedAt || 0); },
      add: function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); },
      play: function (a, b) { return (b.play || 0) - (a.play || 0) || (b.addedAt || 0) - (a.addedAt || 0); },
      pub: function (a, b) { return (b.pub || 0) - (a.pub || 0) || (b.addedAt || 0) - (a.addedAt || 0); },
      count: function (a, b) { return (b.count || 0) - (a.count || 0) || (b.addedAt || 0) - (a.addedAt || 0); },
      fans: function (a, b) { return (b.fans || 0) - (a.fans || 0) || (b.addedAt || 0) - (a.addedAt || 0); }
    }[by];
    if (cmp) list.sort(cmp);
    return list;
  }

  /** 列表行的缩略图（无图时显示占位文字） */
  function pickerThumb(url, fallback) {
    if (!url) return '<span class="picker-thumb picker-thumb-empty">' + esc(fallback || '—') + '</span>';
    return '<img class="picker-thumb" src="' + esc(String(url).replace(/^http:\/\//i, 'https://')) +
      '" alt="" loading="lazy" referrerpolicy="no-referrer">';
  }

  /** 源收藏夹需要联网拉取（复用内容源的 10 分钟缓存） */
  async function loadPickerFolders() {
    if (!store.get('login')) return;
    if (state.folders.length && Date.now() - state.foldersFetchedAt < 10 * 60 * 1000) return;
    try {
      state.folders = await api.folders(store.get('login').mid, creds());
      state.foldersFetchedAt = Date.now();
      if (pickerState) renderPickerList();
    } catch (e) {
      var list = document.getElementById('pickerList');
      if (list && pickerState && pickerState.section === 'folder') {
        list.innerHTML = '<p class="muted" style="padding:14px">收藏夹加载失败：' + esc(e.message) + '</p>';
      }
    }
  }

  function pickerRows() {
    var sec = pickerState.section;
    var q = (pickerState.query || '').trim().toLowerCase();
    var hit = function (t) { return !q || String(t || '').toLowerCase().indexOf(q) >= 0; };
    if (sec === 'folder') {
      if (!store.get('login')) return { hint: '未登录：请先到「设置」完成 B 站登录，才能读取收藏夹。', rows: [] };
      var lib = store.get('studyFolders') || [];
      var fRows = (state.folders || []).filter(function (f) { return hit(f.title); }).map(function (f) {
        var inLib = lib.some(function (s) { return String(s.id) === String(f.id); });
        return {
          kind: 'folder',
          id: f.id,
          title: f.title,
          meta: (f.media_count != null ? f.media_count + ' 个视频' : '') + (inLib ? ' · 已加入' : ''),
          enter: true,
          plain: true   // 源收藏夹列表不显示封面（B站收藏夹列表接口不返回封面，占位图没有辨识度）
        };
      });
      return {
        hint: '点收藏夹进入后可挑单个视频（那个界面有排序和搜索）；勾选左侧方框则把整个收藏夹加入。',
        rows: fRows
      };
    }
    if (sec === 'video') {
      var vRows = (store.get('customVideos') || []).filter(function (v) { return hit(v.title || v.name); }).map(function (v) {
        return {
          kind: 'video',
          id: v.id,
          title: v.title || v.name || '未命名',
          meta: v.kind === 'local' ? '本地视频' : 'B站视频',
          cover: v.cover,
          fallback: v.kind === 'local' ? '本地' : 'B站',
          stars: v.stars || 0,
          addedAt: v.addedAt || 0,
          play: v.play || 0,
          pub: v.pubtime || 0
        };
      });
      return { hint: '', rows: sortPickerRows(vRows) };
    }
    if (sec === 'folderLib') {
      var flRows = (store.get('studyFolders') || []).filter(function (f) { return hit(f.title || f.name); }).map(function (f) {
        return {
          kind: 'folder',
          id: f.id,
          title: f.title || f.name,
          meta: f.mediaCount != null ? f.mediaCount + ' 个视频' : '',
          cover: f.cover,
          fallback: '夹',
          stars: f.stars || 0,
          addedAt: f.addedAt || 0,
          count: f.mediaCount || 0
        };
      });
      return { hint: '', rows: sortPickerRows(flRows) };
    }
    var uRows = (store.get('studyUps') || []).filter(function (u) { return hit(u.name); }).map(function (u) {
      return {
        kind: 'up',
        id: u.mid,
        title: u.name,
        meta: u.fans ? fmtCount(u.fans) + ' 粉丝' : '',
        cover: u.face,
        fallback: 'UP',
        stars: u.stars || 0,
        addedAt: u.addedAt || 0,
        fans: u.fans || 0
      };
    });
    return { hint: '', rows: sortPickerRows(uRows) };
  }

  function renderPickerList() {
    var list = document.getElementById('pickerList');
    if (!list || !pickerState) return;
    var res = pickerRows();
    var hintEl = document.getElementById('pickerHint');
    if (hintEl) hintEl.textContent = res.hint || '';
    var tab = findCustomTab(pickerState.tabId);
    if (!res.rows.length) {
      list.innerHTML = '<p class="muted" style="padding:14px">' +
        (res.hint ? '—' : '暂无可选内容。') + '</p>';
      updatePickerCount();
      return;
    }
    list.innerHTML = res.rows.map(function (r) {
      var key = memberKey(r.kind, r.id);
      var inTab = tab ? tabHasItem(tab, r.kind, r.id) : false;
      var on = !!pickerState.sel[key];
      var metaText = (inTab ? '已在本页' + (r.meta ? ' · ' + r.meta : '') : (r.meta || ''));
      return '<div class="picker-row' + (on ? ' on' : '') + (!r.enter && inTab ? ' disabled' : '') +
          '" data-pick-key="' + esc(key) + '"' +
          (r.enter ? ' data-pick-open-id="' + esc(r.id) + '"' : '') + '>' +
          '<span class="picker-check" data-pick-toggle="' + esc(key) + '">' + (inTab || on ? '✓' : '') + '</span>' +
          (r.plain ? '' : pickerThumb(r.kind === 'up' ? fixAvatar(r.cover) : r.cover, r.fallback)) +
          '<span class="picker-text">' +
            '<span class="picker-name">' + esc(r.title) + '</span>' +
            '<span class="picker-meta muted small">' + esc(metaText) + '</span>' +
          '</span>' +
          (r.enter ? '<span class="picker-go">进入 ›</span>' : '') +
        '</div>';
    }).join('');
    hideBrokenThumbs(list);
    updatePickerCount();
  }

  function updatePickerCount() {
    var el = document.getElementById('pickerCount');
    if (!el || !pickerState) return;
    var n = Object.keys(pickerState.sel).length;
    el.textContent = '已选 ' + n + ' 项';
    var btn = document.getElementById('btnPickerAdd');
    if (btn) btn.disabled = n === 0;
  }

  /**
   * 确认添加。规则：来源内容先入库、再入页（标签页的成员一定都在库里）——
   * 「源收藏夹」的收藏夹写入 studyFolders；「源收藏夹」里的单个视频写入 customVideos；
   * 其余三个分区的内容本来就在库里，只建立引用。
   */
  async function commitPicker() {
    if (!pickerState) return;
    var keys = Object.keys(pickerState.sel);
    if (!keys.length) return;
    var addBtn = document.getElementById('btnPickerAdd');
    if (addBtn) {
      addBtn.disabled = true;
      addBtn.textContent = '添加中…';
    }
    var list = customTabs();
    var tab = list.find(function (t) { return String(t.id) === String(pickerState.tabId); });
    if (!tab) return;
    tab.items = tab.items || [];
    var studyFolders = store.get('studyFolders') || [];
    var foldersChanged = false;
    var added = 0;
    var failed = 0;

    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var idx = k.indexOf(':');
      var kind = k.slice(0, idx);
      var id = k.slice(idx + 1);
      if (tabHasItem(tab, kind, id)) continue;

      if (kind === 'folder') {
        if (!studyFolders.some(function (s) { return String(s.id) === id; })) {
          var f = (state.folders || []).find(function (x) { return String(x.id) === id; });
          if (f) {
            studyFolders.unshift({
              id: f.id,
              title: f.title,
              cover: (f.cover || '').replace(/^http:\/\//i, 'https://'),
              mediaCount: f.media_count || 0,
              addedAt: Date.now(),
              stars: 0
            });
            foldersChanged = true;
          }
        }
        tab.items.push({ kind: 'folder', id: String(id) });
        added++;
        continue;
      }

      if (kind === 'video') {
        // 选择器里的视频都来自「视频库」（已在库），只建立引用
        tab.items.push({ kind: 'video', id: String(id) });
        added++;
        continue;
      }

      tab.items.push({ kind: kind, id: String(id) });
      added++;
    }

    if (foldersChanged) store.set({ studyFolders: studyFolders });
    store.set({ customTabs: list });
    closeModal();
    pickerState = null;
    renderDashboard();
    if (failed) {
      toast('已添加 ' + added + ' 项，' + failed + ' 项未能加入', 'error');
    } else {
      toast('已添加 ' + added + ' 项', 'success');
    }
  }

  /* ---------------- 启动 ---------------- */
  (async function init() {
    // 新环境首次打开（本地无状态、但服务端有备份）→ 恢复后刷新一次
    try {
      if (await store.restoreIfNeeded()) {
        location.reload();
        return;
      }
    } catch (e) {
      /* 恢复失败就按全新状态继续 */
    }
    // 把当前数据补成一份备份（空状态不会上传，见 storage.js 的守卫）
    try { store.backupNow(); } catch (e) { /* 忽略 */ }
    applyTheme();
    // 旧版历史记录迁移：系列/分P 归并为整季一条，避免继续学习栏重复
    normalizeHistory();
    // 后台尝试为旧版“无系列信息”的单集记录补齐系列归属（限量、静默，不阻塞启动）
    backfillOrphanSeries().catch(function () { /* 静默 */ });
    bindEvents();
    bindEpisodeTooltip();
    // 自研播放器错误提示接入应用的 toast
    if (window.BiliNestPlayer) {
      BiliNestPlayer.setErrorHandler(function (msg, type, duration) { toast(msg, type, duration); });
      // 播放器控制条“上一集 / 下一集”按钮
      BiliNestPlayer.setEpisodeNavHandler(function (dir) {
        var idx = currentEpisodeIndex();
        if (idx < 0) return;
        var target = dir === 'prev' ? idx - 1 : idx + 1;
        if (target >= 0 && target < state.episodes.length) playEpisodeAt(target);
      });
      // 播放器穷尽重试/备用/换清晰度后仍失败（如该集文件在 CDN 缺失），
      // 自动切换到官方嵌入播放器兜底（官方走 DASH，通常可播）。
      BiliNestPlayer.setFallbackHandler(function (bvid, cid) {
        BiliNestPlayer.stop();
        var page = (state.activeEpisode && state.activeEpisode.page) || 1;
        els.biliFrame.hidden = false;
        els.biliFrame.src = buildPlayerUrl(bvid, cid, page);
        toast('该视频的直链文件在 B 站 CDN 上缺失，已自动切换官方播放器', 'error', 8000);
      });
    }
    state.backend = await api.init();
    if (!state.backend.ok) {
      els.backendBanner.hidden = false;
    }
    // 恢复上次选中的主页标签（标签页被删或值非法时回落到「继续学习」）
    state.activeDashTab = normalizeDashTab(store.get('activeDashTab'));
    await checkLogin();
    await loadDashboard();
    // 打开页面时自动检查更新（设置里可切成"仅手动"）。检查结果只体现在设置图标的小圆点上，
    // 不弹任何东西；服务端有 10 分钟缓存，代价极低。
    autoCheckUpdate();
    // 首次启动展示登录与设置引导
    if (store.get('guideSeen') !== true) openGuideModal();
  })();
})();
