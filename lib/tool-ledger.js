// PostToolUse 记账 hook:把每次工具调用以「payload 原始 session_id」为键追加到本地账本 ledger.jsonl。
// Stop hook 的本轮清单从这本账取数——同一来源的 sid 精确关联,不依赖 gryph 的派生会话 ID。
// 设计:极简极快(纯追加一条 JSON 行),任何异常静默 exit 0,绝不拖慢工具调用。
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');

const LEDGER = path.join(dataDir, 'ledger.jsonl');
const DEBUG = path.join(dataDir, '.stop-debug.log');
const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
const KEEP_MS = 48 * 60 * 60 * 1000;

function dbg(m) { try { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(DEBUG, new Date().toISOString() + ' [ledger] ' + m + '\n'); } catch {} }

let raw = '';
let done = false;
process.stdin.on('data', c => raw += c);
process.stdin.on('error', () => {});
process.stdin.on('end', () => { work(); process.exit(0); });
setTimeout(() => { work(); process.exit(0); }, 3000); // 兜底:stdin 迟迟不结束也照跑

function work() {
  if (done) return; done = true;
  try {
    const p = JSON.parse(raw || '{}');
    const sid = p.session_id || p.sessionId || '';
    if (!sid) { dbg('no sid, skip'); return; }
    const ti = p.tool_input || {};
    const rec = {
      t: new Date().toISOString(),
      sid,
      tool: p.tool_name || '',
      path: ti.file_path || '',
      cmd: String(ti.command || '').slice(0, 400)
    };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
    // 顺手瘦身:超 2MB 时只保留近 48h(窗口对齐 /reads 的文件查询范围;Stop 首次回溯仅 1h,不受影响)
    try {
      if (fs.statSync(LEDGER).size > MAX_LEDGER_BYTES) {
        const cut = Date.now() - KEEP_MS;
        const lines = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
        const keep = lines.filter(l => { try { return new Date(JSON.parse(l).t).getTime() > cut; } catch { return false; } });
        fs.writeFileSync(LEDGER, keep.join('\n') + (keep.length ? '\n' : ''));
        dbg('pruned ' + lines.length + '->' + keep.length);
      }
    } catch {}
  } catch (e) { dbg('error: ' + e); }
}
