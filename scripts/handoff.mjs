#!/usr/bin/env node
// awu-handoff · 零依赖交接工具
// 用法：
//   node scripts/handoff.mjs write [--task <id>] [--status <s>] [--dir <path>]
//   node scripts/handoff.mjs check [<file>] [--json]
//   node scripts/handoff.mjs list [--dir <path>] [--json]
// 退出码：check 有硬错误 → 1；其余 0。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, basename, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const SECTIONS = ['任务', '坐标', '账', '已排除', '下一步', '边界'];
const REQUIRED_FIELDS = ['handoff', 'task', 'created', 'repo', 'branch', 'head', 'status'];
const STATUSES = new Set(['in-progress', 'blocked', 'review', 'done']);
const LEDGER_STATES = new Set(['已验', '未验', '放弃']);
const MAX_BODY_LINES = 60;
const PLACEHOLDER = /（待填）|\(待填\)|TODO|待补/;

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function pad(n) { return String(n).padStart(2, '0'); }

function localIso(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

function stampForFile(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

function parseFront(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end < 0) return null;
  const meta = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[m[1]] = v === '' || v === 'null' ? null : v;
  }
  return { meta, end, lines };
}

function sectionsOf(text) {
  const found = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) found.push(m[1]);
  }
  return found;
}

function sectionBody(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${name}\\s*$`).test(l));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const stop = rest.findIndex((l) => /^##\s+/.test(l));
  return (stop < 0 ? rest : rest.slice(0, stop)).join('\n').trim();
}

function ledgerRows(body) {
  const rows = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    if (/^\|[\s:-]+\|/.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
    if (cells.length < 3) continue;
    if (cells[0] === '项' && cells[1] === '状态') continue;
    rows.push({ item: cells[0], state: cells[1], evidence: cells.slice(2).join(' | ') });
  }
  return rows;
}

function listHandoffs(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.handoff.md')) continue;
    const file = join(dir, name);
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const fm = parseFront(text);
    out.push({ file, name, text, meta: fm ? fm.meta : null });
  }
  return out;
}

function latestFor(list, task) {
  let best = null;
  for (const item of list) {
    if (!item.meta || item.meta.task !== task) continue;
    const seq = Number(item.meta.handoff);
    if (!Number.isFinite(seq)) continue;
    if (!best || seq > Number(best.meta.handoff)) best = item;
  }
  return best;
}

function skeleton({ meta, dirty }) {
  const workspace = dirty.length
    ? `工作区有未提交改动：${dirty.slice(0, 5).join('、')}${dirty.length > 5 ? ` 等 ${dirty.length} 个` : ''}`
    : '工作区干净';
  return `---
handoff: ${meta.handoff}
task: ${meta.task}
created: ${meta.created}
repo: ${meta.repo}
branch: ${meta.branch}
head: ${meta.head}
status: ${meta.status}
prev: ${meta.prev ?? 'null'}
---

# 交接：${meta.task}（待填：一句话说清这次交的是什么）

## 任务
（待填）做完是什么样，加一句验收标准。

## 坐标
- 分支 \`${meta.branch}\`，HEAD \`${meta.head}\`，${workspace}
- （待填）跑过的命令与结果；在跑的进程和端口

## 账
| 项 | 状态 | 证据 |
| --- | --- | --- |
| （待填） | 未验 | （要跑什么才算完） |

## 已排除
- （待填）试过什么、为什么不通；真没有就写 - 无

## 下一步
1. （待填）具体到文件和动作，接手者不用再问

## 边界
- 要人定：（待填）；没有就写 - 无
`;
}

function cmdWrite(opts) {
  const cwd = process.cwd();
  const dir = resolve(cwd, opts.dir);
  const repoRoot = git(['rev-parse', '--show-toplevel'], cwd);
  const repo = (repoRoot || cwd).split('\\').join('/');
  const branch = repoRoot ? (git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) || '-') : '-';
  const head = repoRoot ? (git(['rev-parse', '--short', 'HEAD'], cwd) || '-') : '-';
  const dirty = repoRoot
    ? (git(['status', '--porcelain'], cwd) || '').split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).trim()).filter((p) => !p.startsWith('.handoff'))
    : [];

  const raw = opts.task || basename(repo);
  const task = raw.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '') || 'task';
  const status = STATUSES.has(opts.status) ? opts.status : 'in-progress';

  mkdirSync(dir, { recursive: true });
  const list = listHandoffs(dir);
  const prev = latestFor(list, task);
  const seq = prev ? Number(prev.meta.handoff) + 1 : 1;
  const now = new Date();
  let name = `${stampForFile(now)}_${task}.handoff.md`;
  for (let n = 2; existsSync(join(dir, name)); n++) {
    name = `${stampForFile(now)}_${task}-${n}.handoff.md`;
  }
  const file = join(dir, name);

  const meta = {
    handoff: seq, task, created: localIso(now), repo,
    branch, head, status, prev: prev ? prev.name : null,
  };
  writeFileSync(file, skeleton({ meta, dirty }), 'utf8');

  if (repoRoot && git(['check-ignore', '.handoff'], cwd) === null) {
    console.warn('注意：.handoff/ 还没被 .gitignore 忽略，别把本机草稿提交上去。');
  }
  const relFile = relative(cwd, file).split('\\').join('/');
  console.log(`\n已生成交接骨架：${relFile}`);
  console.log(`  task=${task} · handoff=${seq} · branch=${branch} · head=${head}` + (dirty.length ? ` · 脏文件 ${dirty.length} 个` : ' · 工作区干净'));
  if (prev) console.log(`  上一条：${prev.name}`);
  console.log(`\n填完后检查：node scripts/handoff.mjs check ${relFile}`);
  console.log(`\n新会话第一句：\n读 ${relFile}，先跑 check 再动手。\n`);
}

function cmdCheck(fileArg, opts) {
  const cwd = process.cwd();
  const dir = resolve(cwd, opts.dir);
  let file = fileArg ? resolve(cwd, fileArg) : null;
  if (!file) {
    const list = listHandoffs(dir);
    if (!list.length) {
      console.log(`没有找到交接文件（目录 ${relative(cwd, dir) || '.'}）。先跑 write。`);
      process.exit(1);
    }
    list.sort((a, b) => statSync(b.file).mtimeMs - statSync(a.file).mtimeMs);
    file = list[0].file;
  }
  if (!existsSync(file)) {
    console.error(`文件不存在：${file}`);
    process.exit(1);
  }

  const text = readFileSync(file, 'utf8');
  const fm = parseFront(text);
  const hard = [];
  const warn = [];
  const drift = [];

  if (!fm) hard.push('没有可解析的头部（文件必须以 --- 开头，并有结束的 ---）');

  const meta = fm ? fm.meta : {};
  for (const key of REQUIRED_FIELDS) {
    if (!meta[key]) hard.push(`缺字段：${key}`);
  }
  if (meta.status && !STATUSES.has(meta.status)) hard.push(`status 取值非法：${meta.status}（应为 in-progress / blocked / review / done）`);
  if (meta.created && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(meta.created)) warn.push('created 不是 ISO 8601（例：2026-11-12T17:20+08:00）');

  const names = sectionsOf(text);
  for (const want of SECTIONS) {
    if (!names.includes(want)) hard.push(`缺小节：## ${want}`);
  }
  const bodyLines = text.split(/\r?\n/).slice(fm ? fm.end + 1 : 0).filter((l) => l.trim()).length;
  if (bodyLines > MAX_BODY_LINES) hard.push(`正文 ${bodyLines} 行，超过 ${MAX_BODY_LINES} 行上限`);

  const placeholders = text.split(/\r?\n/)
    .map((l, i) => ({ l, n: i + 1 }))
    .filter((x) => PLACEHOLDER.test(x.l));
  if (placeholders.length) hard.push(`还有 ${placeholders.length} 处占位符（第 ${placeholders.slice(0, 3).map((x) => x.n).join('、')} 行）`);

  const coord = sectionBody(text, '坐标');
  if (!coord) hard.push('「坐标」是空的：没有现场，交接无效');

  const rows = ledgerRows(sectionBody(text, '账'));
  if (!rows.length) {
    hard.push('「账」里没有表格行（| 项 | 状态 | 证据 |）');
  } else {
    const badState = rows.filter((r) => !LEDGER_STATES.has(r.state));
    if (badState.length) hard.push(`「账」有 ${badState.length} 行状态非法：${badState.map((r) => r.state || '空').join('、')}（只能写 已验 / 未验 / 放弃）`);
    const noEvidence = rows.filter((r) => r.state === '已验' && !/`[^`]+`/.test(r.evidence) && !/\d/.test(r.evidence));
    if (noEvidence.length) hard.push(`「账」有 ${noEvidence.length} 行标了已验却没有可复核的证据：${noEvidence.slice(0, 2).map((r) => r.item).join(' / ')}`);
    const emptyUnverified = rows.filter((r) => r.state === '未验' && r.evidence.replace(/[-—\s]/g, '').length < 4);
    if (emptyUnverified.length) hard.push(`「账」有 ${emptyUnverified.length} 行未验却没写怎么验：${emptyUnverified.slice(0, 2).map((r) => r.item).join(' / ')}`);
  }

  const excluded = sectionBody(text, '已排除');
  const excludedItems = excluded.split(/\r?\n/).filter((l) => /^\s*-\s+\S/.test(l));
  if (!excludedItems.length) hard.push('「已排除」为空（真没有就写 - 无，但先想 30 秒）');

  const next = sectionBody(text, '下一步');
  const nextItems = next.split(/\r?\n/).filter((l) => /^\s*\d+\.\s+\S/.test(l));
  if (!nextItems.length) hard.push('「下一步」里没有编号条目（1. 2. …）');
  if (nextItems.length && /继续完善|视情况|进一步|推进|优化一下/.test(nextItems[0])) warn.push('「下一步」第 1 条太笼统，落不到文件和动作');

  const edge = sectionBody(text, '边界');
  const edgeItems = edge.split(/\r?\n/).filter((l) => /^\s*-\s+\S/.test(l));
  if (!edgeItems.length) warn.push('「边界」为空；没有就写 - 无');
  if (meta.status === 'done' && edgeItems.some((l) => /要人定/.test(l) && !/无/.test(l))) warn.push('status 是 done，但「边界」还有要人定的事');

  // 漂移
  if (meta.repo && meta.repo !== '-') {
    const repoPath = meta.repo.split('/').join('\\');
    if (!existsSync(repoPath)) {
      warn.push(`repo 路径不存在（${meta.repo}），无法核验现场`);
    } else {
      const head = git(['rev-parse', '--short', 'HEAD'], repoPath);
      const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
      if (head && meta.head && meta.head !== '-' && head !== meta.head) {
        const commits = (git(['rev-list', '--count', `${meta.head}..HEAD`], repoPath) || '?');
        drift.push(`HEAD 从 ${meta.head} 变成 ${head}（${commits} 个新提交）`);
      }
      if (branch && meta.branch && meta.branch !== '-' && branch !== meta.branch) {
        drift.push(`分支从 ${meta.branch} 变成 ${branch}`);
      }
      const dirty = (git(['status', '--porcelain'], repoPath) || '').split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).trim()).filter((p) => !p.startsWith('.handoff'));
      if (/工作区干净/.test(text) && dirty.length) {
        drift.push(`交接写着工作区干净，现在有 ${dirty.length} 个未提交改动：${dirty.slice(0, 3).join('、')}`);
      }
    }
  }

  // 链
  if (meta.prev && meta.prev !== 'null') {
    const prevPath = join(resolve(file, '..'), meta.prev);
    const altPath = join(dir, meta.prev);
    if (!existsSync(prevPath) && !existsSync(altPath)) {
      warn.push(`prev 指向的文件不存在：${meta.prev}`);
    } else {
      const prevText = readFileSync(existsSync(prevPath) ? prevPath : altPath, 'utf8');
      const prevMeta = parseFront(prevText)?.meta;
      if (prevMeta && Number(prevMeta.handoff) + 1 !== Number(meta.handoff)) {
        warn.push(`序号不连续：上一份是 ${prevMeta.handoff}，这份是 ${meta.handoff}`);
      }
    }
  }

  const relFile = relative(cwd, file).split('\\').join('/');
  if (opts.json) {
    console.log(JSON.stringify({ file: relFile, task: meta.task, status: meta.status, hard, warn, drift, bodyLines }, null, 2));
  } else {
    console.log(`\n交接检查：${relFile}`);
    if (meta.task) console.log(`  task=${meta.task} · handoff=${meta.handoff} · status=${meta.status} · 正文 ${bodyLines} 行`);
    for (const m of hard) console.log(`  ✗ ${m}`);
    for (const m of warn) console.log(`  ! ${m}`);
    for (const m of drift) console.log(`  ~ ${m}`);
    console.log('');
    if (hard.length) {
      console.log(`结论：不可接手（${hard.length} 个硬错误）。补齐，或让交接方重写。\n`);
    } else {
      console.log(`结论：可接手${warn.length || drift.length ? `（${warn.length} 条提醒、${drift.length} 条漂移，逐条看）` : '（现场一致）'}。\n`);
    }
  }
  process.exit(hard.length ? 1 : 0);
}

function cmdList(opts) {
  const cwd = process.cwd();
  const dir = resolve(cwd, opts.dir);
  const list = listHandoffs(dir);
  if (!list.length) {
    console.log(`没有交接文件（目录 ${relative(cwd, dir) || '.'}）。`);
    return;
  }
  const byTask = new Map();
  for (const item of list) {
    const task = (item.meta && item.meta.task) || '未命名';
    if (!byTask.has(task)) byTask.set(task, []);
    byTask.get(task).push(item);
  }
  const rows = [];
  for (const [task, items] of byTask) {
    items.sort((a, b) => (Number(a.meta?.handoff) || 0) - (Number(b.meta?.handoff) || 0));
    const latest = items[items.length - 1];
    let driftText = '一致';
    const meta = latest.meta;
    if (meta && meta.repo && meta.repo !== '-' && existsSync(meta.repo.split('/').join('\\'))) {
      const head = git(['rev-parse', '--short', 'HEAD'], meta.repo.split('/').join('\\'));
      if (head && meta.head && meta.head !== '-' && head !== meta.head) driftText = `${meta.head}→${head}`;
    } else {
      driftText = '无法核验';
    }
    rows.push({ task, seq: Number(meta?.handoff) || items.length, status: meta?.status || '?', created: meta?.created || '?', latest: latest.name, drift: driftText });
  }
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log('');
  for (const r of rows) {
    console.log(`${r.task}  ·  第 ${r.seq} 次  ·  ${r.status}`);
    console.log(`  最新：${r.latest}`);
    console.log(`  ${r.created}  ·  漂移：${r.drift}`);
  }
  console.log(`\n共 ${rows.length} 个任务，${list.length} 份交接（目录 ${relative(cwd, dir) || '.'}）。\n`);
}

// —— 参数 ——
const argv = process.argv.slice(2);
const cmd = argv[0];
const opts = { dir: '.handoff', task: null, status: null, json: false };
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') opts.json = true;
  else if (a === '--task') opts.task = argv[++i];
  else if (a === '--status') opts.status = argv[++i];
  else if (a === '--dir') opts.dir = argv[++i];
  else if (a.startsWith('--')) { console.error(`未知参数：${a}`); process.exit(2); }
  else positional.push(a);
}

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`awu-handoff

  node scripts/handoff.mjs write [--task <id>] [--status in-progress|blocked|review|done] [--dir <path>]
  node scripts/handoff.mjs check [<file>] [--json]
  node scripts/handoff.mjs list [--json]
`);
  process.exit(0);
}
if (cmd === 'write') cmdWrite(opts);
else if (cmd === 'check') cmdCheck(positional[0], opts);
else if (cmd === 'list') cmdList(opts);
else { console.error(`未知命令：${cmd}`); process.exit(2); }
