// report.js:审计报告的聚合与渲染层 —— /audit 按需命令与 Stop 自动模式(可选)共用。
//
// 命令行用法: node report.js [--sid <会话ID或前缀>]
//   不带 --sid 时自动定位「最近活跃的根会话」——/audit 触发消息本身会把当前会话顶到
//   session.time_updated 之首,因此「最新根会话」就是当前会话(命令行手动跑则取最近用过的)。
//   「上一轮」窗口 = 最近两条真实用户消息之间:role=user 且 metadata.source 为空
//   (排除 todo_reminder / background_task / subagent_message 等合成 user 消息);
//   最后一条真实用户消息即本次 /audit 触发,倒数第二条到它之间恰为刚结束的上一回合,
//   本回合为生成报告而做的探测读取天然落在窗口外,不会被计入。
//
// 数据源三级(与原 Stop 清单一致):① 直查 ZCode 原生库 db.sqlite(db-lookup.js,
//   子代理经 parent_id 精确归属)② 本地账本 ledger.jsonl ③ gryph 时间窗(兜底)。
// 输出纯 Markdown(<details> 折叠块),由调用方逐字展示;任何异常静默降级。
// 可用环境变量 ZCODE_READ_AUDIT_DB 覆盖库路径(测试用)。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { dataDir, gryph } = require('./paths');

const LEDGER = path.join(dataDir, 'ledger.jsonl');
const MAX_ITEMS = 20; // 单轮清单最多列出的条目数
const MAX_CUM = 30; // 累计明细表最多列出的文件数

// —— shell 读取推定:从 Bash 命令原文提取读取类命令的文件路径参数 ——
// 相对路径处理:模型惯用 `cd <目录> && <命令>` 链,段内相对路径按 cd 前缀解析为绝对路径再计入;
// 无 cd 上下文时按原样记录(可读性优先,不猜会话 cwd)。
// 误报抑制:grep/rg/sed/awk 类首个位置参数是模式/程序而非文件,跳过(否则 `grep -v "/dist/"`
// 的排除模式会被当成文件);其余参数需「文件感」(含分隔符或带扩展名)才计入。
const READ_CMDS = /^(cat|head|tail|less|more|nl|bat|zcat|grep|egrep|fgrep|rg|ack|awk|sed|type)([.]exe)?$/;
const SKIP_FIRST = /^(grep|egrep|fgrep|rg|ack|sed|awk)([.]exe)?$/; // 首个位置参数 = 模式/脚本(单参数即模式,读 stdin)
const FILEISH = /[/\\]|\.[A-Za-z0-9]{1,8}$/; // 「文件感」:含路径分隔符,或以常见扩展名结尾
const PATH_RE = new RegExp('^(?:[A-Za-z]:[' + String.fromCharCode(92) + '/.][^|<>;*?]*|/[^|<>;*?]+|[.]{1,2}/[^|<>;*?]+|~/[^|<>;*?]+)$');
const ABS_RE = /^(?:[A-Za-z]:[\\/][^|<>;*?]*|\/[^|<>;*?]+)$/; // cd 前缀只认绝对路径
function splitArgs(s) {
  const out = []; let cur = '', q = null;
  for (const ch of s) {
    if (q) {
      if (ch === q) { if (cur === '') out.push(''); q = null; } // 保留空引号参数:它占着「模式位」
      else cur += ch;
    }
    else if (ch === '"' || ch === "'") q = ch;
    else if (ch <= ' ') { if (cur) out.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
// cwd + 相对路径 → 归一化绝对路径(处理 . / .. 段;保留 msys 的 /e/ 与 Windows 的 E:\ 两种风格)
function normJoin(cwd, rel) {
  const sep = cwd.includes('\\') ? '\\' : '/';
  const hadRoot = (cwd + sep + rel).startsWith('/');
  const out = [];
  for (const p of (cwd + sep + rel).split(/[/\\]+/)) {
    if (!p || p === '.') continue;
    if (p === '..') { if (out.length > 1) out.pop(); continue; }
    out.push(p);
  }
  let s = out.join(sep);
  if (hadRoot && sep === '/') s = '/' + s;
  return s;
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
// 文件类型图标:按扩展名映射(顺序敏感,先具体后一般),未识别类型用 📄
const ICONS = [
  [/\.(js|mjs|cjs|ts|tsx|jsx)$/i, '📜'],
  [/\.json$/i, '🧾'],
  [/\.md$/i, '📝'],
  [/\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i, '🖼️'],
  [/\.(html?|vue)$/i, '🌐'],
  [/\.(css|scss|less)$/i, '🎨'],
  [/\.py$/i, '🐍'],
  [/\.(sh|bash|zsh|ps1|bat|cmd)$/i, '⌨️'],
  [/\.(yaml|yml|toml|ini|cfg|conf|env|lock)$/i, '⚙️'],
  [/\.(zip|gz|tar|rar|7z|exe|dll|msi)$/i, '📦'],
  [/\.log$/i, '📋'],
];
const iconOf = p => { for (const [re, ic] of ICONS) if (re.test(p)) return ic; return '📄'; };
// msys 风格 /e/a/b → E:/a/b,统一分隔符为 /,消除同文件双计(msys 与 Win32 写法各计一次)
function normPath(p) {
  let s = String(p).replace(/\\/g, '/');
  const m = s.match(/^\/([a-zA-Z])\/(.*)$/);
  if (m) s = m[1].toUpperCase() + ':/' + m[2];
  return s;
}
function inferShellReads(cmd) {
  const found = [];
  let cwd = ''; // && 链上 cd 前缀跟踪的相对基准
  for (const seg of String(cmd || '').split(/&&|;|[(|]/)) {
    const parts = splitArgs(seg.trim());
    if (!parts.length) continue;
    const c0 = parts[0].toLowerCase();
    if (c0.replace(/\.exe$/, '') === 'cd' && parts[1]) {
      if (ABS_RE.test(parts[1])) cwd = parts[1].replace(/[/\\]+$/, '');
      continue;
    }
    if (!READ_CMDS.test(c0)) continue;
    if (c0.startsWith('sed') && (seg.includes(' -i') || seg.includes('--in-place'))) continue;
    const rg = shellRange(c0, parts.slice(1));
    let pos = parts.slice(1).filter(t => !t.startsWith('-') && !t.startsWith('$') && !/[<>]/.test(t)); // 排除旗标/变量/重定向标记
    // 跳过模式/脚本参数;rg --files 例外(其后全是路径,无模式位)
    if (SKIP_FIRST.test(c0) && !(c0.replace(/\.exe$/, '') === 'rg' && parts.slice(1).some(t => t === '--files' || t.startsWith('--files='))) && pos.length) pos = pos.slice(1);
    for (const t of pos) {
      if (!FILEISH.test(t)) continue;
      if (PATH_RE.test(t)) found.push({ p: normPath(t), rg });
      else found.push({ p: normPath(cwd ? normJoin(cwd, t) : t), rg });
    }
  }
  return found;
}

// —— 会话与窗口定位(只读原生库)——
function openDb() {
  let DatabaseSync;
  ({ DatabaseSync } = require('node:sqlite')); // 不可用直接抛出,由调用方降级
  const dbPath = process.env.ZCODE_READ_AUDIT_DB || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
  return new DatabaseSync(dbPath, { readOnly: true });
}

// 解析目标会话:--sid 精确 → 前缀匹配(根会话)→ 最近活跃根会话 → 账本最后一行的 sid
function resolveSid(want) {
  try {
    const db = openDb();
    try {
      if (want) {
        const exact = db.prepare('SELECT id FROM session WHERE id=?').get(want);
        if (exact) return { sid: exact.id, how: 'exact' };
        const pref = db.prepare("SELECT id FROM session WHERE id LIKE ? AND parent_id IS NULL ORDER BY time_updated DESC LIMIT 1").get(want + '%');
        if (pref) return { sid: pref.id, how: 'prefix' };
      }
      const last = db.prepare('SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 1').get();
      if (last) return { sid: last.id, how: 'latest' };
    } finally { try { db.close(); } catch {} }
  } catch {}
  try {
    const lines = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
    const r = JSON.parse(lines[lines.length - 1]);
    if (r.sid) return { sid: r.sid, how: 'ledger-last' };
  } catch {}
  return null;
}

// 「上一轮」窗口:最近两条真实用户消息之间。返回 null 表示该会话尚无已完成的上一轮;
// 原生库不可用时退化为「近 1 小时」窗口(窗口起止会展示,口径透明)。
function lastTurnWindow(sid) {
  try {
    const db = openDb();
    try {
      const rows = db.prepare(
        "SELECT time_created t FROM message WHERE session_id=? " +
        "AND json_extract(data,'$.role')='user' AND json_extract(data,'$.metadata.source') IS NULL " +
        'ORDER BY time_created DESC LIMIT 2').all(sid);
      if (rows.length >= 2) return { fromMs: rows[1].t, toMs: rows[0].t };
      return null;
    } finally { try { db.close(); } catch {} }
  } catch { const now = Date.now(); return { fromMs: now - 60 * 60 * 1000, toMs: now, fallback: true }; }
}

// —— 三级数据源:取窗口内读取条目 + 会话累计 ——
// 返回 { entries, cum, source }:entries = [{t, src, path, rg, sub?}],cum = {n, files, rows} | null
function collectReads({ sid, fromMs, toMs }) {
  // ① ZCode 原生库直查(覆盖主会话与子代理)
  try {
    const r = require('./db-lookup').lookup({ sid, fromMs, toMs, inferShellReads, readRange });
    if (r && r.ok) return { entries: r.entries, cum: r.cum, source: 'db' };
  } catch {}

  // ② 本地账本 ledger.jsonl
  const entries = [];
  const seen = new Set();
  const add = (t, src, p, rg = '') => { if (!p || seen.has(p)) return; seen.add(p); entries.push({ t, src, path: p, rg }); };
  let ledgerAnyForSid = false;
  let cumN = 0; const cumFiles = new Set(); const cumMap = new Map();
  const cumRec = (p, isRead, t) => {
    cumN++; cumFiles.add(p);
    const c = cumMap.get(p) || { n: 0, r: 0, s: 0, last: t };
    c.n++; if (isRead) c.r++; else c.s++;
    if (String(t) > String(c.last)) c.last = t;
    cumMap.set(p, c);
  };
  const inWin = t => { const x = new Date(t).getTime(); return x >= fromMs && x <= toMs + 5000; };
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
  } catch {}
  if (ledgerAnyForSid || entries.length) {
    const rows = [...cumMap.entries()].sort((a, b) => b[1].n - a[1].n || String(b[1].last).localeCompare(String(a[1].last)));
    return { entries, cum: ledgerAnyForSid ? { n: cumN, files: cumFiles.size, rows } : null, source: 'ledger' };
  }

  // ③ gryph 时间窗(记账 hook 装好之前的旧会话)
  let evs;
  try { evs = JSON.parse(execFileSync(gryph, ['query', '--format', 'json', '--since', '24h'], { timeout: 15000 })); } catch { evs = []; }
  const sidShort = String(sid).slice(0, 8);
  const sidMatch = e => {
    if (e.SessionID === sid) return true;
    if (!sidShort) return false;
    if (String(e.SessionID || '').slice(0, 8) === sidShort) return true;
    if (e.ShortSessionID === sidShort) return true;
    return false;
  };
  for (const e of evs) {
    if (!sidMatch(e) || !inWin(e.Timestamp)) continue;
    if (e.ActionType === 'file_read' && e.Path) add(e.Timestamp, 'Read', e.Path, '—');
    else if (e.ActionType === 'command_exec' && e.Command) for (const x of inferShellReads(e.Command)) add(e.Timestamp, 'shell', x.p, x.rg || '—');
  }
  return { entries, cum: null, source: 'gryph' };
}

// —— 渲染:单轮清单 + 会话累计 + 输出速度,全部 <details> 折叠块 ——
// fromMs = null 表示无「上一轮」(该会话第一条消息就是触发命令),只出累计与速度累计。
function buildTurnReport({ sid, fromMs, toMs, turnLabel }) {
  const { entries, cum } = collectReads({ sid, fromMs: fromMs === null ? -Infinity : fromMs, toMs });
  entries.sort((a, b) => String(a.t).localeCompare(String(b.t)));
  const nR = entries.filter(e => e.src === 'Read').length;
  const nS = entries.length - nR;
  const hhmm = iso => { const d = new Date(iso); return isNaN(d.getTime()) ? '--:--' : d.toTimeString().slice(0, 5); };

  let body = '\n\n';
  const ATTR = '> 🔧 本审计区块由 zcode-read-audit 插件脚本生成(非模型陈述),统计口径见块尾说明。\n\n';
  if (fromMs === null) {
    body += '<details><summary>📁 ' + turnLabel + '文件读取:无 —— 该会话尚无已完成的回合</summary>\n\n' + ATTR;
  } else if (entries.length === 0) {
    body += '<details><summary>📁 ' + turnLabel + '文件读取:0 个 —— 审计运行中,该回合无读取</summary>\n\n' + ATTR;
  } else {
    const over = entries.length - MAX_ITEMS;
    const subN = entries.filter(e => e.sub).length;
    const rows = entries.slice(0, MAX_ITEMS)
      .map(e => '| ' + hhmm(e.t) + ' | ' + (e.sub ? '🤖 ' : '') + (e.src === 'Read' ? '📖 Read' : '⚡ shell') + ' | ' + iconOf(e.path) + ' `' + e.path + '` | ' + (e.rg || '—') + ' |')
      .join('\n');
    body += '<details><summary>📁 ' + turnLabel + '文件读取:' + entries.length + ' 个(Read ' + nR + ' · shell ' + nS + (subN ? ' · 🤖子代理 ' + subN : '') + ')</summary>\n\n' + ATTR
      + '| 时间 | 来源 | 文件 | 范围 |\n|---|---|---|---|\n' + rows + '\n';
    if (over > 0) body += '\n另有 ' + over + ' 个略,可用 /reads 查全量\n';
    body += '\n口径:📖 Read 工具直录;⚡ shell 为读取类命令推定(cat/head/tail/grep/rg/sed 等,相对路径按命令内 cd 前缀解析);git log/show、ls/find 等不在统计内。\n';
  }
  if (cum) {
    body += '\n📈 本会话累计:' + cum.n + ' 次读取 · ' + cum.files + ' 个文件去重\n';
    body += '\n<details><summary>📊 累计明细 · ' + Math.min(cum.rows.length, MAX_CUM) + ' 个文件(按读取次数排序)</summary>\n\n';
    body += '| 文件 | 次数 | 来源 | 最近读取 |\n|---|---|---|---|\n';
    body += cum.rows.slice(0, MAX_CUM)
      .map(([p, c]) => '| ' + iconOf(p) + ' `' + p + '` | ' + c.n + ' | ' + (c.r && c.s ? 'Read×' + c.r + ' · shell×' + c.s : c.r ? 'Read×' + c.r : 'shell×' + c.s) + ' | ' + hhmm(c.last) + ' |')
      .join('\n') + '\n';
    if (cum.rows.length > MAX_CUM) body += '\n另有 ' + (cum.rows.length - MAX_CUM) + ' 个文件略\n';
    body += '\n</details>\n';
  } else if (fromMs !== null) {
    body += '\n📈 本会话累计:暂无数据(原生库与账本均无该会话记录)\n';
  }
  body += '\n</details>\n';

  // 输出速度:独立折叠块,轮次行标签随口径(本轮/上一轮)
  try {
    const sp = require('./speed-lookup').speed({ sid, fromMs: fromMs === null ? 0 : fromMs, toMs: fromMs === null ? 0 : toMs });
    body += require('./speed-lookup').render(sp, turnLabel);
  } catch {}
  return { text: body, n: entries.length, nR, nS };
}

// —— 紧凑速览:几行以内,模型两三秒可贴完(/audit 默认形态;完整表格走 --full)——
const basename = p => String(p).split(/[\\/]/).pop();
function compactReport(sid, w, fullHint) {
  const fromMs = w ? w.fromMs : null;
  const toMs = w ? w.toMs : Date.now();
  const hhmm = ms => new Date(ms).toTimeString().slice(0, 5);
  const out = ['📋 /audit · 会话 ' + String(sid).slice(0, 8) + ' · 上一轮 ' + (fromMs === null ? '—' : hhmm(fromMs) + '–' + hhmm(toMs))];

  if (fromMs === null) {
    out.push('📁 上一轮:尚无已完成回合(本会话第一条消息就是本次触发)');
  } else {
    const { entries, cum } = collectReads({ sid, fromMs, toMs });
    const nR = entries.filter(e => e.src === 'Read').length;
    const subN = entries.filter(e => e.sub).length;
    if (!entries.length) out.push('📁 上一轮:0 个读取(该回合无读取)');
    else {
      const files = [...new Set(entries.map(e => e.path))];
      const show = files.slice(0, 6).map(p => iconOf(p) + basename(p)).join('、');
      out.push('📁 上一轮 ' + entries.length + ' 个(Read ' + nR + ' · shell ' + (entries.length - nR) + (subN ? ' · 🤖' + subN : '') + '):'
        + show + (files.length > 6 ? ' …另 ' + (files.length - 6) + ' 个' : ''));
      if (cum) out.push('📈 累计 ' + cum.n + ' 次 · ' + cum.files + ' 个文件');
    }
  }

  // 速度一行:上一轮与累计的主循环(有子代理样本则并列),中位 TTFT
  try {
    const s = require('./speed-lookup');
    const sp = s.speed({ sid, fromMs: fromMs === null ? 0 : fromMs, toMs: fromMs === null ? 0 : toMs });
    if (sp) {
      const med = xs => xs && xs.length ? s.ttft(xs).split('(p75')[0] : null;
      const seg = (g, tt) => (s.rate(g) === null ? '—' : s.rate(g) + ' t/s') + (tt ? '(TTFT ' + tt + ')' : '');
      const parts = [];
      if (sp.turn.main.n || sp.turn.sub.n)
        parts.push('上一轮 主循环 ' + seg(sp.turn.main, med(sp.turn.main.ttt))
          + (s.rate(sp.turn.sub) !== null ? ' / 子代理 ' + s.rate(sp.turn.sub) + ' t/s' : ''));
      parts.push('累计 主循环 ' + seg(sp.sess.main, med(sp.sess.main.stt))
        + (s.rate(sp.sess.sub) !== null ? ' / 子代理 ' + s.rate(sp.sess.sub) + ' t/s' : ''));
      out.push('⚡ ' + parts.join(';'));
    }
  } catch {}
  out.push(fullHint);
  return out.join('\n');
}

// —— CLI:node report.js [--sid <会话ID或前缀>] [--full] ——
// 参数宽松解析:--full 或裸 full → 完整表格;--sid X 或裸会话ID(sess_ 前缀 / 8位以上十六进制)→ 指定会话。
if (require.main === module || process.env.READ_AUDIT_REPORT_LAUNCH === '1') {
  const args = process.argv.slice(2);
  let want = '', full = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--full' || a === 'full') full = true;
    else if (a === '--sid' && args[i + 1]) want = args[++i];
    else if (/^sess_[0-9a-f]{4,}$|^[0-9a-f]{8,}$/i.test(a)) want = a;
  }
  const hit = resolveSid(want);
  if (!hit) { process.stderr.write('read-audit: 无法定位会话(原生库不可用且账本为空),可用 --sid 指定\n'); process.exit(1); }
  const w = lastTurnWindow(hit.sid);
  if (full) {
    const fromMs = w ? w.fromMs : null, toMs = w ? w.toMs : Date.now();
    const hhmm = ms => new Date(ms).toTimeString().slice(0, 5);
    const win = fromMs === null ? '无已完成回合' : hhmm(fromMs) + '–' + hhmm(toMs);
    process.stdout.write('📋 审计报告 · 会话 ' + String(hit.sid).slice(0, 8) + ' · 上一轮 ' + win + '\n');
    process.stdout.write(buildTurnReport({ sid: hit.sid, fromMs, toMs, turnLabel: '上一轮' }).text.trim() + '\n');
  } else {
    process.stdout.write(compactReport(hit.sid, w, '完整表格 → /audit --full(可再加会话ID复盘其他会话)') + '\n');
  }
}

module.exports = { inferShellReads, readRange, iconOf, resolveSid, lastTurnWindow, collectReads, buildTurnReport };
