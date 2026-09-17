/**
 * BiliNest 本地视频文件管理
 * ------------------------------------------------------------
 * 优先使用 File System Access API（showOpenFilePicker）：
 *   - 直接唤起系统资源管理器选择文件；
 *   - 文件句柄存入 IndexedDB，刷新页面后仍可恢复播放权限。
 * 在不支持该 API 的浏览器中回退到 <input type="file">，
 * 此时文件仅在当前会话内可播放。
 */
window.BiliNestLocal = (function () {
  'use strict';

  var DB_NAME = 'bilinest-files';
  // 旧版本（BiliPure）使用的数据库名：改名后首次打开自动迁移文件句柄
  var LEGACY_DB_NAME = 'bilipure-files';
  var STORE_NAME = 'handles';
  var urlMap = new Map(); // entryId -> objectURL
  var dbPromise = null;
  var legacyMigrated = false;

  /** 把旧库（BiliPure）里的本地文件句柄一次性复制到新库，成功后删除旧库 */
  function migrateLegacyDb(db) {
    if (legacyMigrated) return Promise.resolve();
    legacyMigrated = true;
    return new Promise(function (resolve) {
      try {
        var openReq = indexedDB.open(LEGACY_DB_NAME, 1);
        openReq.onsuccess = function () {
          var legacy = openReq.result;
          if (!legacy.objectStoreNames.contains(STORE_NAME)) {
            legacy.close();
            return resolve();
          }
          var allReq = legacy.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
          var keysReq = legacy.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAllKeys();
          allReq.onsuccess = function () {
            keysReq.onsuccess = function () {
              var keys = keysReq.result || [];
              var values = allReq.result || [];
              if (!keys.length) {
                legacy.close();
                return resolve();
              }
              var t = db.transaction(STORE_NAME, 'readwrite');
              for (var i = 0; i < keys.length; i++) {
                t.objectStore(STORE_NAME).put(values[i], keys[i]);
              }
              t.oncomplete = function () {
                legacy.close();
                try { indexedDB.deleteDatabase(LEGACY_DB_NAME); } catch (e) { /* 忽略 */ }
                resolve();
              };
              t.onerror = function () { legacy.close(); resolve(); };
            };
          };
          allReq.onerror = function () { legacy.close(); resolve(); };
          keysReq.onerror = function () { legacy.close(); resolve(); };
        };
        openReq.onerror = function () { resolve(); }; // 旧库不存在或打不开：跳过迁移
      } catch (e) {
        resolve();
      }
    });
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) {
          req.result.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = function () {
        migrateLegacyDb(req.result).then(
          function () { resolve(req.result); },
          function () { resolve(req.result); }
        );
      };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function putHandle(key, handle) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE_NAME, 'readwrite');
        t.objectStore(STORE_NAME).put(handle, key);
        t.oncomplete = function () { resolve(); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  function getHandle(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE_NAME, 'readonly');
        var req = t.objectStore(STORE_NAME).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  function deleteHandle(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE_NAME, 'readwrite');
        t.objectStore(STORE_NAME).delete(key);
        t.oncomplete = function () { resolve(); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  /** 通过系统文件选择器选择多个本地视频（返回条目数组） */
  async function pickFiles() {
    if (!window.showOpenFilePicker) return null; // 回退到 input[type=file]
    var handles = await window.showOpenFilePicker({
      multiple: true,
      id: 'bilinest-local',
      types: [
        {
          description: '视频文件',
          accept: {
            'video/*': ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.flv', '.ts', '.m4v']
          }
        }
      ]
    });
    var entries = [];
    for (var i = 0; i < handles.length; i++) {
      var file = await handles[i].getFile();
      var id = 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      try {
        await putHandle(id, handles[i]);
      } catch (e) {
        /* 句柄持久化失败不影响本次播放 */
      }
      entries.push({
        id: id,
        kind: 'local',
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        addedAt: Date.now(),
        stars: 0,
        handle: true,
        url: URL.createObjectURL(file)
      });
      urlMap.set(id, entries[entries.length - 1].url);
    }
    return entries;
  }

  var VIDEO_RE = /\.(mp4|mkv|webm|mov|avi|flv|ts|m4v)$/i;

  /** 文件名自然排序（"第2集" 排在 "第10集" 前面） */
  function byName(a, b) {
    try {
      return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
    } catch (e) {
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    }
  }

  function makeEntry(id, name, size, lastModified, handle) {
    return {
      id: id,
      kind: 'local',
      name: name,
      size: size,
      lastModified: lastModified,
      addedAt: Date.now(),
      stars: 0,
      handle: !!handle,
      url: null
    };
  }

  function newId() {
    return 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }

  /**
   * 通过系统文件夹选择器选一个文件夹，把里面的视频解析成"一个列表"。
   * 返回 { name, episodes:[条目] }；浏览器不支持该 API 时返回 null（调用方回退 input[webkitdirectory]）。
   */
  async function pickDirectory() {
    if (!window.showDirectoryPicker) return null;
    var dir = await window.showDirectoryPicker({ id: 'bilinest-folder', mode: 'read' });
    var files = [];
    try {
      for await (var handle of dir.values()) {
        if (!handle || handle.kind !== 'file') continue;
        if (!VIDEO_RE.test(handle.name)) continue;
        files.push(handle);
      }
    } catch (e) {
      /* 遍历中断：用已拿到的部分 */
    }
    files.sort(byName);
    var episodes = [];
    for (var i = 0; i < files.length; i++) {
      var file = null;
      try { file = await files[i].getFile(); } catch (e) { continue; }
      var id = newId();
      try { await putHandle(id, files[i]); } catch (e) { /* 句柄存不下也能本次会话播放 */ }
      urlMap.set(id, URL.createObjectURL(file));
      var ep = makeEntry(id, files[i].name, file.size, file.lastModified, true);
      ep.url = urlMap.get(id);
      episodes.push(ep);
    }
    return { name: dir.name, episodes: episodes };
  }

  /**
   * 兜底：<input type="file" webkitdirectory> 的 FileList（Firefox / Safari 走这条路）。
   * 以 webkitRelativePath 的第一段为文件夹名，其余的同级视频作为列表项。
   */
  function entriesFromDirFiles(fileList) {
    var files = [];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      var rel = f.webkitRelativePath || f.name;
      var parts = rel.split('/');
      if (parts.length < 2) continue;            // 必须来自子目录
      if (!VIDEO_RE.test(f.name)) continue;
      files.push({ file: f, rel: rel, name: parts[parts.length - 1], dir: parts[0] });
    }
    if (!files.length) return null;
    files.sort(byName);
    var target = files[0].dir;
    var episodes = [];
    for (var j = 0; j < files.length; j++) {
      if (files[j].dir !== target) continue;     // 只收同一个文件夹（多选时取第一层）
      var id = newId();
      var url = URL.createObjectURL(files[j].file);
      urlMap.set(id, url);
      var ep = makeEntry(id, files[j].name, files[j].file.size, files[j].file.lastModified, false);
      ep.url = url;
      episodes.push(ep);
    }
    return { name: target, episodes: episodes };
  }

  /** 兜底：由 <input type=file> 的 FileList 生成条目（仅本次会话可播放） */
  function entriesFromFiles(fileList) {
    var entries = [];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      var id = 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      var url = URL.createObjectURL(f);
      urlMap.set(id, url);
      entries.push({
        id: id,
        kind: 'local',
        name: f.name,
        size: f.size,
        lastModified: f.lastModified,
        addedAt: Date.now(),
        stars: 0,
        handle: false,
        url: url
      });
    }
    return entries;
  }

  /** 尝试恢复条目的可播放地址（持久化句柄或会话内 objectURL），失败返回 null */
  async function restoreEntry(entry) {
    if (urlMap.has(entry.id)) return urlMap.get(entry.id);
    if (entry.handle) {
      try {
        var handle = await getHandle(entry.id);
        if (!handle) return null;
        var perm = await handle.queryPermission({ mode: 'read' });
        if (perm !== 'granted') {
          perm = await handle.requestPermission({ mode: 'read' });
        }
        if (perm !== 'granted') return null;
        var file = await handle.getFile();
        var url = URL.createObjectURL(file);
        urlMap.set(entry.id, url);
        return url;
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  function getUrl(id) {
    return urlMap.get(id) || null;
  }

  function revoke(id) {
    var u = urlMap.get(id);
    if (u) {
      try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ }
      urlMap.delete(id);
    }
  }

  async function removeEntry(entry) {
    revoke(entry.id);
    if (entry.handle) {
      try { await deleteHandle(entry.id); } catch (e) { /* ignore */ }
    }
  }

  return {
    pickFiles: pickFiles,
    pickDirectory: pickDirectory,
    entriesFromDirFiles: entriesFromDirFiles,
    entriesFromFiles: entriesFromFiles,
    restoreEntry: restoreEntry,
    getUrl: getUrl,
    removeEntry: removeEntry
  };
})();
