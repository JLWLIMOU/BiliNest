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
    entriesFromFiles: entriesFromFiles,
    restoreEntry: restoreEntry,
    getUrl: getUrl,
    removeEntry: removeEntry
  };
})();
