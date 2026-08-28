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

  var DEFAULTS = {
    v: 1,
    theme: 'auto',            // auto | light | dark
    cookie: null,             // { value, savedAt } —— 仅当用户选择持久化时存在
    sid: null,                // OAuth 会话 id（由本地代理服务器签发）
    login: null,              // { mid, uname } —— 最近一次校验通过的账号信息
    source: null,             // { kind:'folder', id, name } 或 { kind:'mine', name }
    sort: 'star',             // add=添加时间 | pub=发布时间 | star=星级 | play=播放量
    subSettings: { pos: 100, size: 'md' }, // 字幕位置（滑块 0~100）/ 字号
    customVideos: [],         // 手动添加的 B 站视频 / 本地视频
    studyFolders: [],         // 学习收藏夹：{ id, title, cover, mediaCount, addedAt, stars }
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
      if (raw && raw.v === 1) return Object.assign({}, DEFAULTS, raw);
    } catch (e) {
      /* 数据损坏时回退默认值 */
    }
    // 兼容旧键：一次性迁移到新键并删除旧键
    try {
      var legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || 'null');
      if (legacy && legacy.v === 1) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));
        localStorage.removeItem(LEGACY_STORAGE_KEY);
        return Object.assign({}, DEFAULTS, legacy);
      }
    } catch (e) {
      /* 旧数据损坏则忽略 */
    }
    return Object.assign({}, DEFAULTS);
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* localStorage 不可用（例如隐私模式）时静默失败 */
    }
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
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch (e) {
        /* ignore */
      }
    }
  };
})();
