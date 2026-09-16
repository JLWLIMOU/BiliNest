#!/usr/bin/env node
/**
 * BiliNest 仓库流量报告（维护者工具，不随 npm 包分发）
 * ------------------------------------------------------------
 *   npm run traffic                 # 打印最近 7 天报告（与上一周对比）
 *   npm run traffic -- --json       # 输出原始 JSON（喂给别的脚本）
 *   npm run traffic -- --days 14    # 换统计窗口
 *   npm run traffic -- --out 报告.md # 同时写一份 markdown（便于随时打开看）
 *   npm run traffic -- --html --open # 写一份 HTML 报告并打开（桌面快捷方式用的就是这条）
 *   npm run traffic -- --install-task   # 装一个每周一 10:00 的 Windows 计划任务
 *   npm run traffic -- --remove-task    # 卸掉它
 *
 * 数据来自 GitHub 的 traffic / stargazers 接口，需要**仓库写权限**：
 * 用 `gh`（GitHub CLI）已登录的账号调用，所以只有维护者本机能跑。
 * 之所以做成脚本而不是只看网页：traffic 接口只有 14 天窗口、网页上还得一层层点，
 * 这里一行命令给出"本周 vs 上周 + 新增 star + 来源渠道"。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO = process.env.BILINEST_REPO || 'JLWLIMOU/BiliNest';
const TASK_NAME = 'BiliNest 流量周报';
const DATA_DIR = process.env.BILINEST_DATA_DIR
  || (process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'BiliNest')
    : path.join(os.homedir(), '.config', 'BiliNest'));

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
function value(f, def) {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

/** --flag 后面跟的值（下一项以 - 开头或没有，就认为用的是默认值） */
function optValue(f, def) {
  const i = argv.indexOf(f);
  if (i < 0) return null;
  const next = argv[i + 1];
  return next && !next.startsWith('-') ? next : def;
}

function openInBrowser(file) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [file], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* 打不开浏览器也不影响报告已经生成 */ }
}

function gh(endpoint, extra = []) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['api', ...extra, endpoint], { timeout: 30000, windowsHide: true }, (err, stdout) => {
      if (err) {
        const msg = /ENOENT/.test(String(err.message))
          ? '没找到 GitHub CLI（gh）。装一个：winget install GitHub.cli，然后 gh auth login'
          : String(err.message).split('\n')[0];
        reject(new Error(msg));
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('解析 gh 输出失败：' + e.message)); }
    });
  });
}

/** 把 traffic 的日数组切成"最近 N 天 / 再往前 N 天"两段 */
function splitWindows(days, n) {
  const arr = (days || []).slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const recent = arr.slice(-n);
  const previous = arr.slice(-2 * n, -n);
  const sum = (list, key) => list.reduce((a, d) => a + (key === 'uniques' ? d.uniques : d.count), 0);
  return {
    recent: { count: sum(recent, 'count'), uniques: sum(recent, 'uniques'), days: recent.length },
    previous: { count: sum(previous, 'count'), uniques: sum(previous, 'uniques'), days: previous.length }
  };
}

function fmtDelta(now, prev) {
  if (!prev) return now ? `（上一周 ${prev}）` : '';
  const d = now - prev;
  if (d === 0) return `（与上一周持平）`;
  return `（上一周 ${prev}，${d > 0 ? '+' : ''}${d}）`;
}

function fmtTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function collect(days) {
  const [views, clones, referrers, paths, stars, repo] = await Promise.all([
    gh(`repos/${REPO}/traffic/views`),
    gh(`repos/${REPO}/traffic/clones`),
    gh(`repos/${REPO}/traffic/popular/referrers`),
    gh(`repos/${REPO}/traffic/popular/paths`),
    gh(`repos/${REPO}/stargazers`, ['-H', 'Accept: application/vnd.github.star+json', '--paginate']),
    gh(`repos/${REPO}`)
  ]);
  return { repo: REPO, at: new Date().toISOString(), days, views, clones, referrers, paths, stars, meta: repo };
}

function reportText(data) {
  const n = data.days;
  const v = splitWindows(data.views.views, n);
  const c = splitWindows(data.clones.clones, n);
  const starList = (data.stars || []).map((s) => ({ login: s.user && s.user.login, at: s.starred_at }));
  const since = Date.now() - n * 86400000;
  const newStars = starList.filter((s) => s.at && new Date(s.at).getTime() >= since);
  const refs = (data.referrers || []).slice(0, 3).map((r) => `${r.referrer} ${r.count}`);
  const topPaths = (data.paths || []).slice(0, 3).map((p) => `${p.path} ${p.count}`);

  const lines = [];
  lines.push(`BiliNest 流量报告 · ${fmtTime(data.at)} · 仓库 ${data.repo}`);
  lines.push('');
  lines.push(`浏览    近 ${n} 天 ${v.recent.count} 次 / ${v.recent.uniques} 人 ${fmtDelta(v.recent.uniques, v.previous.uniques)}`);
  lines.push(`克隆    近 ${n} 天 ${c.recent.count} 次 / ${c.recent.uniques} 人（含机器人 / IDE 定时 fetch，别当人气指标）`);
  lines.push(`Star    ${data.meta.stargazers_count} 个（fork ${data.meta.forks_count} · watcher ${data.meta.subscribers_count}）`);
  lines.push(`新增 star ${newStars.length ? newStars.map((s) => `${s.login}（${fmtTime(s.at)}）`).join(' · ') : '无'}`);
  lines.push(`来源渠道 ${refs.length ? refs.join(' · ') : '暂无'}`);
  lines.push(`热门页面 ${topPaths.length ? topPaths.join(' · ') : '暂无'}`);
  if (starList.length) {
    lines.push(`点星时间线 ${starList.slice(-5).reverse().map((s) => `${s.login} ${fmtTime(s.at)}`).join(' · ')}`);
  }
  lines.push('');
  lines.push('（traffic 接口只有最近 14 天、约一天延迟；「克隆」把 git fetch 与自动抓取也算进去 ——');
  lines.push('  代码索引 / release 聚合服务 / 依赖扫描都会克隆，看「浏览」「来源渠道」「star」才有意义）');
  return lines.join('\n');
}

function reportMarkdown(data) {
  return '```\n' + reportText(data) + '\n```\n';
}

/** 把 traffic 的两个日数组按日期合起来（缺的补 0），得到逐日序列 */
function dailySeries(data) {
  const map = new Map();
  const put = (list, key) => (list || []).forEach((d) => {
    const day = new Date(d.timestamp).toISOString().slice(5, 10);   // MM-DD
    const cur = map.get(day) || { day, views: 0, uniques: 0, clones: 0, cloneUniques: 0 };
    cur[key] = d.count;
    if (key === 'views') cur.uniques = d.uniques;
    if (key === 'clones') cur.cloneUniques = d.uniques;
    map.set(day, cur);
  });
  put(data.views.views, 'views');
  put(data.clones.clones, 'clones');
  return [...map.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

function niceMax(v) {
  if (v <= 2) return 2;
  if (v <= 5) return 5;
  if (v <= 10) return 10;
  return Math.ceil(v / 10) * 10;
}

/**
 * 手写一个折线图（内联 SVG）。
 * 不引图表库：报告要能离线从 file:// 打开，而且这个项目是零依赖。
 * 每个数据点带 <title>，鼠标悬停有原生提示，不需要一行 JS。
 */
function svgChart(series, days, opts = {}) {
  const W = 620, H = 170, padL = 30, padR = 12, padT = 12, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = days.length;
  const maxRaw = Math.max(1, ...series.flatMap((s) => s.values));
  const maxY = niceMax(maxRaw);
  const x = (i) => padL + (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (v) => padT + plotH - (v / maxY) * plotH;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const grid = [0, maxY / 2, maxY].map((v) =>
    `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" class="grid"/>` +
    `<text x="${padL - 6}" y="${(y(v) + 3.5).toFixed(1)}" class="axis" text-anchor="end">${v}</text>`
  ).join('');

  // 每个标签最多显示 7 个：14 天时每 2 天标一个
  const step = n > 8 ? 2 : 1;
  const xLabels = days.map((d, i) =>
    i % step === 0 || i === n - 1
      ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" class="axis" text-anchor="middle">${esc(d.day)}</text>`
      : ''
  ).join('');

  // 人 / 机器人 的分界线：左边是上一周，右边是最近一周
  const win = opts.window || 7;
  const cut = n - win;
  const divider = (cut > 0 && cut < n)
    ? `<line x1="${x(cut - 0.5).toFixed(1)}" y1="${padT}" x2="${x(cut - 0.5).toFixed(1)}" y2="${padT + plotH}" class="divider"/>` +
      `<text x="${x(cut - 0.5).toFixed(1)}" y="${padT + 10}" class="axis" text-anchor="middle">最近 7 天</text>`
    : '';

  const lines = series.map((s) => {
    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const area = s.fill && !s.band
      ? `<polygon points="${padL},${(padT + plotH).toFixed(1)} ${pts} ${(W - padR).toFixed(1)},${(padT + plotH).toFixed(1)}" fill="${s.color}" opacity="0.10"/>`
      : '';
    const dots = s.values.map((v, i) =>
      `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${s.band ? 2.1 : 2.6}" fill="${s.color}">` +
      `<title>${esc(days[i].day)}　${esc(s.label)} ${v}</title></circle>`
    ).join('');
    // band：画成半透明宽带。用于"浏览"——它和"独立访客"经常同值，
    // 两条同宽实线叠在一起会只剩最后画的那条，看着像数据缺失。
    return area +
      `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="${s.band ? 9 : 2}" ` +
      (s.band ? 'opacity="0.28" ' : '') +
      `stroke-linejoin="round" stroke-linecap="round"${s.dashed ? ' stroke-dasharray="4 4"' : ''}/>` + dots;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || '趋势图')}">` +
    grid + divider + lines + xLabels + '</svg>';
}

/**
 * 横向条形图：给"分类数据"用（来源渠道、热门页面）。
 * 这类数据没有时间轴，画成折线会假装存在趋势，条形才是对的读法。
 */
function svgBars(items, opts = {}) {
  const list = (items || []).slice(0, opts.limit || 5);
  if (!list.length) return '<div class="empty">暂无数据（traffic 接口只覆盖最近 14 天）</div>';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const max = Math.max(...list.map((it) => it.value)) || 1;
  const labelW = opts.labelWidth || 210;
  const barMax = 320;
  const rowH = 22;
  const H = list.length * rowH + 6;
  const rows = list.map((it, i) => {
    const y = i * rowH + 3;
    const w = Math.max(2, (it.value / max) * barMax);
    const label = it.label.length > 30 ? it.label.slice(0, 29) + '…' : it.label;
    return `<g><title>${esc(it.label)}　${it.value}</title>` +
      `<text x="0" y="${y + 11}" class="axis">${esc(label)}</text>` +
      `<rect x="${labelW}" y="${y + 1}" width="${barMax}" height="12" rx="3" class="bar-bg"/>` +
      `<rect x="${labelW}" y="${y + 1}" width="${w.toFixed(1)}" height="12" rx="3" fill="${opts.color || 'var(--c-views)'}"/>` +
      `<text x="${labelW + barMax + 8}" y="${y + 11}" class="axis">${it.value}</text></g>`;
  }).join('');
  return `<svg viewBox="0 0 ${labelW + barMax + 42} ${H}" role="img" aria-label="${esc(opts.label || '条形图')}">${rows}</svg>`;
}

/** 一个自包含的 HTML 报告（深浅色自适应），双击快捷方式看到的就是它 */
function reportHtml(data) {
  const n = data.days;
  const v = splitWindows(data.views.views, n);
  const c = splitWindows(data.clones.clones, n);
  const starList = (data.stars || []).map((s) => ({ login: s.user && s.user.login, at: s.starred_at }));
  const since = Date.now() - n * 86400000;
  const newStars = starList.filter((s) => s.at && new Date(s.at).getTime() >= since);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const delta = (now, prev) => {
    if (!prev) return '';
    const d = now - prev;
    if (d === 0) return '<span class="k">持平</span>';
    return `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d}</span>`;
  };
  const row = (k, val) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${val}</span></div>`;

  // 两张图分开画：人的数字（0–2）和机器人的数字（30+）量级差 20 倍，
  // 画在一张图里，人那条会被压在底线上，看着像"没人来"。
  const daily = dailySeries(data);
  const chartPeople = svgChart(
    [
      { label: '浏览', color: 'var(--c-views)', values: daily.map((d) => d.views), band: true },
      { label: '独立访客', color: 'var(--c-uniques)', values: daily.map((d) => d.uniques) }
    ],
    daily, { label: '浏览与独立访客趋势', window: n }
  );
  const chartBots = svgChart(
    [{ label: '克隆', color: 'var(--c-clones)', values: daily.map((d) => d.clones), dashed: true }],
    daily, { label: '克隆趋势', window: n }
  );
  // 累计 star：GitHub 没有"每日新增"接口，但 stargazers 带时间戳，
  // 用「总数 − 窗口内新增」当起点往上累加，就能画出同一条时间轴上的累计曲线
  const starsByDay = {};
  starList.forEach((s) => {
    if (!s.at) return;
    const day = new Date(s.at).toISOString().slice(5, 10);
    starsByDay[day] = (starsByDay[day] || 0) + 1;
  });
  const starsInWindow = daily.reduce((a, d) => a + (starsByDay[d.day] || 0), 0);
  let starAcc = (data.meta.stargazers_count || 0) - starsInWindow;
  const starSeries = daily.map((d) => { starAcc += starsByDay[d.day] || 0; return starAcc; });
  const chartStars = svgChart(
    [{ label: '累计 star', color: 'var(--c-stars)', values: starSeries, fill: true }],
    daily, { label: 'Star 累计趋势', window: n }
  );
  const refBars = svgBars(
    (data.referrers || []).map((r) => ({ label: r.referrer, value: r.count })),
    { label: '来源渠道', color: 'var(--c-views)', labelWidth: 210 }
  );
  const pathBars = svgBars(
    (data.paths || []).map((p) => ({ label: p.path, value: p.count })),
    { label: '热门页面', color: 'var(--c-uniques)', labelWidth: 300 }
  );

  const rows = [
    row(`浏览（近 ${n} 天）`, `${v.recent.count} 次 ${delta(v.recent.uniques, v.previous.uniques)}`),
    row('独立访客', `${v.recent.uniques} 人 <span class="k">（上一周 ${v.previous.uniques}）</span>`),
    row(`克隆（近 ${n} 天）`, `${c.recent.count} 次 / ${c.recent.uniques} 人 ${delta(c.recent.uniques, c.previous.uniques)} ` +
      '<span class="k">含机器人 / IDE fetch</span>'),
    row('Star', `${data.meta.stargazers_count} 个 <span class="k">（fork ${data.meta.forks_count} · watcher ${data.meta.subscribers_count}）</span>`),
    row(`新增 star（近 ${n} 天）`, newStars.length
      ? newStars.map((s) => `<b>${esc(s.login)}</b> <span class="k">${fmtTime(s.at)}</span>`).join(' · ')
      : '<span class="k">无</span>'),
    row('点星时间线', starList.slice(-6).reverse().map((s) => `${esc(s.login)} <span class="k">${fmtTime(s.at)}</span>`).join(' · ') || '<span class="k">暂无</span>')
  ].join('');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BiliNest 流量报告 · ${fmtTime(data.at)}</title>
<style>
  :root { color-scheme: light dark; }
  :root { --c-views: #0071e3; --c-uniques: #ff9f0a; --c-clones: #8e8e93; --c-stars: #30a46c;
          --grid: rgba(60,60,67,.14); }
  @media (prefers-color-scheme: dark) {
    :root { --c-views: #0a84ff; --c-uniques: #ffb340; --c-clones: #98989d; --c-stars: #3ddc84;
            --grid: rgba(255,255,255,.16); }
  }
  body { font: 14px/1.65 system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         background: #f2f2f7; color: #1c1c1e; margin: 0; padding: 40px 20px; }
  .card { max-width: 660px; margin: 0 auto; background: #fff; border-radius: 16px;
          padding: 26px 28px 22px; box-shadow: 0 1px 2px rgba(0,0,0,.05), 0 14px 34px rgba(0,0,0,.08); }
  h1 { font-size: 21px; margin: 0 0 4px; letter-spacing: -.3px; }
  .sub { color: #8e8e93; font-size: 12.5px; margin-bottom: 16px; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 16px;
         padding: 10px 0; border-top: 1px solid rgba(60,60,67,.12); }
  .row:first-of-type { border-top: 0; }
  .k { color: #8e8e93; }
  .row > .k { white-space: nowrap; }        /* 标签不换行（"热门页面"这种四字标签会被挤成两行） */
  .v { text-align: right; font-variant-numeric: tabular-nums; word-break: break-word; }
  .up { color: #1a7f37; } .down { color: #c2410c; }
  .chart-wrap { margin: 14px 0 18px; }
  .chart-title { font-weight: 600; margin-bottom: 2px; }
  .chart-wrap svg { display: block; width: 100%; height: auto; overflow: visible; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .bar-bg { fill: var(--grid); }
  .empty { color: #8e8e93; font-size: 12.5px; padding: 6px 0; }
  .divider { stroke: var(--grid); stroke-width: 1; stroke-dasharray: 3 3; }
  .axis { fill: #8e8e93; font-size: 9.5px; font-variant-numeric: tabular-nums; }
  .legend { display: flex; gap: 14px; color: #8e8e93; font-size: 12px; margin-top: 4px; }
  .legend i { display: inline-block; width: 10px; height: 3px; border-radius: 2px;
              margin-right: 5px; vertical-align: middle; }
  .legend i.band { height: 7px; opacity: .45; }
  .legend i.dash { background-image: linear-gradient(90deg, currentColor 40%, transparent 0); }
  footer { margin-top: 18px; color: #8e8e93; font-size: 12px; }
  a { color: #0071e3; text-decoration: none; }
  a:hover { text-decoration: underline; }
  @media (prefers-color-scheme: dark) {
    body { background: #000; color: #f5f5f7; }
    .card { background: #1c1c1e; box-shadow: none; }
    .row { border-color: rgba(255,255,255,.12); }
    .k, .sub, footer { color: rgba(235,235,245,.6); }
    .axis, .legend { fill: rgba(235,235,245,.6); color: rgba(235,235,245,.6); }
    a { color: #0a84ff; }
  }
</style></head>
<body><div class="card">
  <h1>BiliNest 流量报告</h1>
  <div class="sub">${esc(data.repo)} · 生成于 ${fmtTime(data.at)}</div>
  <div class="chart-wrap">
    <div class="chart-title">浏览 / 独立访客 <span class="k">近 ${daily.length} 天</span></div>
    ${chartPeople}
    <div class="legend">
      <span><i class="band" style="background:var(--c-views)"></i>浏览</span>
      <span><i style="background:var(--c-uniques)"></i>独立访客</span>
    </div>
  </div>
  <div class="chart-wrap">
    <div class="chart-title">克隆 <span class="k">含机器人 / IDE fetch，不是人气指标</span></div>
    ${chartBots}
    <div class="legend"><span><i class="dash" style="background:var(--c-clones)"></i>克隆次数</span></div>
  </div>
  <div class="chart-wrap">
    <div class="chart-title">Star 累计 <span class="k">近 ${daily.length} 天</span></div>
    ${chartStars}
    <div class="legend"><span><i style="background:var(--c-stars)"></i>累计 star</span></div>
  </div>
  ${rows}
  <div class="chart-wrap">
    <div class="chart-title">来源渠道 <span class="k">最近 14 天内从哪跳过来的</span></div>
    ${refBars}
  </div>
  <div class="chart-wrap">
    <div class="chart-title">热门页面 <span class="k">最近 14 天被看最多的路径</span></div>
    ${pathBars}
  </div>
  <footer>
    数据来自 GitHub traffic / stargazers 接口（只有最近 14 天、约一天延迟）。
    「克隆」把 git fetch 与自动抓取（代码索引、release 聚合、依赖扫描）也算进去，不是人气指标 —— 看浏览、来源渠道和 star 更准。
    <a href="https://github.com/${esc(data.repo)}">仓库</a> ·
    <a href="https://github.com/${esc(data.repo)}/releases">Releases</a> ·
    <a href="https://github.com/${esc(data.repo)}/graphs/traffic">GitHub 上的流量页</a>
  </footer>
</div></body></html>
`;
}

async function task(action) {
  if (process.platform !== 'win32') {
    console.log('计划任务只支持 Windows；macOS / Linux 可以自己加 cron（同一条命令）。');
    return;
  }
  const self = path.resolve(process.argv[1]);
  const out = path.join(DATA_DIR, 'traffic-report.html');
  const tr = `node "${self}" --html "${out}"`;
  const args = action === 'install'
    ? ['/Create', '/SC', 'WEEKLY', '/D', 'MON', '/ST', '10:00', '/TN', TASK_NAME, '/TR', tr, '/F']
    : ['/Delete', '/TN', TASK_NAME, '/F'];
  await new Promise((resolve, reject) => {
    execFile('schtasks', args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
  if (action === 'install') {
    console.log(`已创建计划任务「${TASK_NAME}」：每周一 10:00 把 HTML 报告写到\n  ${out}\n随时用「npm run traffic」或桌面快捷方式也能立刻看最新数据。`);
  } else {
    console.log(`已删除计划任务「${TASK_NAME}」。`);
  }
}

async function main() {
  if (has('--install-task')) return task('install');
  if (has('--remove-task')) return task('remove');

  const days = Math.max(1, Math.min(14, Number(value('--days', 7)) || 7));
  const data = await collect(days);

  if (has('--json')) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const text = reportText(data);
  console.log(text);

  const out = value('--out', '');
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, reportMarkdown(data), 'utf8');
    console.log(`\n已写入：${out}`);
  }

  const htmlPath = optValue('--html', path.join(DATA_DIR, 'traffic-report.html'));
  if (htmlPath) {
    fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
    fs.writeFileSync(htmlPath, reportHtml(data), 'utf8');
    console.log(`\n已写入：${htmlPath}`);
    if (has('--open')) openInBrowser(htmlPath);
  }
}

main().catch((e) => {
  console.error('出错了：' + e.message);
  process.exitCode = 1;
});
