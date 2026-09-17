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
  var urlMap = new Map(); // entryId -> 最近一次创建的 objectURL
  var fileMap = new Map(); // entryId -> File（input / webkitdirectory 这类只在本次会话有效的条目）
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
            'video/mp4': ['.mp4', '.m4v'],
            'video/quicktime': ['.mov'],
            'video/webm': ['.webm'],
            'video/x-matroska': ['.mkv']
          }
        }
      ]
    });
    var entries = [];
    for (var i = 0; i < handles.length; i++) {
      var file = await handles[i].getFile();
      var id = 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      // 先探一次：时长要写进卡片 / 选集，浏览器解不了的文件也在这里被挡下
      var probeUrl = URL.createObjectURL(file);
      var probe = await probeVideo(probeUrl);
      URL.revokeObjectURL(probeUrl);
      if (!probe.ok) continue;
      try {
        await putHandle(id, handles[i]);
      } catch (e) {
        /* 句柄持久化失败不影响本次播放 */
      }
      fileMap.set(id, file);
      entries.push({
        id: id,
        kind: 'local',
        name: file.name,
        size: file.size,
        duration: probe.duration,
        lastModified: file.lastModified,
        addedAt: Date.now(),
        stars: 0,
        handle: true
      });
    }
    return entries;
  }

  /*
   * 只收浏览器原生能播的容器：mp4 / m4v / mov（H.264 + AAC）、webm、mkv。
   * avi / flv / ts / rmvb 这些浏览器解不了，放进列表只会"点开就报错"，
   * 所以解析文件夹时直接跳过；下面还会用 <video preload=metadata> 实测一遍，
   * 连编码不兼容（比如 HEVC 的 mp4）也会被挡在外面。
   */
  var VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv)$/i;
  var PROBE_TIMEOUT_MS = 6000;

  /** 用临时 <video> 探一次：能不能播、时长多少 */
  function probeVideo(url) {
    return new Promise(function (resolve) {
      var v = document.createElement('video');
      var done = false;
      var finish = function (ok) {
        if (done) return;
        done = true;
        var dur = ok && isFinite(v.duration) ? v.duration : 0;
        try { v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ }
        resolve({ ok: ok, duration: dur });
      };
      v.preload = 'metadata';
      v.onloadedmetadata = function () { finish(true); };
      v.onerror = function () { finish(false); };
      setTimeout(function () { finish(false); }, PROBE_TIMEOUT_MS);
      v.src = url;
    });
  }

  /** 按 4 个一批并发跑（文件夹里几十个文件时别一个接一个地等） */
  async function mapLimit(items, limit, fn) {
    var out = [];
    for (var i = 0; i < items.length; i += limit) {
      var batch = items.slice(i, i + limit);
      var res = await Promise.all(batch.map(fn));
      out = out.concat(res);
    }
    return out;
  }

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
      duration: 0,
      lastModified: lastModified,
      addedAt: Date.now(),
      stars: 0,
      handle: !!handle
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
    var skipped = 0;
    var probed = await mapLimit(files, 4, async function (handle) {
      var file = null;
      try { file = await handle.getFile(); } catch (e) { return null; }
      var url = URL.createObjectURL(file);
      var probe = await probeVideo(url);
      URL.revokeObjectURL(url);
      if (!probe.ok) { skipped++; return null; }   // 浏览器解不了（avi 之类）：不放进列表
      return { handle: handle, file: file, duration: probe.duration };
    });
    var episodes = [];
    for (var i = 0; i < probed.length; i++) {
      var it = probed[i];
      if (!it) continue;
      var id = newId();
      try { await putHandle(id, it.handle); } catch (e) { /* 句柄存不下也能本次会话播放 */ }
      fileMap.set(id, it.file);
      var ep = makeEntry(id, it.file.name, it.file.size, it.file.lastModified, true);
      ep.duration = it.duration;
      episodes.push(ep);
    }
    return { name: dir.name, episodes: episodes, skipped: skipped };
  }

  /**
   * 兜底：<input type="file" webkitdirectory> 的 FileList（Firefox / Safari 走这条路）。
   * 以 webkitRelativePath 的第一段为文件夹名，其余的同级视频作为列表项。
   */
  async function entriesFromDirFiles(fileList) {
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
    var picked = files.filter(function (f) { return f.dir === target; });  // 只收同一个文件夹
    var skipped = 0;
    var probed = await mapLimit(picked, 4, async function (item) {
      var url = URL.createObjectURL(item.file);
      var probe = await probeVideo(url);
      URL.revokeObjectURL(url);
      if (!probe.ok) { skipped++; return null; }
      return { item: item, duration: probe.duration };
    });
    var episodes = [];
    for (var j = 0; j < probed.length; j++) {
      var hit = probed[j];
      if (!hit) continue;
      var id = newId();
      fileMap.set(id, hit.item.file);
      var ep = makeEntry(id, hit.item.name, hit.item.file.size, hit.item.file.lastModified, false);
      ep.duration = hit.duration;
      episodes.push(ep);
    }
    return { name: target, episodes: episodes, skipped: skipped };
  }

  /** 兜底：由 <input type=file> 的 FileList 生成条目（仅本次会话可播放） */
  async function entriesFromFiles(fileList) {
    var files = [];
    for (var i = 0; i < fileList.length; i++) files.push(fileList[i]);
    var probed = await mapLimit(files, 4, async function (f) {
      var url = URL.createObjectURL(f);
      var probe = await probeVideo(url);
      URL.revokeObjectURL(url);
      return probe.ok ? { file: f, duration: probe.duration } : null;
    });
    var entries = [];
    for (var j = 0; j < probed.length; j++) {
      if (!probed[j]) continue;
      var f = probed[j].file;
      var id = 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      fileMap.set(id, f);
      entries.push({
        id: id,
        kind: 'local',
        name: f.name,
        size: f.size,
        duration: probed[j].duration,
        lastModified: f.lastModified,
        addedAt: Date.now(),
        stars: 0,
        handle: false
      });
    }
    return entries;
  }

  /**
   * 取一个**全新的**可播放地址。
   *
   * 为什么不能复用同一个 objectURL：ArtPlayer 的 `art.url = 新地址` setter 里会
   * `URL.revokeObjectURL(上一个地址)`（非自定义类型走这条分支）。本地视频每次都用
   * 同一个 blob 地址，第二次播放时就会被它 revoke 掉 → 报"视频加载失败（地址不支持）"
   * ／控制台 `net::ERR_FILE_NOT_FOUND`。所以每次播都新建一个，让 ArtPlayer 去回收上一个。
   */
  async function freshUrl(entry) {
    if (!entry) return null;
    var file = fileMap.get(entry.id) || null;
    if (!file && entry.handle) {
      try {
        var handle = await getHandle(entry.id);
        if (handle) {
          var perm = await handle.queryPermission({ mode: 'read' });
          if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'read' });
          if (perm === 'granted') file = await handle.getFile();
        }
      } catch (e) {
        /* 句柄不可用：交给调用方提示"无法读取本地文件" */
      }
    }
    if (!file) return null;
    var url = URL.createObjectURL(file);
    urlMap.set(entry.id, url);
    return url;
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
    fileMap.delete(entry.id);
    if (entry.handle) {
      try { await deleteHandle(entry.id); } catch (e) { /* ignore */ }
    }
  }

  return {
    pickFiles: pickFiles,
    pickDirectory: pickDirectory,
    entriesFromDirFiles: entriesFromDirFiles,
    entriesFromFiles: entriesFromFiles,
    freshUrl: freshUrl,
    getUrl: getUrl,
    removeEntry: removeEntry
  };
})();
