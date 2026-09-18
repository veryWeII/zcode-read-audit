// 合并版 Stop hook(唯一注册):
//   1) 把负载原样转发给 gryph 审计入库;
//   2) 从本地账本 ledger.jsonl 生成本轮读取清单(时间/来源/文件三列表格,折叠 <details> 展示),
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
const FIRST_LOOKBACK_MS = 60 * 60 * 1000; // 会话首次触发时只回溯 1 小时
const MAX_ITEMS = 20;

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
function inferShellReads(cmd) {
  const found = [];
  for (const seg of cmd.split(/&&|;|[(|]/)) {
    const parts = splitArgs(seg.trim());
    if (!parts.length || !READ_CMDS.test(parts[0].toLowerCase())) continue;
    const c0 = parts[0].toLowerCase();
    if (c0.startsWith('sed') && (seg.includes(' -i') || seg.includes('--in-place'))) continue;
    for (const t of parts.slice(1)) {
      if (t.startsWith('-') || t === '|' || t === '>') continue;
      if (PATH_RE.test(t)) found.push(t);
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
  const state = readState();
  const now = Date.now();
  const sinceMs = typeof state[sid] === 'number' ? state[sid] : now - FIRST_LOOKBACK_MS;
  state[sid] = now;
  writeState(state); // 先推水位:同一回合绝不重复触发

  // 下界不加容差:工具事件严格先于 Stop 水位落账,加容差会导致续写后二次 Stop 重复触发
  const inWin = t => { const x = new Date(t).getTime(); return x >= sinceMs && x <= now + 5000; };

  // —— 主数据源:本地账本 ledger.jsonl ——
  const entries = []; // {t, src, path},src = 'Read' | 'shell'
  const seen = new Set();
  const add = (t, src, p) => { if (!p || seen.has(p)) return; seen.add(p); entries.push({ t, src, path: p }); };
  let ledgerAnyForSid = false;
  try {
    const lines = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
    for (const l of lines) {
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (r.sid !== sid) continue;
      ledgerAnyForSid = true;
      if (!inWin(r.t)) continue;
      if (r.tool === 'Read' && r.path) add(r.t, 'Read', r.path);
      else if (r.cmd) for (const p of inferShellReads(r.cmd)) add(r.t, 'shell', p);
    }
    dbg('ledger sid=' + sid + ' entries=' + entries.length +
      (ledgerAnyForSid ? '' : ' (该 sid 在账本中无记录,记账 hook 可能未生效)'));
  } catch (e) { dbg('ledger read failed: ' + e); }

  // —— 回退:gryph 时间窗匹配(记账 hook 装好之前的旧会话)——
  if (!ledgerAnyForSid && entries.length === 0) {
    let evs;
    try {
      evs = JSON.parse(execFileSync(GRYPH, ['query', '--format', 'json', '--since', '24h'], { timeout: 15000 }));
    } catch (e) { dbg('gryph query failed: ' + e); return finish(entries); }

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
      if (e.ActionType === 'file_read' && e.Path) add(e.Timestamp, 'Read', e.Path);
      else if (e.ActionType === 'command_exec' && e.Command) {
        for (const p of inferShellReads(e.Command)) add(e.Timestamp, 'shell', p);
      }
    }
  }
  finish(entries);
}

function finish(entries) {
  if (entries.length === 0) { dbg('no reads this turn, pass'); return; }
  entries.sort((a, b) => String(a.t).localeCompare(String(b.t)));
  const nR = entries.filter(e => e.src === 'Read').length;
  const nS = entries.length - nR;
  const over = entries.length - MAX_ITEMS;
  const hhmm = iso => { const d = new Date(iso); return isNaN(d.getTime()) ? '--:--' : d.toTimeString().slice(0, 5); };
  const rows = entries.slice(0, MAX_ITEMS)
    .map(e => '| ' + hhmm(e.t) + ' | ' + (e.src === 'Read' ? '📖 Read' : '⚡ shell') + ' | `' + e.path + '` |')
    .join('\n');

  let body = '\n\n<details><summary>📁 本轮文件读取:' + entries.length + ' 个(Read ' + nR + ' · shell ' + nS + ')</summary>\n\n'
    + '| 时间 | 来源 | 文件 |\n|---|---|---|\n' + rows + '\n';
  if (over > 0) body += '\n另有 ' + over + ' 个略,可用 /reads 查全量\n';
  body += '\n</details>\n';

  dbg('block emitted, entries=' + entries.length + ' (Read ' + nR + ' shells ' + nS + ')');
  // 严格 schema:Stop 的继续请求只允许 decision/reason
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: '【审计系统指令】你的回复已结束,现在输出本回合的最终展示版,无需任何思考或推理,禁止开场白、过渡句或确认。把你刚才的回复与审计清单合并为一条消息重新输出:回复内容在前——原回复较长时,先给 2~4 句总体摘要,再用 <details><summary>📖 完整说明</summary> 折叠完整原文(信息不得删减);原回复较短时直接复读原文。然后在最末尾逐字复制下面的审计清单,从 <details> 到 </details>,禁止改写、增删、总结:' + body
  }));
}
