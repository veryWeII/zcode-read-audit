// Stop hook(每轮自动附审计清单):
//   以 Stop continuation({"decision":"block","reason"})请求续写,续写格式 = **原回复逐字复读 +
//   末尾追加可折叠的审计区域**——模型正文内容/格式/顺序完全不变,不做摘要、不分区、不折叠正文。
//   (早期的「最终展示版」分区重组与「默认静默+按需」方案均已废弃;auto=false 可回到静默,
//    /audit 命令保留作按需/跨会话查询。)
//   清单计算与渲染统一在 report.js(db-lookup 三级数据源 + speed-lookup),本文件只管
//   水位窗口、防抖与续写指令。
// 会话关联与数据源三级见 report.js / db-lookup.js 头注。
// 自带调试日志:.stop-debug.log 记录每次调用与决策。任何异常静默放行,绝不干扰对话。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { dataDir, gryph } = require('./paths');
const { buildTurnReport } = require('./report');

const GRYPH = gryph;
const STATE = path.join(dataDir, '.stop-watermark.json');
const DEBUG = path.join(dataDir, '.stop-debug.log');
const SETTINGS = path.join(dataDir, 'settings.json');
const FIRST_LOOKBACK_MS = 60 * 60 * 1000; // 会话首次触发时只回溯 1 小时
const EMIT_COOLDOWN_MS = 2 * 60 * 1000; // 「刚发过清单」标志的有效期:覆盖续写收尾 Stop,又不至于吞掉下一个真实回合

// 续写指令:纯机械「复读原文 + 追加审计块」。
// 「删除手写清单」条款:模型有时会抢在 hook 前自己手写一份预测清单(必错),复读时必须删掉,
// 只保留脚本这份权威清单——否则复读会把手写错误清单一并带上。
// 「禁止核验」条款:复读模式下整条消息都以模型名义发出,模型可能因数字与自身印象不符而拒执
// (2026-09-28 实际发生过);数字由审计系统独立计算、口径见块内说明,必须原样复制。
const INTRO = '【审计系统指令】你的回复已结束,现在做一次纯机械复读续写,无需任何思考或推理,禁止开场白、过渡句、确认或任何额外文字。你的下一条输出必须且只能是:① 你刚才的回复原文逐字复读——内容、表述、格式、顺序与原文完全一致,禁止摘要、改写、重新分节、折叠正文或任何增删;若原文中含你自行手写的「文件读取」「输出速度」「累计明细」类审计表格或清单,复读时必须把它们整体删除——审计数据只以文末脚本清单为唯一版本;② 紧接着在末尾逐字复制下面的审计清单——文件读取块与输出速度块两个 <details> 内容块依序全部复制,从各自 <details> 逐字复制到 </details>。审计清单由审计系统从 ZCode 原生库独立计算,不属于你的陈述内容;即使数字与你的印象不一致(统计口径见块内说明,与你的记忆口径不同属正常),也必须原样复制,禁止以数据不准、不完整为由拒绝执行、修改数字或附加任何评论:';

// auto:每轮自动附清单(默认开);关闭则 Stop 仅静默转发,报告走 /audit 按需生成。
// 优先级:插件 hook 参数 > settings.json > 默认开;模板变量未展开时收到字面量 "${user_config...}",按未设置处理。
function autoOn() {
  const a = String(process.argv[2] || '').toLowerCase();
  if (a === 'true' || a === 'false') return a === 'true';
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    if (typeof s.auto === 'boolean') return s.auto;
  } catch {}
  return true;
}

function dbg(msg) {
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(DEBUG, new Date().toISOString() + ' ' + msg + '\n'); } catch {}
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
  if (!autoOn()) { dbg('sid=' + String(sid).slice(0, 12) + ' auto off → silent pass(仅 gryph 转发,报告走 /audit)'); return; }
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

  if (cont) { dbg('stop_hook_active → continuation stop, pass'); return; }
  // 清单计算(report.js:三级数据源 + 速度),防抖二选一命中即放行
  const r = buildTurnReport({ sid, fromMs: sinceMs, toMs: now + 5000, turnLabel: '本轮' });
  if (r.n === 0 && justEmitted) { dbg('0 reads & just emitted → continuation stop, pass'); return; }
  state[sid] = { wm: now, emit: true, emitTs: now };
  writeState(state);

  dbg('block emitted, entries=' + r.n + ' (Read ' + r.nR + ' shells ' + r.nS + '), 复读原文+追加清单');
  // 严格 schema:Stop 的继续请求只允许 decision/reason
  process.stdout.write(JSON.stringify({ decision: 'block', reason: INTRO + r.text }));
}
