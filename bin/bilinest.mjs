#!/usr/bin/env node
/**
 * BiliNest 命令行入口 —— 给 npm / npx 用：
 *
 *     npx bilinest            # 启动本地服务并打开浏览器
 *     npx bilinest --no-open  # 只启动服务（服务器 / 无桌面环境）
 *     npx bilinest --port 5000
 *
 * 做的事很少：把端口定下来 → 载入 server.mjs（它自己会监听并写 bilinest.port）
 * → 等服务起来 → 打开浏览器。数据仍然存在 %APPDATA%\BiliNest，
 * 和安装包版是同一个目录，两种装法可以混着用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT_FILE = path.join(root, 'bilinest.port');

const argv = process.argv.slice(2);
function flagValue(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const port = Number(flagValue('--port', process.env.BILINEST_PORT || 4173)) || 4173;
const shouldOpen = !argv.includes('--no-open');
process.env.BILINEST_PORT = String(port);

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      // 用 cmd 的 start：Windows 上打开默认浏览器最稳的方式（第一个参数是窗口标题，必须留空）
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* 打不开浏览器不影响服务 */
  }
}

/** 等服务真的能响应再开浏览器：server.mjs 在端口被占用时会自动顺延，所以以 health 为准 */
async function waitForServer(maxMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    let candidates = [];
    try {
      const p = Number(fs.readFileSync(PORT_FILE, 'utf8').trim());
      if (p) candidates.push(p);
    } catch { /* 端口文件还没写 */ }
    for (let i = 0; i < 8; i++) candidates.push(port + i);
    for (const p of [...new Set(candidates)]) {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(800) });
        if (r.ok) {
          const data = await r.json().catch(() => ({}));
          if (data && data.app === 'bilinest') return p;
        }
      } catch { /* 还没起来 */ }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return 0;
}

// server.mjs 顶层就开始监听；用动态 import，让上面的常量先准备好。
// 注意 Windows 上必须转成 file:// URL —— ESM 不接受 "D:\..." 这种裸路径。
await import(pathToFileURL(path.join(root, 'server.mjs')).href);

const actual = await waitForServer();
const url = `http://127.0.0.1:${actual || port}/`;

if (actual) {
  console.log(`\n  BiliNest 已启动：${url}\n  数据目录：%APPDATA%\\BiliNest（Windows）/ ~/.config/BiliNest（其他）\n  按 Ctrl+C 停止服务\n`);
  if (shouldOpen) openBrowser(url);
} else {
  console.error('启动超时：服务没有在预期时间内响应，请看看上面的日志。');
  process.exitCode = 1;
}
