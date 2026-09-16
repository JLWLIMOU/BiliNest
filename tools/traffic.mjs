#!/usr/bin/env node
/**
 * BiliNest 仓库流量报告（维护者工具，不随 npm 包分发）
 * ------------------------------------------------------------
 *   npm run traffic                 # 打印最近 7 天报告（与上一周对比）
 *   npm run traffic -- --json       # 输出原始 JSON（喂给别的脚本）
 *   npm run traffic -- --days 14    # 换统计窗口
 *   npm run traffic -- --out 报告.md # 同时写一份 markdown（便于随时打开看）
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
  lines.push(`克隆    近 ${n} 天 ${c.recent.count} 次 / ${c.recent.uniques} 人 ${fmtDelta(c.recent.uniques, c.previous.uniques)}`);
  lines.push(`Star    ${data.meta.stargazers_count} 个（fork ${data.meta.forks_count} · watcher ${data.meta.subscribers_count}）`);
  lines.push(`新增 star ${newStars.length ? newStars.map((s) => `${s.login}（${fmtTime(s.at)}）`).join(' · ') : '无'}`);
  lines.push(`来源渠道 ${refs.length ? refs.join(' · ') : '暂无'}`);
  lines.push(`热门页面 ${topPaths.length ? topPaths.join(' · ') : '暂无'}`);
  if (starList.length) {
    lines.push(`点星时间线 ${starList.slice(-5).reverse().map((s) => `${s.login} ${fmtTime(s.at)}`).join(' · ')}`);
  }
  lines.push('');
  lines.push('（traffic 接口只有最近 14 天、约一天延迟；数字与上次一致属正常）');
  return lines.join('\n');
}

function reportMarkdown(data) {
  return '```\n' + reportText(data) + '\n```\n';
}

async function task(action) {
  if (process.platform !== 'win32') {
    console.log('计划任务只支持 Windows；macOS / Linux 可以自己加 cron（同一条命令）。');
    return;
  }
  const self = path.resolve(process.argv[1]);
  const out = path.join(DATA_DIR, 'traffic-report.md');
  const tr = `node "${self}" --out "${out}"`;
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
    console.log(`已创建计划任务「${TASK_NAME}」：每周一 10:00 把报告写到\n  ${out}\n随时用「npm run traffic」也能立刻看最新数据。`);
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
}

main().catch((e) => {
  console.error('出错了：' + e.message);
  process.exitCode = 1;
});
