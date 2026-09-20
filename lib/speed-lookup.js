// speed-lookup.js:Stop 时刻直查 model_usage,统计本轮与会话的模型输出速度,主循环与子代理分组。
// 稳健口径(与 tps_stats.py 一致):
//   可信行 = status='completed' 且 output≥300 tok 且 生成窗口(duration−TTFT)≥1s;
//   速率 = 可信行的加权持续速率 Σtokens ÷ Σ生成窗口,规避服务端攒批下发造成的瞬时假高 TPS
//   (小输出/毫秒级窗口的行,全部 token 可能在个别 SSE 块内集中到达,单行 TPS 无意义)。
//   全程 SQL 聚合零行传输,冷启动实测 <50ms;要分位数(p25/p75)时用 tps_stats.py 按需跑。
// 「本轮」= 水位窗口(上次 Stop 处理时刻 ~ 本次);上一回合「最终展示版」续写请求会落入
//   下一轮窗口,对加权速率影响可忽略。子代理经 session.parent_id 精确归属,独立分组;
//   query_source='session_title' 的后台请求不计入。
// 任何异常返回 null 静默降级,绝不影响读取清单本身。库路径可用 ZCODE_READ_AUDIT_DB 覆盖(测试用)。
const path = require('path');
const os = require('os');

const MIN_TOKENS = 300;
const MIN_GEN_MS = 1000;
const TITLE = 'session_title';

function speed({ sid, fromMs, toMs }) {
  try {
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); } catch { return null; }
    const dbPath = process.env.ZCODE_READ_AUDIT_DB || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const subSids = db.prepare('SELECT id FROM session WHERE parent_id=?').all(sid).map(r => r.id);
      const inSids = [sid, ...subSids];
      // trusted 条件的 CASE 重复出现,用占位组装保持单次索引扫描单次往返
      const TR = 'output_tokens>=? AND duration_ms-time_to_first_token_ms>=?';
      const sql =
        'SELECT session_id s, COUNT(*) n, SUM(output_tokens) out, ' +
        // 本轮窗口(纯计数,任何输出>0 的完成请求)
        'SUM(CASE WHEN completed_at>? AND completed_at<=? THEN 1 ELSE 0 END) tn, ' +
        'SUM(CASE WHEN completed_at>? AND completed_at<=? THEN output_tokens ELSE 0 END) tout, ' +
        // 可信行聚合:次数 / Σtokens / Σ生成窗口(会话全量)
        'SUM(CASE WHEN ' + TR + ' THEN 1 ELSE 0 END) cn, ' +
        'SUM(CASE WHEN ' + TR + ' THEN output_tokens ELSE 0 END) co, ' +
        'SUM(CASE WHEN ' + TR + ' THEN duration_ms-time_to_first_token_ms ELSE 0 END) cg, ' +
        // 可信行聚合:本轮窗口
        'SUM(CASE WHEN completed_at>? AND completed_at<=? AND ' + TR + ' THEN 1 ELSE 0 END) kn, ' +
        'SUM(CASE WHEN completed_at>? AND completed_at<=? AND ' + TR + ' THEN output_tokens ELSE 0 END) ko, ' +
        'SUM(CASE WHEN completed_at>? AND completed_at<=? AND ' + TR + ' THEN duration_ms-time_to_first_token_ms ELSE 0 END) kg, ' +
        // TTFT 原始值列表(group_concat 跳过 NULL):本轮窗口 / 会话全量,JS 端算中位数与 p75
        'group_concat(CASE WHEN completed_at>? AND completed_at<=? THEN time_to_first_token_ms END) ttt, ' +
        'group_concat(time_to_first_token_ms) stt ' +
        'FROM model_usage WHERE status=\'completed\' AND query_source!=? AND session_id IN (' +
        inSids.map(() => '?').join(',') + ')' +
        ' AND output_tokens>0 AND duration_ms IS NOT NULL AND time_to_first_token_ms IS NOT NULL ' +
        'AND duration_ms>time_to_first_token_ms GROUP BY session_id';
      const args = [fromMs, toMs, fromMs, toMs, MIN_TOKENS, MIN_GEN_MS, MIN_TOKENS, MIN_GEN_MS, MIN_TOKENS, MIN_GEN_MS,
                    fromMs, toMs, MIN_TOKENS, MIN_GEN_MS, fromMs, toMs, MIN_TOKENS, MIN_GEN_MS, fromMs, toMs, MIN_TOKENS, MIN_GEN_MS,
                    fromMs, toMs,
                    TITLE, ...inSids];
      const grp = () => ({ n: 0, out: 0, tn: 0, tout: 0, kn: 0, ko: 0, kg: 0, ttt: [], stt: [] });
      const r = { turn: { main: grp(), sub: grp() }, sess: { main: grp(), sub: grp() } };
      for (const row of db.prepare(sql).all(...args)) {
        const g = row.s === sid ? 'main' : 'sub';
        const S = r.sess[g], T = r.turn[g];
        S.n += Number(row.n); S.out += Number(row.out); S.kn += Number(row.cn); S.ko += Number(row.co); S.kg += Number(row.cg);
        T.n += Number(row.tn); T.out += Number(row.tout); T.kn += Number(row.kn); T.ko += Number(row.ko); T.kg += Number(row.kg);
        if (row.ttt) T.ttt.push(...String(row.ttt).split(',').map(Number));
        if (row.stt) S.stt.push(...String(row.stt).split(',').map(Number));
      }
      return r;
    } finally { try { db.close(); } catch {} }
  } catch { return null; }
}

function fmtTok(n) { return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
// 单行速率:无长输出时返回 null(小输出行的单行 TPS 无参考性,不展示速率只计数)
function rate(g) { return g.kn && g.kg > 0 ? Math.round(g.ko * 1000 / g.kg) : null; }
// TTFT 中位数(p75),毫秒值列表 → 「1.8s(p75 3.2s)」;空列表返回 null
function ttft(xs) {
  if (!xs || !xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const at = p => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
  const f = ms => ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
  return f(at(.5)) + '(p75 ' + f(at(.75)) + ')';
}

// 供 stop-hook 拼进审计清单:独立的「输出速度」折叠块,展开为表格式统计。
// 摘要只放最有信息量的本轮速率;无任何数据返回 ''。
function render(sp) {
  if (!sp) return '';
  const hasSub = sp.turn.sub.n > 0 || sp.sess.sub.n > 0;
  const rows = [
    ['⚡ 本轮·主循环', sp.turn.main, sp.turn.main.ttt], ['⚡ 本轮·子代理', sp.turn.sub, sp.turn.sub.ttt],
    ['📈 累计·主循环', sp.sess.main, sp.sess.main.stt], ['📈 累计·子代理', sp.sess.sub, sp.sess.sub.stt],
  ].filter(([, g]) => g.n > 0);
  if (!rows.length) return '';
  const tr = rows.map(([tag, g, tt]) =>
    '| ' + tag + ' | ' + fmtTok(g.out) + ' tok | ' + g.n + ' | ' +
    (rate(g) === null ? '—(无长输出)' : rate(g) + ' t/s') + ' | ' + (ttft(tt) || '—') + ' | ' + g.kn + '/' + g.n + ' |').join('\n');
  // 摘要:本轮主循环(与子代理)速率,缺则用累计
  const head = [];
  const rT = rate(sp.turn.main), rS = rate(sp.turn.sub), rC = rate(sp.sess.main);
  const tT = ttft(sp.turn.main.ttt);
  if (rT !== null) head.push('主循环 ' + rT + ' t/s');
  if (tT) head.push('TTFT ' + tT.split('(p75')[0]);
  if (rS !== null) head.push('子代理 ' + rS + ' t/s');
  if (!head.length && rC !== null) head.push('累计 ' + rC + ' t/s');
  if (!head.length) head.push('本轮无长输出样本');
  // 「(本轮)」仅当摘要确为本轮口径且有子代理需要消歧时标注,避免「累计 …(本轮)」自相矛盾
  const turnScoped = rT !== null || rS !== null || tT !== null;
  return '\n<details><summary>⚡ 输出速度:' + head.join(' · ') + (hasSub && turnScoped ? '(本轮)' : '') + '</summary>\n\n'
    + '| 范围 | 输出 | 请求 | 持续速率 | TTFT 中位(p75) | 可信行 |\n|---|---|---|---|---|---|\n' + tr + '\n\n'
    + '口径:可信行 = 输出≥300 tok 且生成窗口≥1s 的完成请求;持续速率 = 可信行 Σtokens ÷ Σ生成窗口,规避小输出/攒批下发的瞬时假高 TPS。'
    + 'TTFT = 请求开始到首个生成增量(思考或正文,先到者)的时长,含全部完成请求。主循环与子代理独立分组。\n'
    + '</details>\n';
}

module.exports = { speed, render };
