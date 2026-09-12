/**
 * BiliNest 本地状态管理
 * ------------------------------------------------------------
 * 持久化到 localStorage（键：bilinest.state.v1），结构见 DEFAULTS。
 * 安全说明：
 *   - Cookie 仅在用户勾选“保存到本地”时才写入 localStorage；
 *   - 勾选“仅本次会话”时 Cookie 只保存在内存，刷新页面即失效；
 *   - 清除数据按钮会移除所有本地状态。
 */
window.BiliNestStore = (function () {
  'use strict';

  var STORAGE_KEY = 'bilinest.state.v1';
  // 旧版本（BiliPure）使用的存储键：改名后首次打开自动迁移，
  // 避免登录态 / 收藏夹 / 观看记录等本地数据丢失
  var LEGACY_STORAGE_KEY = 'bilipure.state.v1';
  // 服务端状态备份：换浏览器、换端口、清过浏览器数据时都能把数据找回来。
  // 只在 http(s) 下启用。
  var BACKUP_URL = (location.protocol === 'http:' || location.protocol === 'https:')
    ? '/api/state/backup'
    : '';
  var backupTimer = null;
  var loadedFromLocal = false;   // 本次加载是否读到了本地状态（决定要不要尝试恢复）

  /** 状态是否"有真东西"：空状态/纯默认值不该上传，也不该被当成可恢复的备份 */
  function hasRealData(s) {
    if (!s) return false;
    if (s.login) return true;
    return !!(
      (s.customVideos || []).length ||
      (s.studyFolders || []).length ||
      (s.studyUps || []).length ||
      (s.customTabs || []).length ||
      (s.watchHistory || []).length
    );
  }

  var DEFAULTS = {
    v: 1,
    updatedAt: 0,             // 最后一次真实改动的时间戳（毫秒）；用于与服务端备份比新旧
    theme: 'auto',            // auto | light | dark
    cookie: null,             // { value, savedAt } —— 仅当用户选择持久化时存在
    sid: null,                // OAuth 会话 id（由本地代理服务器签发）
    login: null,              // { mid, uname } —— 最近一次校验通过的账号信息
    source: null,             // { kind:'folder', id, name } 或 { kind:'mine', name }
    sort: 'star',             // add=添加时间 | pub=发布时间 | star=星级 | play=播放量
    activeDashTab: 'continue', // 主页当前标签：continue | added | folders | ups
    settingsTab: 'login',     // 设置弹窗左栏当前分类：login | general | data | about
    subSettings: { pos: 100, size: 'md' }, // 字幕位置（滑块 0~100）/ 字号
    customVideos: [],         // 手动添加的 B 站视频 / 本地视频
    studyFolders: [],         // 收藏夹库：{ id, title, cover, mediaCount, addedAt, stars }
    studyUps: [],             // 学习 UP主（本地书签）：{ mid, name, face, sign, fans, videos, level, addedAt, stars }
    customTabs: [],           // 自定义标签页：{ id, name, createdAt, items:[{ kind:'video'|'folder'|'up', id }] }
                              //   items 只存库内实体的引用（customVideos[].id / studyFolders[].id / studyUps[].mid）
    watchHistory: [],         // 观看记录（参考 DanmuTV 的播放记录 schema，向后兼容）：
                               //   { key, kind, bvid, cid, page, title, cover, upper, seriesKey,
                               //     seriesTitle, episodeLabel, episodeCount, danmaku,
                               //     progress, duration, watchedAt, episodes?{key:{progress,...}} }
    hiddenHistoryKeys: [],    // 用户从“继续学习”栏手动隐藏的卡片（按合并键，历史数据保留）
    guideSeen: null           // 是否已看过首次启动引导（true = 不再显示）
  };

  // 仅本次会话使用的 Cookie（不落盘）
  var memoryCookie = null;

  var state = load();

  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (raw && raw.v === 1) {
        loadedFromLocal = true;
        return Object.assign({}, DEFAULTS, raw);
      }
    } catch (e) {
      /* 数据损坏时回退默认值 */
    }
    // 兼容旧键：一次性迁移到新键并删除旧键
    try {
      var legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || 'null');
      if (legacy && legacy.v === 1) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));
        localStorage.removeItem(LEGACY_STORAGE_KEY);
        loadedFromLocal = true;
        return Object.assign({}, DEFAULTS, legacy);
      }
    } catch (e) {
      /* 旧数据损坏则忽略 */
    }
    return Object.assign({}, DEFAULTS);
  }

  function save() {
    state.updatedAt = Date.now();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* localStorage 不可用（例如隐私模式）时静默失败 */
    }
    scheduleBackup();
  }

  /** 状态自带的修改时间；旧数据没有这个字段时按 0 处理 */
  function stateTime(s) {
    return Number(s && s.updatedAt) || 0;
  }

  /** 防抖上传到本地服务的备份文件（1.5s 内的多次改动只传一次） */
  function scheduleBackup() {
    if (!BACKUP_URL) return;
    if (!hasRealData(state)) return;   // 空状态不上传，避免把好备份覆盖成空的
    if (backupTimer) clearTimeout(backupTimer);
    backupTimer = setTimeout(function () {
      backupTimer = null;
      postBackup();
    }, 1500);
  }

  function postBackup() {
    if (!BACKUP_URL || !hasRealData(state)) return;
    try {
      fetch(BACKUP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: state })
      }).catch(function () { /* 本地服务未运行时忽略 */ });
    } catch (e) {
      /* 忽略 */
    }
  }

  /** 立即上传一次（不等防抖）；应用启动时用它把当前数据补成备份 */
  function backupNow() {
    if (backupTimer) {
      clearTimeout(backupTimer);
      backupTimer = null;
    }
    postBackup();
  }

  /** 让服务端删掉备份（配合“清除全部本地数据”，否则刷新后会被恢复回来） */
  function dropBackup() {
    if (!BACKUP_URL) return;
    try {
      fetch(BACKUP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true })
      }).catch(function () { /* 忽略 */ });
    } catch (e) {
      /* 忽略 */
    }
  }

  /**
   * 从服务端备份同步一次。
   *   - 本地没有真实数据（清过浏览器数据 / 换了浏览器 / 换了端口）→ 直接取备份；
   *   - 本地有数据时比新旧：只有备份更新才覆盖本地，否则以本地为准（随后照常上传）。
   * 返回 Promise<boolean>：true 表示已写入 localStorage，调用方应刷新页面。
   */
  function restoreIfNeeded() {
    if (!BACKUP_URL) return Promise.resolve(false);
    return fetch(BACKUP_URL, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.exists || !data.state || data.state.v !== 1) return false;
        if (!hasRealData(data.state)) return false;   // 备份本身是空的，恢复没意义
        // 本地这边也是真数据时，只有备份更新才覆盖；时间戳相同/缺失都以本地为准，
        // 避免每次启动都因为"上传比改动晚一点点"而反复恢复刷新。
        if (hasRealData(state) && stateTime(data.state) <= stateTime(state)) return false;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data.state));
        return true;
      })
      .catch(function () { return false; });
  }

  /** 设置里手动触发：强制用备份覆盖本地（恢复后需刷新页面） */
  function restoreFromBackup() {
    if (!BACKUP_URL) return Promise.resolve(false);
    return fetch(BACKUP_URL, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.exists || !data.state || data.state.v !== 1) return false;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data.state));
        return true;
      })
      .catch(function () { return false; });
  }

  return {
    get: function (key) {
      return state[key];
    },

    /** 局部更新状态；persist=false 时只改内存（例如登录信息） */
    set: function (patch, persist) {
      Object.assign(state, patch || {});
      if (persist !== false) save();
    },

    /** 返回当前可用的 Cookie 字符串（内存或 localStorage），没有则返回空串 */
    getCookie: function () {
      return memoryCookie || (state.cookie && state.cookie.value) || '';
    },

    /** 保存 Cookie。persist=true 写入 localStorage；false 仅本次会话 */
    setCookie: function (value, persist) {
      value = String(value || '').trim();
      memoryCookie = null;
      if (persist) {
        state.cookie = { value: value, savedAt: Date.now() };
      } else {
        memoryCookie = value;
        state.cookie = null;
      }
      save();
    },

    clearCookie: function () {
      memoryCookie = null;
      state.cookie = null;
      save();
    },

    clearAll: function () {
      memoryCookie = null;
      state = Object.assign({}, DEFAULTS);
      if (backupTimer) {
        clearTimeout(backupTimer);
        backupTimer = null;
      }
      dropBackup();
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch (e) {
        /* ignore */
      }
    },

    /** 新环境首次打开时尝试从服务端备份恢复（true 时应刷新页面） */
    restoreIfNeeded: restoreIfNeeded,

    /** 立即上传当前状态为备份 */
    backupNow: backupNow,

    /** 强制从备份恢复（设置里手动触发） */
    restoreFromBackup: restoreFromBackup,

    /** 当前状态是否有真实数据（供界面判断能不能恢复） */
    hasRealData: function () { return hasRealData(state); }
  };
})();
