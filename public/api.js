/**
 * BiliNest API 客户端
 * ------------------------------------------------------------
 * 设计：
 *   - 优先通过本地代理（同源 /api/bili/* 或 http://127.0.0.1:4173）访问 B 站接口，
 *     彻底规避浏览器 CORS 限制，且凭据只发给本机服务，不发给任何第三方；
 *   - 未检测到代理时回退为直连 api.bilibili.com（通常会被 CORS 拦截，仅作兜底）。
 */
window.BiliNestAPI = (function () {
  'use strict';

  var DEFAULT_BACKEND = 'http://127.0.0.1:4173';
  var backendBase = null; // '' = 同源；null = 未检测到可用后端
  var backendInfo = null;

  /** 探测本地代理是否可用（同源优先，其次默认端口） */
  async function init() {
    var candidates = [];
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      candidates.push({ base: '', timeout: 2500 });
    }
    // 默认端口 4173 可能被其它程序占用，服务会自动顺延端口；
    // 这里从默认端口开始扫描一段顺延区间，保证页面与后端总能配对。
    var defaultPort = 4173;
    try { defaultPort = Number(new URL(DEFAULT_BACKEND).port) || 4173; } catch (e) { /* 保持默认 */ }
    for (var p = defaultPort; p <= defaultPort + 10; p++) {
      candidates.push({ base: 'http://127.0.0.1:' + p, timeout: 500 });
    }

    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var base = c.base;
      try {
        var ctrl = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, c.timeout);
        var res = await fetch(base + '/api/health', { signal: ctrl.signal });
        clearTimeout(timer);
        if (res.ok) {
          // 校验响应确实是 BiliNest（防止端口被其它程序占用时误连）
          var info = null;
          try {
            info = await res.json();
          } catch (e) {
            /* 非 JSON 视为不匹配 */
          }
          if (!info || info.app !== 'bilinest') continue;
          backendBase = base;
          backendInfo = info;
          return {
            ok: true,
            base: base,
            oauthEnabled: !!(backendInfo && backendInfo.oauthEnabled)
          };
        }
      } catch (e) {
        /* 继续尝试下一个候选地址 */
      }
    }
    backendBase = null;
    return { ok: false, base: null, oauthEnabled: false };
  }

  /**
   * 发起一次 B 站只读接口请求。
   * @param {string} path  B 站 API 路径，例如 /x/v3/fav/resource/list
   * @param {object} opts  { params, creds }；creds = { cookie, sid }
   * @returns {Promise<object>} 接口的 data 字段
   */
  async function request(path, opts) {
    opts = opts || {};
    var params = new URLSearchParams(opts.params || {});
    var qs = params.toString();
    var url;
    if (backendBase !== null) {
      url = backendBase + '/api/bili' + path + (qs ? '?' + qs : '');
    } else {
      url = 'https://api.bilibili.com' + path + (qs ? '?' + qs : '');
    }

    var headers = {};
    var creds = opts.creds || {};
    if (creds.cookie) headers['X-Bili-Cookie'] = creds.cookie;
    if (creds.sid) headers['X-Bilinest-Sid'] = creds.sid;

    var res;
    try {
      res = await fetch(url, { headers: headers });
    } catch (e) {
      throw new Error(
        backendBase === null
          ? '未检测到本地代理服务，且直连被浏览器跨域策略拦截。请先运行 npm start。'
          : '网络请求失败：' + e.message
      );
    }

    var json = null;
    try {
      json = await res.json();
    } catch (e) {
      /* 非 JSON 响应 */
    }

    if (res.status === 412 || (json && json.code === -412)) {
      throw new Error('请求被 B 站风控拦截（412），请稍等片刻再试');
    }
    if (json && json.code !== undefined && json.code !== 0) {
      throw new Error(friendlyError(json));
    }
    if (!res.ok) {
      throw new Error('请求失败（HTTP ' + res.status + '）');
    }
    return json ? json.data : json;
  }

  function friendlyError(json) {
    var code = json && json.code;
    var msg = json && json.message;
    var map = {
      '-101': '登录状态无效：Cookie 或 OAuth 会话已失效/过期，请重新登录',
      '-400': '请求参数错误',
      '-403': '没有访问权限：收藏夹可能为私密，或当前凭据无权限',
      '-404': '内容不存在或已失效',
      '-412': '请求被 B 站风控拦截，请稍后再试'
    };
    if (code !== undefined && map[String(code)]) return map[String(code)];
    if (msg && msg !== '0' && msg !== 'success') return 'B 站接口错误：' + msg;
    return '接口请求失败';
  }

  /** 当前账号信息（Cookie 或 OAuth access_key 均可） */
  async function myinfo(creds) {
    return request('/x/v2/account/myinfo', { creds: creds });
  }

  /** Web 端登录信息（Cookie 方式，返回 mid / uname / isLogin） */
  async function nav(creds) {
    return request('/x/web-interface/nav', { creds: creds });
  }

  /** 我创建的收藏夹列表 */
  async function folders(mid, creds) {
    // 优先使用全量接口；失败时回退分页接口
    try {
      var data = await request('/x/v3/fav/folder/created/list-all', {
        params: { up_mid: mid },
        creds: creds
      });
      if (data && Array.isArray(data.list)) return data.list;
    } catch (e) {
      /* 落到分页接口 */
    }
    var d2 = await request('/x/v3/fav/folder/created/list', {
      params: { up_mid: mid, pn: 1, ps: 20 },
      creds: creds
    });
    return (d2 && d2.list) || [];
  }

  /** 收藏夹内容（每页 20 条） */
  async function folderVideos(mediaId, pn, creds) {
    var data = await request('/x/v3/fav/resource/list', {
      params: { media_id: mediaId, platform: 'web', pn: pn, ps: 20 },
      creds: creds
    });
    return {
      medias: (data && data.medias) || [],
      hasMore: !!(data && data.has_more),
      info: (data && data.info) || null
    };
  }

  /** 视频详情（含分P pages 与合集 ugc_season） */
  async function videoInfo(id, creds) {
    var params = /^\d+$/.test(String(id)) ? { aid: id } : { bvid: id };
    return request('/x/web-interface/view', { params: params, creds: creds });
  }

  /** 播放地址（自研播放器用，fnval=0 返回可直接播放的 progressive MP4） */
  async function playurl(bvid, cid, qn, creds) {
    return request('/x/player/wbi/playurl', {
      params: {
        bvid: bvid,
        cid: cid,
        qn: qn || 80,
        fnval: 0,
        fourk: 1,
        platform: 'html5',
        high_quality: 1
      },
      creds: creds
    });
  }

  /** 分 P 列表（用于缺失 cid 时按页码解析出正确的 cid） */
  async function pagelist(bvid, creds) {
    return request('/x/player/pagelist', { params: { bvid: bvid }, creds: creds });
  }

  /** 弹幕 XML（原样返回文本，供 DOMParser 解析） */
  async function danmakuXml(cid, creds) {
    return rawRequest('/x/v1/dm/list.so', { params: { oid: cid }, creds: creds });
  }

  /**
   * 弹幕分段（官方网页端方案，完整度远高于 XML 实时弹幕池）：
   * 由本地服务 /api/danmaku/segments 代为请求 x/v2/dm/{wbi/}web/seg.so，
   * 并把 protobuf 二进制解码为 JSON；每 6 分钟一包、每包最多 6000 条。
   * @returns {Promise<{elems: Array<{progress,mode,fontsize,color,content}>}>}
   */
  async function danmakuSegments(cid, segmentIndex, creds) {
    var base = backendBase !== null ? backendBase : '';
    var qs =
      'cid=' + encodeURIComponent(cid) +
      '&segment_index=' + encodeURIComponent(segmentIndex);
    var headers = {};
    var c = creds || {};
    if (c.cookie) headers['X-Bili-Cookie'] = c.cookie;
    if (c.sid) headers['X-Bilinest-Sid'] = c.sid;
    var res = await fetch(base + '/api/danmaku/segments?' + qs, { headers: headers });
    var json = null;
    try {
      json = await res.json();
    } catch (e) {
      /* 非 JSON 响应 */
    }
    if (!res.ok || (json && json.code !== undefined && json.code !== 0)) {
      throw new Error((json && json.message) || '弹幕分段请求失败（HTTP ' + res.status + '）');
    }
    return (json && json.data) || { elems: [] };
  }

  /**
   * 播放器配置（CC 字幕列表等）。
   * 注意：旧接口 /x/player/v2 存在返回“其它视频字幕”的已知不稳定问题，
   * 统一改用官方现用的 WBI 签名版 /x/player/wbi/v2（响应结构一致）。
   */
  async function playerV2(bvid, cid, creds) {
    return request('/x/player/wbi/v2', { params: { bvid: bvid, cid: cid }, creds: creds });
  }

  /** 通过本地受控代理读取字幕 JSON（hdslb.com） */
  async function subtitleJson(url, creds) {
    var base = backendBase !== null ? backendBase : '';
    var res = await fetch(base + '/api/subtitle?url=' + encodeURIComponent(url));
    return res.json();
  }

  /** 与 request 相同，但返回原始文本（用于 XML 等非 JSON 响应） */
  async function rawRequest(path, opts) {
    opts = opts || {};
    var params = new URLSearchParams(opts.params || {});
    var qs = params.toString();
    var url;
    if (backendBase !== null) {
      url = backendBase + '/api/bili' + path + (qs ? '?' + qs : '');
    } else {
      url = 'https://api.bilibili.com' + path + (qs ? '?' + qs : '');
    }
    var headers = {};
    var creds = opts.creds || {};
    if (creds.cookie) headers['X-Bili-Cookie'] = creds.cookie;
    if (creds.sid) headers['X-Bilinest-Sid'] = creds.sid;
    var res = await fetch(url, { headers: headers });
    if (!res.ok) throw new Error('弹幕接口请求失败（HTTP ' + res.status + '）');
    return res.text();
  }

  /**
   * 解析用户粘贴的文本：
   * 支持完整链接（含 p 参数）、短链内 BV 号、纯 BV 号、纯 av 号。
   * 返回 { kind:'bvid'|'aid', id, page } 或 null。
   */
  function parseVideoRef(text) {
    var t = String(text || '').trim();
    if (!t) return null;

    var m = t.match(/video\/(BV[0-9A-Za-z]+)/i);
    if (m) {
      var page = 1;
      try {
        var p = new URL(t).searchParams.get('p');
        if (p) page = parseInt(p, 10) || 1;
      } catch (e) {
        /* 不是完整 URL 也没关系 */
      }
      return { kind: 'bvid', id: m[1], page: page };
    }

    m = t.match(/(^|\s)(BV[0-9A-Za-z]{10,})(\s|$)/);
    if (m) return { kind: 'bvid', id: m[2], page: 1 };

    m = t.match(/(?:av|AV)(\d+)/);
    if (m) return { kind: 'aid', id: m[1], page: 1 };

    return null;
  }

  return {
    init: init,
    request: request,
    myinfo: myinfo,
    nav: nav,
    folders: folders,
    folderVideos: folderVideos,
    videoInfo: videoInfo,
    playurl: playurl,
    pagelist: pagelist,
    danmakuXml: danmakuXml,
    danmakuSegments: danmakuSegments,
    playerV2: playerV2,
    subtitleJson: subtitleJson,
    parseVideoRef: parseVideoRef
  };
})();
