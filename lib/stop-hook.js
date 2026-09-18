// 合并版 Stop hook(唯一注册):
//   1) 把负载原样转发给 gryph 审计入库;
//   2) 从本地账本 ledger.jsonl 生成本轮读取清单(时间/来源/文件/行范围四列表格 + 会话累计行,折叠 <details> 展示),
//      以 Stop continuation({"decision":"block","reason"})要求模型输出「最终展示版」:
//      重构自身刚完成的回复(长回复=总体摘要+<details>折叠全文;短回复=复读)+ 文末逐字附上清单。
//      这样 UI 上最终消息自带完整内容,被折叠进工作记录的原始回复成为备份。
// 会话关联:账本记录的是 payload 原始 session_id,与 Stop 负载同源,精确匹配;
//          账本无该 sid 时(记账 hook 装好前的旧会话)回退 gryph 时间窗匹配。
// 自带调试日志:.stop-debug.log 记录每次调用与决策。任何异常静默放行,绝不干扰对话。
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { dataDir, gryph } = require('./paths');

const GRYPH = gryph;
const STATE = path.join(dataDir, '.stop-watermark.json');
const DEBUG = path.join(dataDir, '.stop-debug.log');
const LEDGER = path.join(dataDir, 'ledger.jsonl');
const SETTINGS = path.join(dataDir, 'settings.json');
const FIRST_LOOKBACK_MS = 60 * 60 * 1000; // 会话首次触发时只回溯 1 小时
const MAX_ITEMS = 20;
const MAX_CUM = 30; // 累计明细表最多列出的文件数
const EMIT_COOLDOWN_MS = 2 * 60 * 1000; // 「刚发过清单」标志的有效期:覆盖续写收尾 Stop,又不至于吞掉下一个真实回合

// 续写指令的两种形态:重构版(摘要+需注意+完整说明+清单)与裸清单版
const INTRO_RESTRUCTURE = '【审计系统指令】你的回复已结束,现在输出本回合的最终展示版,无需任何思考或推理,禁止开场白、过渡句或确认。把你刚才的回复重新组织输出:① 2~4 句总体摘要,直接可见;② 若回复中含「需用户注意、需用户决策、建议的下一步计划」类内容,提取成要点单独放入 <details><summary>⚠️ 需注意与下一步</summary>(无此类内容则省略整块);③ 完整原文放入 <details><summary>📖 完整说明</summary>,信息不得删减;④ 最末尾逐字复制下面的审计清单,从 <details> 到 </details>,禁止改写、增删、总结:';
const INTRO_BARE = '【审计系统指令】你的回复已结束,现在做一次纯机械复制续写,无需任何思考或推理。禁止开场白、过渡句、确认或任何其他文字,你的下一条输出必须且只能是下面这段清单,从 <details> 逐字复制到 </details>,禁止改写、增删、总结:';

// 「最终展示版」重构开关,优先级:插件 hook 参数 > settings.json > 默认开。
// 参数形如 "true"/"false";模板变量未展开时会收到字面量 "${user_config...}",按未设置处理。
function restructureOn() {
  const a = String(process.argv[2] || '').toLowerCase();
  if (a === 'true' || a === 'false') return a === 'true';
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    if (typeof s.restructure === 'boolean') return s.restructure;
  } catch {}
  return true;
}

function dbg(msg) {
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(DEBUG, new Date().toISOString() + ' ' + msg + '\n'); } catch {}
}

// —— shell 读取推定:从 Bash 命令原文提取读取类命令的文件路径参数 ——
const READ_CMDS = /^(cat|head|tail|less|more|nl|bat|zcat|grep|egrep|fgrep|rg|ack|awk|sed|type)([.]exe)?$/;
const PATH_RE = new RegExp('^(?:[A-Za-z]:[' + String.fromCharCode(92) + '/.][^|<>;*?]*|/[^|<>;*?]+|[.]{1,2}/[^|<>;*?]+|~/[^|<>;*?]+)$');
function splitArgs(s) {
  const out = []; let cur = '', q = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (ch <= ' ') { if (cur) out.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
// shell 命令的行范围推定:head/tail -n N、sed -n 'a,bp';其余(cat/grep 等)视为整文件
function shellRange(c0, args) {
  for (let i = 0; i < args.length; i++) {
    const m = args[i].match(/^-(\d+)$/) || (args[i] === '-n' && args[i + 1] ? args[i + 1].match(/^(\d+)$/) : null);
    if (m) return c0 === 'head' ? '1–' + m[1] + ' 行' : '末 ' + m[1] + ' 行';
  }
  if (c0 === 'sed') for (const a of args) { const m = a.match(/^(\d+)(?:,(\d+))?p$/); if (m) return m[1] + '–' + (m[2] || m[1]) + ' 行'; }
  return '';
}
// Read 工具的行范围:来自记账时的 offset/limit,均缺省 = 全文
function readRange(r) {
  const off = r.off | 0, lim = r.lim | 0;
  if (off && lim) return off + '–' + (off + lim - 1) + ' 行';
  if (off) return off + '–末尾 行';
  if (lim) return '1–' + lim + ' 行';
  return '全文';
}
function inferShellReads(cmd) {
  const found = [];
  for (const seg of cmd.split(/&&|;|[(|]/)) {
    const parts = splitArgs(seg.trim());
    if (!parts.length || !READ_CMDS.test(parts[0].toLowerCase())) continue;
    const c0 = parts[0].toLowerCase();
    if (c0.startsWith('sed') && (seg.includes(' -i') || seg.includes('--in-place'))) continue;
    const rg = shellRange(c0, parts.slice(1));
    for (const t of parts.slice(1)) {
      if (t.startsWith('-') || t === '|' || t === '>') continue;
      if (PATH_RE.test(t)) found.push({ p: t, rg });
    }
  }
  return found;
}

function readState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
function writeState(s) { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s)); } catch {} }

function forwardToGryph(raw) {
  return new Promise(resolve => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    try {
      const child = spawn(GRYPH, ['_hook', 'claude-code', 'Stop'], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('exit', fin); child.on('error', fin);
      child.stdin.on('error', fin);
      child.stdin.end(raw || '{}');
      setTimeout(fin, 8000);
    } catch { fin(); }
  });
}

let raw = '';
let ran = false;
process.stdin.on('data', c => raw += c);
process.stdin.on('error', () => {});
process.stdin.on('end', () => { run().catch(() => {}); });
setTimeout(() => { if (!ran) run().catch(() => {}); }, 1500); // 兜底:stdin 挂死也照跑
async function run() {
  if (ran) return; ran = true;
  dbg('invoked, stdin=' + String(raw).slice(0, 300).replace(/\n/g, ' '));
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch (e) { dbg('payload parse failed: ' + e); }
  await forwardToGryph(raw);
  dbg('gryph forwarded');

  try { main(payload); } catch (e) { dbg('main error: ' + e); }
  process.exit(0);
}

function main(payload) {
  const sid = payload.session_id || payload.sessionId || '';
  if (!sid) { dbg('no session id, skip'); return; }
  // stop_hook_active:本次 Stop 是否由上一次续写引发(字段若存在则是最可靠的防抖信号)
  const cont = payload.stop_hook_active === true || payload.stop_hook_active === 'true';
  dbg('sid=' + String(sid).slice(0, 12) + ' stop_hook_active=' + JSON.stringify(payload.stop_hook_active));
  const state = readState();
  const now = Date.now();
  // 水位状态兼容旧格式(纯数字);新格式 {wm, emit, emitTs}
  const old = state[sid];
  const oldWm = typeof old === 'number' ? old : (old && typeof old.wm === 'number' ? old.wm : null);
  const sinceMs = oldWm !== null ? oldWm : now - FIRST_LOOKBACK_MS;
  const justEmitted = !!old && typeof old === 'object' && old.emit === true && now - (old.emitTs || 0) < EMIT_COOLDOWN_MS;
  state[sid] = { wm: now };
  writeState(state); // 先推水位:同一回合绝不重复触发

  // 下界不加容差:工具事件严格先于 Stop 水位落账,加容差会导致续写后二次 Stop 重复触发
  const inWin = t => { const x = new Date(t).getTime(); return x >= sinceMs && x <= now + 5000; };

  // —— 主数据源:本地账本 ledger.jsonl ——
  const entries = []; // {t, src, path, rg},src = 'Read' | 'shell'
  const seen = new Set();
  const add = (t, src, p, rg = '') => { if (!p || seen.has(p)) return; seen.add(p); entries.push({ t, src, path: p, rg }); };
  let ledgerAnyForSid = false;
  // 会话累计(账本留存内,不受本轮窗口限制):按文件聚合 次数/来源构成/最近读取时间
  let cumN = 0; const cumFiles = new Set(); const cumMap = new Map();
  const cumRec = (p, isRead, t) => {
    cumN++; cumFiles.add(p);
    const c = cumMap.get(p) || { n: 0, r: 0, s: 0, last: t };
    c.n++; if (isRead) c.r++; else c.s++;
    if (String(t) > String(c.last)) c.last = t;
    cumMap.set(p, c);
  };
  try {
    const lines = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
    for (const l of lines) {
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (r.sid !== sid) continue;
      ledgerAnyForSid = true;
      if (r.tool === 'Read' && r.path) cumRec(r.path, true, r.t);
      else if (r.cmd) for (const x of inferShellReads(r.cmd)) cumRec(x.p, false, r.t);
      if (!inWin(r.t)) continue;
      if (r.tool === 'Read' && r.path) add(r.t, 'Read', r.path, readRange(r));
      else if (r.cmd) for (const x of inferShellReads(r.cmd)) add(r.t, 'shell', x.p, x.rg || '—');
    }
    dbg('ledger sid=' + sid + ' entries=' + entries.length +
      (ledgerAnyForSid ? '' : ' (该 sid 在账本中无记录,记账 hook 可能未生效)'));
  } catch (e) { dbg('ledger read failed: ' + e); }

  // —— 回退:gryph 时间窗匹配(记账 hook 装好之前的旧会话)——
  if (!ledgerAnyForSid && entries.length === 0) {
    let evs;
    try {
      evs = JSON.parse(execFileSync(GRYPH, ['query', '--format', 'json', '--since', '24h'], { timeout: 15000 }));
    } catch (e) { dbg('gryph query failed: ' + e); return finish(entries, null); }

    const sidShort = String(sid).slice(0, 8);
    const sidMatch = e => {
      if (e.SessionID === sid) return true;
      if (!sidShort) return false;
      if (String(e.SessionID || '').slice(0, 8) === sidShort) return true;
      if (e.ShortSessionID === sidShort) return true;
      return false;
    };
    const mine = evs.filter(e => sidMatch(e) && inWin(e.Timestamp));
    dbg('fallback gryph matched ' + mine.length + ' events for sid=' + sid);
    for (const e of mine) {
      if (e.ActionType === 'file_read' && e.Path) add(e.Timestamp, 'Read', e.Path, '—');
      else if (e.ActionType === 'command_exec' && e.Command) {
        for (const x of inferShellReads(e.Command)) add(e.Timestamp, 'shell', x.p, x.rg || '—');
      }
    }
  }
  const cumRows = [...cumMap.entries()].sort((a, b) => b[1].n - a[1].n || String(b[1].last).localeCompare(String(a[1].last)));
  // 防抖二选一命中即放行:续写引发的 Stop(stop_hook_active),或「0 新读取 + 刚发过清单」
  if (cont) { dbg('stop_hook_active → continuation stop, pass'); return; }
  if (entries.length === 0 && justEmitted) { dbg('0 reads & just emitted → continuation stop, pass'); return; }
  state[sid] = { wm: now, emit: true, emitTs: now };
  writeState(state);
  finish(entries, ledgerAnyForSid ? { n: cumN, files: cumFiles.size, rows: cumRows } : null);
}

function finish(entries, cum) {
  entries.sort((a, b) => String(a.t).localeCompare(String(b.t)));
  const nR = entries.filter(e => e.src === 'Read').length;
  const nS = entries.length - nR;
  const hhmm = iso => { const d = new Date(iso); return isNaN(d.getTime()) ? '--:--' : d.toTimeString().slice(0, 5); };

  let body;
  if (entries.length === 0) {
    // 0 读取也展示:确认审计在工作
    body = '\n\n<details><summary>📁 本轮文件读取:0 个 —— 审计运行中,本回合无读取</summary>\n';
  } else {
    const over = entries.length - MAX_ITEMS;
    const rows = entries.slice(0, MAX_ITEMS)
      .map(e => '| ' + hhmm(e.t) + ' | ' + (e.src === 'Read' ? '📖 Read' : '⚡ shell') + ' | `' + e.path + '` | ' + (e.rg || '—') + ' |')
      .join('\n');
    body = '\n\n<details><summary>📁 本轮文件读取:' + entries.length + ' 个(Read ' + nR + ' · shell ' + nS + ')</summary>\n\n'
      + '| 时间 | 来源 | 文件 | 范围 |\n|---|---|---|---|\n' + rows + '\n';
    if (over > 0) body += '\n另有 ' + over + ' 个略,可用 /reads 查全量\n';
  }
  if (cum) {
    body += '\n📈 本会话累计(账本留存内):' + cum.n + ' 次读取 · ' + cum.files + ' 个文件去重\n';
    body += '\n<details><summary>📊 累计明细 · ' + Math.min(cum.rows.length, MAX_CUM) + ' 个文件(按读取次数排序)</summary>\n\n';
    body += '| 文件 | 次数 | 来源 | 最近读取 |\n|---|---|---|---|\n';
    body += cum.rows.slice(0, MAX_CUM)
      .map(([p, c]) => '| `' + p + '` | ' + c.n + ' | ' + (c.r && c.s ? 'Read×' + c.r + ' · shell×' + c.s : c.r ? 'Read×' + c.r : 'shell×' + c.s) + ' | ' + hhmm(c.last) + ' |')
      .join('\n') + '\n';
    if (cum.rows.length > MAX_CUM) body += '\n另有 ' + (cum.rows.length - MAX_CUM) + ' 个文件略\n';
    body += '\n</details>\n';
  }
  body += '\n</details>\n';

  dbg('block emitted, entries=' + entries.length + ' (Read ' + nR + ' shells ' + nS + ') restructure=' + restructureOn());
  // 严格 schema:Stop 的继续请求只允许 decision/reason
  process.stdout.write(JSON.stringify({ decision: 'block', reason: (restructureOn() ? INTRO_RESTRUCTURE : INTRO_BARE) + body }));
}
