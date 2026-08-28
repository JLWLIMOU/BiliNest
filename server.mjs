#!/usr/bin/env node
/**
 * BiliNest —— 本地代理服务器
 * ------------------------------------------------------------------
 * 职责：
 *   1. 托管 public/ 目录下的前端静态页面（零第三方依赖，Node.js 18+ 即可运行）；
 *   2. 将前端发来的 B 站只读 API 请求转发到官方接口，规避浏览器跨域（CORS）限制；
 *   3. （可选）维护 B 站开放平台 OAuth 会话，需自行配置应用凭证。
 *
 * 安全设计：
 *   - 仅允许转发白名单内的少量只读接口，防止本机服务被当作任意 URL 的开放代理；
 *   - 不硬编码任何敏感信息：Cookie / OAuth 凭证全部来自请求头或环境变量；
 *   - 服务器不在磁盘上保存任何凭据；OAuth 会话仅存内存，服务重启即失效；
 *   - 内置基础频率限制，避免对 B 站接口造成压力。
 *
 * 用法：
 *   npm start                 # 等价于 node server.mjs
 *   浏览器打开 http://127.0.0.1:4173
 * ------------------------------------------------------------------
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOG_FILE = path.join(__dirname, 'bilinest.log');
const PORT_FILE = path.join(__dirname, 'bilinest.port');

// ---------- 基础配置（全部来自环境变量，不硬编码任何敏感信息） ----------
const HOST = process.env.BILINEST_HOST || '127.0.0.1';
const PORT = Number(process.env.BILINEST_PORT || 4173);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BILI_REFERER = 'https://www.bilibili.com/';

/* ------------------------------------------------------------------
 * 日志：同时输出到控制台与 bilinest.log（便于排查扫码登录等问题）
 * ------------------------------------------------------------------ */
function log(...args) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${args.join(' ')}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      fs.writeFileSync(LOG_FILE, '', 'utf8'); // 超过 2MB 截断，防止日志无限膨胀
    }
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (e) {
    /* 日志写入失败不应影响服务 */
  }
}

/* ------------------------------------------------------------------
 * 端口文件：把实际监听的端口写成纯数字文本（bilinest.port），
 * 供 launcher.vbs / start.sh 打开正确地址（默认端口被占用时会顺延）。
 * ------------------------------------------------------------------ */
function writePortFile(port) {
  try {
    fs.writeFileSync(PORT_FILE, String(port), 'utf8');
  } catch (e) {
    log(`[port] 写入端口文件失败：${e.message}`);
  }
}

function removePortFile() {
  try {
    if (fs.existsSync(PORT_FILE)) fs.unlinkSync(PORT_FILE);
  } catch (e) {
    /* 忽略删除失败 */
  }
}

/* ------------------------------------------------------------------
 * 1. API 白名单：path -> 上游 host
 *    只允许转发这些只读接口；其它路径一律 403。
 * ------------------------------------------------------------------ */
const API_ROUTES = new Map([
  ['/x/web-interface/nav', 'https://api.bilibili.com'],          // 登录信息 / WBI 密钥来源
  ['/x/web-interface/view', 'https://api.bilibili.com'],         // 视频详情（含分P与合集）
  ['/x/player/pagelist', 'https://api.bilibili.com'],            // 分P列表（备用）
  ['/x/v3/fav/folder/created/list', 'https://api.bilibili.com'], // 我创建的收藏夹（分页）
  ['/x/v3/fav/folder/created/list-all', 'https://api.bilibili.com'], // 我创建的收藏夹（全量）
  ['/x/v3/fav/resource/list', 'https://api.bilibili.com'],       // 收藏夹内容
  ['/x/v3/fav/resource/ids', 'https://api.bilibili.com'],        // 收藏夹内容 id（备用）
  ['/x/player/wbi/playurl', 'https://api.bilibili.com'],         // 播放地址（自研播放器）
  ['/x/player/v2', 'https://api.bilibili.com'],                  // 字幕/弹幕配置（旧接口，不稳定时勿用）
  ['/x/player/wbi/v2', 'https://api.bilibili.com'],              // 字幕/弹幕配置（WBI 签名版，官方现用）
  ['/x/v1/dm/list.so', 'https://api.bilibili.com'],              // 弹幕 XML（自研播放器）
  ['/x/v2/account/myinfo', 'https://app.bilibili.com'],          // 当前账号信息（Cookie 或 access_key）
]);

// 这些接口在被风控拦截（412）时，会尝试用 WBI 签名重试一次
const WBI_RETRY_PATHS = new Set(
  [...API_ROUTES.keys()].filter(
    (p) =>
      p === '/x/web-interface/view' ||
      p === '/x/player/pagelist' ||
      p === '/x/player/wbi/playurl' ||
      p === '/x/player/wbi/v2' ||
      p.startsWith('/x/v3/fav/')
  )
);

/* ------------------------------------------------------------------
 * 1.3 字幕 JSON 代理
 *     字幕文件位于 *.hdslb.com，部分浏览器会因 CORS 拦截；
 *     这里提供一个只允许 hdslb.com 域名的受控代理。
 * ------------------------------------------------------------------ */
async function handleSubtitleProxy(res, url) {
  if (!rateLimitOk('subtitle')) {
    return sendJson(res, 429, { code: -429, message: '请求过于频繁，请稍后再试' });
  }
  const target = String(url.searchParams.get('url') || '');
  if (!/^https:\/\/([a-z0-9-]+\.)*hdslb\.com\//i.test(target)) {
    return sendJson(res, 403, { code: -403, message: '仅允许代理 hdslb.com 域名' });
  }
  try {
    const r = await fetch(target, {
      headers: { 'User-Agent': UA, Referer: BILI_REFERER },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await r.text();
    res.writeHead(r.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(),
    });
    res.end(body);
  } catch (e) {
    log(`[subtitle] proxy error: ${e.message}`);
    sendJson(res, 502, { code: -502, message: '字幕加载失败：' + e.message });
  }
}

/* ------------------------------------------------------------------
 * 1.4 视频流代理
 *     B 站 CDN 有防盗链：视频地址的 Referer 必须是 bilibili.com，
 *     否则返回 403（浏览器就会报“地址不支持”）。
 *     浏览器侧无法伪造 Referer，因此由本地服务器代为请求（带 bilibili
 *     Referer + UA），并把响应（含 Range / 206 分片）原样转发给播放器。
 * ------------------------------------------------------------------ */
const VIDEO_HOST_OK = (host) =>
  /(^|\.)bilivideo\.com$/i.test(host) ||
  /(^|\.)bilivideo\.cn$/i.test(host) ||
  /(^|\.)mcdn\.bilivideo\.cn$/i.test(host) ||
  /(^|\.)edge\.mountaintoys\.cn$/i.test(host) ||
  /(^|\.)hdslb\.com$/i.test(host);

// 每个 CDN 域名只记一次请求日志，避免被 Range 分片请求刷屏
const videoProxyLoggedHosts = new Set();

async function handleVideoProxy(req, res, url) {
  const target = String(url.searchParams.get('url') || '');
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return sendJson(res, 400, { code: -400, message: '无效的视频地址' });
  }
  if (!/^https?:$/.test(parsed.protocol) || !VIDEO_HOST_OK(parsed.hostname)) {
    return sendJson(res, 403, { code: -403, message: '仅允许代理 B 站视频域名' });
  }

  const headers = { 'User-Agent': UA, Referer: BILI_REFERER };
  if (req.headers.range) headers.Range = String(req.headers.range);

  // 上游（B 站 CDN）偶发 5xx/429/网络抖动：代理内部重试几次再决定是否报错，
  // 这样绝大多数瞬时失败会被吸收，浏览器看到的是一条连续成功的流，不会触发播放器反复重试。
  // 仅 5xx / 429 可重试；4xx（含 403 防盗链）重试无意义。
  const MAX_TRIES = 3;
  let upstream = null;
  let lastErr = null;
  let controller = null;
  // 浏览器断开（暂停 / 跳转 / 切换地址）时取消上游请求，避免连接泄漏
  req.on('close', () => { if (controller) controller.abort(); });
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 300 * attempt));
    controller = new AbortController();
    try {
      const resp = await fetch(target, {
        headers,
        redirect: 'follow',
        signal: controller.signal,
      });
      if (resp.status >= 500 || resp.status === 429) {
        lastErr = new Error('upstream ' + resp.status);
        try { await resp.arrayBuffer(); } catch (e) { /* 忽略 */ }
        continue;
      }
      upstream = resp;
      break;
    } catch (e) {
      lastErr = e;
      continue; // 网络错误重试
    }
  }

  if (!upstream) {
    log(`[video-proxy] error: ${lastErr && lastErr.message}`);
    if (!res.headersSent) {
      sendJson(res, 502, { code: -502, message: '视频代理请求失败：' + (lastErr && lastErr.message) });
    } else {
      res.end();
    }
    return;
  }

  try {
    const respHeaders = {
      'Cache-Control': 'no-store',
      'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
      'Content-Type': upstream.headers.get('content-type') || 'video/mp4',
      ...corsHeaders(),
    };
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) respHeaders['Content-Length'] = contentLength;
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) respHeaders['Content-Range'] = contentRange;

    if (!videoProxyLoggedHosts.has(parsed.hostname)) {
      videoProxyLoggedHosts.add(parsed.hostname);
      log(
        `[video-proxy] ${req.method} ${parsed.hostname} http=${upstream.status}` +
        ` range=${req.headers.range ? 'yes' : 'no'}`
      );
    }

    // 上游 4xx：读一小段响应体记录下来，便于判断是 CDN 404 还是防盗链 403
    if (upstream.status >= 400) {
      let errBody = '';
      try {
        errBody = Buffer.from(await upstream.arrayBuffer())
          .subarray(0, 180)
          .toString('utf8')
          .replace(/\s+/g, ' ')
          .trim();
      } catch {
        /* 忽略 */
      }
      log(`[video-proxy] upstream ${upstream.status} body=${errBody}`);
      const errBuf = Buffer.from(errBody || '');
      delete respHeaders['Content-Length'];
      delete respHeaders['Content-Range'];
      respHeaders['Content-Length'] = String(errBuf.length);
      res.writeHead(upstream.status, respHeaders);
      return res.end(errBuf);
    }

    res.writeHead(upstream.status, respHeaders);
    if (req.method === 'HEAD') return res.end();

    if (upstream.body) {
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
    }
    res.end();
  } catch (e) {
    // 传输中途客户端断开（signal 被 abort）等：优雅结束即可
    log(`[video-proxy] stream error: ${e.message}`);
    if (!res.headersSent) {
      sendJson(res, 502, { code: -502, message: '视频流传输失败：' + e.message });
    } else {
      try { res.end(); } catch (_) { /* 已结束 */ }
    }
  }
}

/* ------------------------------------------------------------------
 * 1.5 弹幕分段接口（protobuf → JSON）
 *     旧 XML 接口（x/v1/dm/list.so）只返回“实时弹幕池”，数量有限、
 *     不够完整；官方网页端现在使用分段接口 x/v2/dm/wbi/web/seg.so，
 *     每 6 分钟一包、每包最多 6000 条，全部拉齐才是完整弹幕。
 *     该接口返回 protobuf 二进制，这里做零依赖的最小解码（手写 varint），
 *     只提取弹幕渲染需要的字段，转成 JSON 交给前端。
 * ------------------------------------------------------------------ */

/** 兼容新旧两种 protobuf 弹幕结构（见 decodeDanmakuElem 内说明） */
function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const byte = buf[pos++];
    // 逐字节累加：64 位字段的数值精度对跳过无影响，32 位字段完全精确
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value: result, pos };
    shift += 7;
    if (shift > 63) break; // 异常数据保护，避免死循环
  }
  return { value: result, pos: buf.length };
}

/** 读取一条 length-delimited（wire type 2）字段的内容字节 */
function readBytes(buf, pos) {
  const len = readVarint(buf, pos);
  const end = len.pos + len.value;
  if (end > buf.length) return { bytes: null, pos: buf.length };
  return { bytes: buf.subarray(len.pos, end), pos: end };
}

/**
 * 解码一条 DanmakuElem 弹幕。
 * 两种结构字段 2~5（progress/mode/fontsize/color）完全一致，仅 6 号以后不同：
 *   - 新结构（网页端现用）：6=midHash(string) 7=content(string) 8=ctime(varint) …
 *   - 旧结构（早期 seg.so）：6=content(string) 7=midHash(varint) 8=pool(varint) …
 * 因此 content 优先取 7 号字符串，没有则退回 6 号字符串，两种都兼容。
 */
function decodeDanmakuElem(buf) {
  const fields = {};
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.pos;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    if (wire === 0) {
      const v = readVarint(buf, pos);
      pos = v.pos;
      (fields[field] = fields[field] || []).push({ wire, v: v.value });
    } else if (wire === 2) {
      const b = readBytes(buf, pos);
      pos = b.pos;
      if (b.bytes === null) break;
      (fields[field] = fields[field] || []).push({ wire, bytes: b.bytes });
    } else if (wire === 1) {
      pos += 8; // 64 位定长字段，跳过
    } else if (wire === 5) {
      pos += 4; // 32 位定长字段，跳过
    } else {
      break; // 未知 wire type，放弃该消息
    }
  }
  const pick = (n, w) => {
    const arr = fields[n];
    return arr ? arr.find((x) => x.wire === w) : undefined;
  };
  const varint = (n) => {
    const f = pick(n, 0);
    return f ? f.v : undefined;
  };
  const str = (n) => {
    const f = pick(n, 2);
    return f ? f.bytes.toString('utf8') : undefined;
  };
  return {
    progress: varint(2) || 0,        // 出现时间（毫秒）
    mode: varint(3) || 1,            // 弹幕类型
    fontsize: varint(4) || 25,       // 字号
    color: varint(5) || 0xffffff,    // 颜色（十进制 RGB888）
    content: str(7) ?? str(6) ?? '', // 弹幕内容
  };
}

/**
 * 解码 DmSegMobileReply：
 *   1 号字段 elems（普通弹幕）、2 号字段 dmdm（补充弹幕）均为
 *   repeated DanmakuElem，一并提取合并，最大化弹幕完整度。
 */
function decodeDmSeg(buf) {
  const elems = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.pos;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    if (field !== 1 && field !== 2) {
      // 跳过其它字段（长度不确定，按 wire type 跳过）
      if (wire === 0) {
        const v = readVarint(buf, pos);
        pos = v.pos;
      } else if (wire === 2) {
        const b = readBytes(buf, pos);
        pos = b.pos;
      } else if (wire === 1) {
        pos += 8;
      } else if (wire === 5) {
        pos += 4;
      } else {
        break;
      }
      continue;
    }
    if (wire !== 2) {
      if (wire === 0) {
        const v = readVarint(buf, pos);
        pos = v.pos;
      } else if (wire === 1) {
        pos += 8;
      } else if (wire === 5) {
        pos += 4;
      }
      continue;
    }
    const b = readBytes(buf, pos);
    pos = b.pos;
    if (b.bytes === null) break;
    const d = decodeDanmakuElem(b.bytes);
    if (d.content) elems.push(d);
  }
  return elems;
}

/** 弹幕分段：优先 WBI 签名接口（官方现用），失败退回旧的无签名分段接口 */
async function handleDanmakuSegments(req, res, url) {
  if (!rateLimitOk(req.socket.remoteAddress || 'local')) {
    return sendJson(res, 429, { code: -429, message: '请求过于频繁，请稍后再试' });
  }
  const cid = String(url.searchParams.get('cid') || '').trim();
  const idx = parseInt(url.searchParams.get('segment_index') || '0', 10);
  if (!/^\d+$/.test(cid) || !Number.isInteger(idx) || idx < 1) {
    return sendJson(res, 400, { code: -400, message: '参数错误：需要合法的 cid 与 segment_index' });
  }
  const cookie = String(req.headers['x-bili-cookie'] || '');
  const params = new URLSearchParams({
    type: '1', // 1：视频弹幕
    oid: cid,
    segment_index: String(idx),
  });

  const attempts = [];
  const signedQuery = await wbiSignQuery(params);
  if (signedQuery) {
    attempts.push({ path: '/x/v2/dm/wbi/web/seg.so', qs: signedQuery });
  }
  attempts.push({ path: '/x/v2/dm/web/seg.so', qs: params.toString() });

  let lastErr = '';
  for (const a of attempts) {
    const headers = { 'User-Agent': UA, Referer: BILI_REFERER, Accept: '*/*' };
    if (cookie) {
      headers.Cookie = cookie;
      if (!cookie.includes('buvid3=')) {
        const finger = await getFingerprintCookies();
        if (finger) headers.Cookie = cookie + '; ' + finger;
      }
    } else {
      const finger = await getFingerprintCookies();
      if (finger) headers.Cookie = finger;
    }
    try {
      const upstream = await fetch(`https://api.bilibili.com${a.path}?${a.qs}`, {
        headers,
        signal: AbortSignal.timeout(12_000),
      });
      // B 站 CDN 对“该分段没有更多弹幕”返回 304（Not Modified，无响应体）。
      // 这属于正常结束信号，不是错误：返回空包，前端据此停止继续拉取。
      if (upstream.status === 304) {
        log(`[dm-seg] cid=${cid} seg=${idx} empty(304)`);
        return sendJson(res, 200, { code: 0, message: '0', data: { elems: [] } });
      }
      if (upstream.status !== 200) {
        lastErr = `http=${upstream.status}`;
        continue;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      // 空包 = 该分段没有弹幕（通常意味着已经到末尾）
      const elems = buf.length ? decodeDmSeg(buf) : [];
      log(
        `[dm-seg] cid=${cid} seg=${idx} elems=${elems.length}` +
        (a.path.includes('wbi') ? ' wbi' : ' legacy')
      );
      return sendJson(res, 200, { code: 0, message: '0', data: { elems } });
    } catch (e) {
      lastErr = e.message;
    }
  }
  log(`[dm-seg] cid=${cid} seg=${idx} failed: ${lastErr}`);
  return sendJson(res, 502, { code: -502, message: '弹幕分段获取失败：' + lastErr });
}

/* ------------------------------------------------------------------
 * 1.1 浏览器设备指纹 Cookie（buvid3 / buvid4）
 *     某些网络环境下，B 站风控要求请求携带这些“设备指纹”Cookie。
 *     服务器首次使用时自动从官方接口获取一次并缓存，模拟真实浏览器行为。
 * ------------------------------------------------------------------ */
const FINGER_COOKIE_TTL_MS = 24 * 3600 * 1000;
let fingerCache = { cookies: '', fetchedAt: 0 };

async function getFingerprintCookies() {
  if (fingerCache.cookies && Date.now() - fingerCache.fetchedAt < FINGER_COOKIE_TTL_MS) {
    return fingerCache.cookies;
  }
  try {
    const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'User-Agent': UA, Referer: BILI_REFERER },
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json();
    const b3 = json?.data?.b_3 || '';
    const b4 = json?.data?.b_4 || '';
    if (b3 && b4) {
      fingerCache = {
        cookies: `buvid3=${b3}; buvid4=${b4}; b_nut=${Math.round(Date.now() / 1000)}`,
        fetchedAt: Date.now(),
      };
    }
  } catch {
    /* 拿不到指纹就继续用客户端提供的 Cookie */
  }
  return fingerCache.cookies;
}

/* ------------------------------------------------------------------
 * 1.2 扫码登录（B 站 Web 二维码登录）
 *     流程：/api/qr/generate 生成二维码 -> 用户用 B 站 App 扫码确认
 *           -> /api/qr/poll 轮询；成功时服务端从 Set-Cookie 中截获
 *           SESSDATA 等会话 Cookie 交给前端，前端存好即可直接使用。
 *     该方式无需复制粘贴任何配置，也无需开放平台应用凭证。
 * ------------------------------------------------------------------ */

/** 用 Node https 发起 GET，返回 { status, headers, body }（可读取 Set-Cookie 数组） */
function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      u,
      {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          Referer: BILI_REFERER,
          Accept: 'application/json, text/plain, */*',
          ...(headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('请求超时')));
    req.end();
  });
}

async function handleQrGenerate(res) {
  if (!rateLimitOk('qr-generate')) {
    log('[qr] generate rejected by rate limit');
    return sendJson(res, 429, { code: -429, message: '请求过于频繁，请稍后再试' });
  }
  const finger = await getFingerprintCookies();
  try {
    const r = await httpsGet('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
      Cookie: finger,
    });
    const json = safeParse(r.body);
    if (!json || json.code !== 0 || !json.data?.qrcode_key) {
      log(`[qr] generate failed: code=${json?.code} message=${json?.message} http=${r.status}`);
      return sendJson(res, 200, { code: json?.code || -1, message: json?.message || '二维码生成失败' });
    }
    log(`[qr] generate ok key=${json.data.qrcode_key}`);
    return sendJson(res, 200, {
      code: 0,
      data: { qrcode_key: json.data.qrcode_key, url: json.data.url },
    });
  } catch (e) {
    log(`[qr] generate error: ${e.message}`);
    return sendJson(res, 502, { code: -502, message: '二维码生成失败：' + e.message });
  }
}

/** 从 Set-Cookie 数组里提取登录所需的会话 Cookie（只保留必要字段） */
function extractLoginCookies(setCookieArray) {
  const arr = Array.isArray(setCookieArray) ? setCookieArray : setCookieArray ? [setCookieArray] : [];
  const keep = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4', 'b_nut'];
  const found = [];
  for (const c of arr) {
    const semi = c.indexOf(';');
    const pair = (semi > 0 ? c.slice(0, semi) : c).trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (keep.includes(name)) found.push(`${name}=${pair.slice(eq + 1).trim()}`);
  }
  return found.join('; ');
}

async function handleQrPoll(req, res, url) {
  if (!rateLimitOk('qr-poll')) {
    log('[qr] poll rejected by rate limit');
    return sendJson(res, 429, { code: -429, message: '请求过于频繁，请稍后再试' });
  }
  const key = String(url.searchParams.get('key') || '').trim();
  if (!key) return sendJson(res, 400, { code: -400, message: '缺少 qrcode_key' });
  const finger = await getFingerprintCookies();
  try {
    const r = await httpsGet(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`,
      { Cookie: finger }
    );
    const json = safeParse(r.body);
    if (!json || typeof json.code !== 'number') {
      log(`[qr] poll bad response http=${r.status} body=${String(r.body).slice(0, 200)}`);
      return sendJson(res, 502, { code: -502, message: '扫码接口返回异常' });
    }
    // 注意：根 code=0 仅代表请求成功；真正的扫码状态在 data.code 中
    //   data.code：0=登录成功 | 86090=已扫码待确认 | 86101=未扫码 | 86038=已过期
    const data = json.data || {};
    const stateCode = typeof data.code === 'number' ? data.code : json.code;
    const result = { code: stateCode, message: data.message || json.message || '' };
    if (stateCode === 0) {
      // 登录成功：官方通过 Set-Cookie 下发 SESSDATA 等会话 Cookie
      let cookie = extractLoginCookies(r.headers['set-cookie']);
      // 兜底：若轮询响应没有携带 Cookie，尝试跟随官方 success 跳转链接补取
      if (!cookie.includes('SESSDATA=') && data.url) {
        try {
          const follow = await httpsGet(data.url, { Cookie: finger });
          const extra = extractLoginCookies(follow.headers['set-cookie']);
          if (extra.includes('SESSDATA=')) {
            log('[qr] poll SUCCESS via follow url fallback');
            cookie = extra;
          }
        } catch (e) {
          log(`[qr] follow url fallback failed: ${e.message}`);
        }
      }
      if (!cookie.includes('SESSDATA=')) {
        log(
          `[qr] poll SUCCESS but no SESSDATA. set-cookie=${JSON.stringify(r.headers['set-cookie'])} ` +
          `body=${String(r.body).slice(0, 300)}`
        );
        return sendJson(res, 502, { code: -502, message: '登录成功，但未能获取到会话 Cookie' });
      }
      log(`[qr] poll SUCCESS key=${key} cookieLen=${cookie.length}`);
      result.cookie = cookie;
      result.refreshUrl = data.url || '';
    } else {
      log(`[qr] poll key=${key} -> code=${stateCode} ${result.message}`);
    }
    return sendJson(res, 200, result);
  } catch (e) {
    log(`[qr] poll error: ${e.message}`);
    return sendJson(res, 502, { code: -502, message: '扫码轮询失败：' + e.message });
  }
}

/* ------------------------------------------------------------------
 * 2. 基础频率限制（防止误用 / 滥用）
 * ------------------------------------------------------------------ */
const RATE_WINDOW_MS = 10_000;
// 弹幕分段需要按顺序拉多个包（长视频可达数十包），放宽到 120 次/10s；
// 该限制只是本地保护，B 站自身仍有独立的接口风控。
const RATE_MAX = 120;
const rateBuckets = new Map();

function rateLimitOk(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  // 顺带清理过期桶，避免内存无限增长
  if (rateBuckets.size > 500) {
    for (const [k, v] of rateBuckets) {
      if (now > v.resetAt) rateBuckets.delete(k);
    }
  }
  return bucket.count <= RATE_MAX;
}

/* ------------------------------------------------------------------
 * 3. WBI 签名（仅作为接口返回 412 风控拦截时的重试手段）
 *    算法来自 B 站公开资料（bilibili-API-collect 的官方 JS 示例）。
 * ------------------------------------------------------------------ */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];
let wbiCache = { imgKey: '', subKey: '', fetchedAt: 0 };

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

/** 从 nav 返回的 URL 中提取 img/sub key（去掉路径与扩展名） */
function keyFromUrl(u) {
  const name = u.split('/').pop() || '';
  return name.replace(/\.(png|webp|jpg)$/i, '');
}

async function getWbiKeys() {
  if (wbiCache.imgKey && Date.now() - wbiCache.fetchedAt < 3600_000) return wbiCache;
  try {
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'User-Agent': UA, Referer: BILI_REFERER },
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json();
    const img = json?.data?.wbi_img?.img_url || '';
    const sub = json?.data?.wbi_img?.sub_url || '';
    if (img && sub) {
      wbiCache = { imgKey: keyFromUrl(img), subKey: keyFromUrl(sub), fetchedAt: Date.now() };
    }
  } catch {
    /* 拿不到就保留旧密钥（可能为空，则放弃签名重试） */
  }
  return wbiCache;
}

function getMixinKey(orig) {
  return MIXIN_KEY_ENC_TAB.map((i) => orig[i]).join('').slice(0, 32);
}

/** 返回追加了 wts / w_rid 的查询字符串；密钥缺失时返回 null */
async function wbiSignQuery(params) {
  const { imgKey, subKey } = await getWbiKeys();
  if (!imgKey || !subKey) return null;
  const mixinKey = getMixinKey(imgKey + subKey);
  const wts = Math.round(Date.now() / 1000);
  const chrFilter = /[!'()*]/g;
  const entries = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const query = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v)).replace(chrFilter, '')}`)
    .join('&');
  const wRid = md5(query + mixinKey);
  return `${query}&w_rid=${wRid}&wts=${wts}`;
}

/* ------------------------------------------------------------------
 * 4. OAuth 会话（可选：需在 B 站开放平台注册应用并配置环境变量）
 *    流程：授权页 -> 回调 code -> 换 access_token -> 存内存会话
 *    access_token 通过 access_key 参数访问 B 站 APP 鉴权接口。
 * ------------------------------------------------------------------ */
const oauth = {
  clientId: process.env.BILINEST_OAUTH_CLIENT_ID || '',
  clientSecret: process.env.BILINEST_OAUTH_CLIENT_SECRET || '',
  // 默认回调地址在端口确定后再填充（端口被占用顺延时必须跟着走），
  // 也可用 BILINEST_OAUTH_REDIRECT_URI 显式覆盖。
  redirectUri: process.env.BILINEST_OAUTH_REDIRECT_URI || '',
};
oauth.enabled = Boolean(oauth.clientId && oauth.clientSecret);

const oauthStates = new Map();   // state -> createdAt
const oauthClaims = new Map();   // claimToken -> { sid, createdAt }（一次性领取）
const oauthSessions = new Map(); // sid -> { accessToken, refreshToken, expiresAt }

/** 会话令牌过期前 2 分钟自动续期；续期失败则删除会话 */
async function resolveOauthToken(sid) {
  const s = oauthSessions.get(sid);
  if (!s) return null;
  if (s.expiresAt - Date.now() > 120_000) return s.accessToken;
  if (!s.refreshToken) {
    oauthSessions.delete(sid);
    return null;
  }
  try {
    const body = new URLSearchParams({
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: s.refreshToken,
    });
    const res = await fetch('https://passport.bilibili.com/x/passport-login/oauth2/token', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json();
    if (json?.code === 0 && json?.data?.access_token) {
      s.accessToken = json.data.access_token;
      if (json.data.refresh_token) s.refreshToken = json.data.refresh_token;
      const ttl = Number(json.data.expires_in) || 0;
      s.expiresAt = Date.now() + (ttl > 1000 ? ttl * 1000 : 30 * 24 * 3600 * 1000);
      return s.accessToken;
    }
  } catch {
    /* 刷新失败走下面删除会话 */
  }
  oauthSessions.delete(sid);
  return null;
}

/* ------------------------------------------------------------------
 * 5. HTTP 工具
 * ------------------------------------------------------------------ */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Bili-Cookie, X-Bili-Access-Key, X-Bilinest-Sid, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...corsHeaders(),
  });
  res.end(JSON.stringify(obj));
}

function sendRedirect(res, location) {
  res.writeHead(302, { Location: location, ...corsHeaders() });
  res.end();
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function sendHtml(res, status, message) {
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>BiliNest</title>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:80px auto;line-height:1.7">
<h2>BiliNest</h2><p>${escHtml(message)}</p>
<p><a href="/">返回应用</a></p></body></html>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

/* ------------------------------------------------------------------
 * 6. B 站 API 代理
 * ------------------------------------------------------------------ */
async function fetchUpstream(base, apiPath, params, headers) {
  const qs = typeof params === 'string' ? params : params.toString();
  const url = `${base}${apiPath}${qs ? '?' + qs : ''}`;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000), redirect: 'follow' });
    return {
      status: res.status,
      body: await res.text(),
      contentType: res.headers.get('content-type') || 'application/json; charset=utf-8',
    };
  } catch (err) {
    return {
      status: 502,
      body: JSON.stringify({ code: -502, message: '上游请求失败：' + err.message }),
      contentType: 'application/json; charset=utf-8',
    };
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从 URL 里安全地取出域名（用于日志，不打印完整签名地址） */
function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function proxyBiliApi(req, res, url) {
  const apiPath = url.pathname.slice('/api/bili'.length);
  const upstreamBase = API_ROUTES.get(apiPath);
  if (!upstreamBase) {
    return sendJson(res, 403, { code: -403, message: '该接口不在允许列表中' });
  }
  if (!rateLimitOk(req.socket.remoteAddress || 'local')) {
    return sendJson(res, 429, { code: -429, message: '请求过于频繁，请稍后再试' });
  }

  // 凭据来源：请求头（浏览器端 localStorage 中的 Cookie）或 OAuth 会话
  const cookie = String(req.headers['x-bili-cookie'] || '');
  let accessKey = String(req.headers['x-bili-access-key'] || '');
  const sid = String(req.headers['x-bilinest-sid'] || '');
  if (sid) {
    const token = await resolveOauthToken(sid);
    if (token) {
      accessKey = token;
    } else {
      return sendJson(res, 401, { code: -101, message: 'OAuth 会话已失效，请重新登录' });
    }
  }

  // 组装查询参数（APP 鉴权要求 access_key 尽量靠前）
  const params = new URLSearchParams();
  if (accessKey) params.set('access_key', accessKey);
  for (const [k, v] of url.searchParams) params.append(k, v);

  const headers = {
    'User-Agent': UA,
    Referer: BILI_REFERER,
    Accept: 'application/json, text/plain, */*',
  };
  if (cookie) {
    headers.Cookie = cookie;
    // 客户端未提供设备指纹时自动补上（模拟真实浏览器，降低 412 概率）
    if (!cookie.includes('buvid3=')) {
      const finger = await getFingerprintCookies();
      if (finger) headers.Cookie = cookie + '; ' + finger;
    }
  } else {
    const finger = await getFingerprintCookies();
    if (finger) headers.Cookie = finger;
  }

  let { status, body, contentType } = await fetchUpstream(upstreamBase, apiPath, params, headers);
  const parsed = safeParse(body);
  let retriedWbi = false;

  // 首请求未签名时，B 站可能返回 412 / -412 / -400（请求参数错误）/ -403；
  // 只要接口支持 WBI，就用签名重试一次（尤其 playurl 常需要 w_rid）
  const wbiRetryable =
    WBI_RETRY_PATHS.has(apiPath) &&
    (status === 412 || parsed?.code === -412 || parsed?.code === -400 || parsed?.code === -403);
  if (wbiRetryable) {
    retriedWbi = true;
    const signedQuery = await wbiSignQuery(params);
    if (signedQuery) {
      ({ status, body, contentType } = await fetchUpstream(upstreamBase, apiPath, signedQuery, headers));
    }
  }

  // 请求日志：记录接口、HTTP 状态、B 站 code 与关键信息，便于排查播放失败等问题
  const final = safeParse(body);
  let detail = '';
  if (apiPath === '/x/player/wbi/playurl') {
    const d = final && final.data;
    detail =
      ` qn=${d && d.quality != null ? d.quality : '-'}` +
      ` durl=${d && Array.isArray(d.durl) ? d.durl.length : 0}` +
      ` host=${d && d.durl && d.durl[0] ? safeHost(d.durl[0].url) : '-'}`;
  }
  const codeForLog = final && final.code !== undefined ? final.code : status;
  const msgForLog = final && final.message ? String(final.message).slice(0, 100) : '';
  log(
    `[api] ${req.method} ${apiPath} http=${status}` +
    (retriedWbi ? ' wbiRetry=yes' : '') +
    ` code=${codeForLog}` +
    (msgForLog && msgForLog !== '0' && msgForLog !== 'success' ? ` msg=${msgForLog}` : '') +
    detail
  );

  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    ...corsHeaders(),
  });
  res.end(body);
}

/* ------------------------------------------------------------------
 * 7. OAuth 路由
 * ------------------------------------------------------------------ */
function handleOAuthLogin(res) {
  if (!oauth.enabled) {
    return sendJson(res, 503, {
      code: -503,
      message: '未配置 OAuth 应用凭证（BILINEST_OAUTH_CLIENT_ID / BILINEST_OAUTH_CLIENT_SECRET）',
    });
  }
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now());
  const authorizeUrl =
    'https://account.bilibili.com/pc/account-pc/auth/oauth' +
    `?client_id=${encodeURIComponent(oauth.clientId)}` +
    `&gourl=${encodeURIComponent(oauth.redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;
  sendRedirect(res, authorizeUrl);
}

async function handleOAuthCallback(res, url) {
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const createdAt = oauthStates.get(state);
  oauthStates.delete(state);
  if (!code || !createdAt || Date.now() - createdAt > 10 * 60_000) {
    return sendHtml(res, 400, 'OAuth 回调参数无效或已过期，请回到应用重新发起登录。');
  }
  try {
    const body = new URLSearchParams({
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      grant_type: 'authorization_code',
      code,
    });
    const tokenRes = await fetch('https://passport.bilibili.com/x/passport-login/oauth2/token', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const json = await tokenRes.json();
    if (json?.code !== 0 || !json?.data?.access_token) {
      throw new Error(`B 站返回错误：${json?.message || json?.code || '未知'}`);
    }
    const d = json.data;
    const sid = crypto.randomBytes(24).toString('hex');
    const ttl = Number(d.expires_in) || 0;
    oauthSessions.set(sid, {
      accessToken: d.access_token,
      refreshToken: d.refresh_token || '',
      expiresAt: Date.now() + (ttl > 1000 ? ttl * 1000 : 30 * 24 * 3600 * 1000),
    });
    const claim = crypto.randomBytes(24).toString('hex');
    oauthClaims.set(claim, { sid, createdAt: Date.now() });
    sendRedirect(res, `/oauth_done.html?claim=${claim}`);
  } catch (err) {
    sendHtml(res, 502, 'OAuth 换取令牌失败：' + escHtml(err.message));
  }
}

function handleOAuthClaim(res, url) {
  const token = url.searchParams.get('token') || '';
  const claim = oauthClaims.get(token);
  oauthClaims.delete(token);
  if (!claim || Date.now() - claim.createdAt > 5 * 60_000) {
    return sendJson(res, 404, { code: -404, message: '领取令牌无效或已过期' });
  }
  if (!oauthSessions.has(claim.sid)) {
    return sendJson(res, 401, { code: -101, message: '会话不存在' });
  }
  sendJson(res, 200, { code: 0, data: { sid: claim.sid } });
}

/* ------------------------------------------------------------------
 * 8. 静态文件服务
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { code: -400, message: '非法路径' });
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { code: -403, message: '禁止访问' });
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      if (err.code === 'ENOENT') return sendJson(res, 404, { code: -404, message: '页面不存在' });
      return sendJson(res, 500, { code: -500, message: '读取文件失败' });
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

/* ------------------------------------------------------------------
 * 9. 启动
 * ------------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  void (async () => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders());
        return res.end();
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { code: -405, message: '仅支持 GET 请求' });
      }
      if (url.pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, app: 'bilinest', oauthEnabled: oauth.enabled, version: 1 });
      }
      // 扫码登录：生成二维码 / 轮询扫码状态
      if (url.pathname === '/api/qr/generate') return await handleQrGenerate(res);
      if (url.pathname === '/api/qr/poll') return await handleQrPoll(req, res, url);
      // 字幕代理（仅限 hdslb.com）
      if (url.pathname === '/api/subtitle') return await handleSubtitleProxy(res, url);
      // 弹幕分段（protobuf 解码为 JSON，见 1.5 节）
      if (url.pathname === '/api/danmaku/segments') return await handleDanmakuSegments(req, res, url);
      // 视频流代理（B 站 CDN 防盗链：浏览器直连会被 403，见 handleVideoProxy）
      if (url.pathname === '/api/video') return await handleVideoProxy(req, res, url);
      // 本机“停止服务”入口：只允许来自 127.0.0.1 / localhost 的请求
      if (url.pathname === '/api/shutdown') {
        const host = String(req.headers.host || '');
        if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
          return sendJson(res, 403, { code: -403, message: '仅允许本机调用' });
        }
        sendJson(res, 200, { ok: true, message: 'BiliNest 服务已停止' });
        log('[server] shutdown requested, exiting…');
        setTimeout(() => {
          server.close();
          removePortFile();
          process.exit(0);
        }, 300);
        return;
      }
      if (url.pathname.startsWith('/api/bili/')) {
        return await proxyBiliApi(req, res, url);
      }
      if (url.pathname === '/api/oauth/login') return handleOAuthLogin(res);
      if (url.pathname === '/api/oauth/callback') return await handleOAuthCallback(res, url);
      if (url.pathname === '/api/oauth/claim') return handleOAuthClaim(res, url);
      if (url.pathname.startsWith('/api/')) {
        return sendJson(res, 404, { code: -404, message: '接口不存在' });
      }
      return serveStatic(req, res, url);
    } catch (err) {
      log(`[server] request error: ${err.message}`);
      if (!res.headersSent) sendJson(res, 500, { code: -500, message: '服务器内部错误' });
    }
  })();
});

/* ------------------------------------------------------------------
 * 9.1 端口兜底启动
 *     默认监听 4173；若该端口已被其它进程（另一个 Node、Vite 预览、
 *     代理软件等）占用，自动顺延尝试 4174、4175 …（最多 50 个）。
 *     最终端口写入 bilinest.port，供启动脚本打开正确地址。
 * ------------------------------------------------------------------ */
const PORT_TRIES = 50;

// 监听成功回调只注册一次：server.listen(port, cb) 的 cb 是 once('listening')，
// 失败的尝试不会移除它，若放在 startServer 里每次重试都会累积，
// 最终成功时会重复触发多次。因此这里单独用 on('listening') 挂载。
server.on('listening', () => {
  const finalPort = server.address().port;
  // OAuth 回调地址跟随实际端口（默认端口被占用顺延时尤其重要）
  if (!oauth.redirectUri) {
    oauth.redirectUri = `http://${HOST}:${finalPort}/api/oauth/callback`;
  }
  writePortFile(finalPort);
  const extra = finalPort === PORT ? '' : `（${PORT} 被占用，已自动顺延）`;
  log(
    `server started at http://${HOST}:${finalPort}${extra}` +
    ` (OAuth ${oauth.enabled ? 'enabled' : 'disabled'})`
  );
});

function startServer(port) {
  server.once('error', (err) => {
    // 已成功监听后的运行时错误不应触发重绑，直接忽略
    if (server.listening) return;
    if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && port < PORT + PORT_TRIES) {
      log(`[port] ${port} 被占用（${err.code}），自动改用 ${port + 1}`);
      startServer(port + 1);
    } else {
      log(`[server] 启动失败：${err.message}`);
      removePortFile();
      process.exit(1);
    }
  });
  server.listen(port, HOST);
}

startServer(PORT);
