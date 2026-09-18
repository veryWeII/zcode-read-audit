// db-lookup.js:Stop 时刻直查 ZCode 原生库(db.sqlite,热库只读)——主数据源,覆盖主会话与子代理。
// 子代理归属:session.parent_id 精确外键,非时间窗推定。
// 兼容策略:part.data 是 ZCode 内部格式,任何打开/解析异常一律返回 ok:false,由 stop-hook 自动回退本地账本通道。
// 可用环境变量 ZCODE_READ_AUDIT_DB 覆盖库路径(测试用)。
const path = require('path');
const os = require('os');

function lookup({ sid, fromMs, toMs, inferShellReads, readRange }) {
  try {
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); } catch { return { ok: false, error: 'node:sqlite unavailable' }; }
    const dbPath = process.env.ZCODE_READ_AUDIT_DB || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // 子代理会话:parent_id 精确归属到本会话
      const subSids = db.prepare('SELECT id FROM session WHERE parent_id=?').all(sid).map(r => r.id);
      const sids = [sid, ...subSids];

      // 只取 Read/Bash 工具部件(LIKE 预筛掉 text/reasoning 部件,走 session_id 索引);一遍扫描同时产出本轮窗口条目与会话累计
      const stmt = db.prepare(
        'SELECT session_id sid, time_created t, data FROM part WHERE session_id=? AND time_created<=? ' +
        "AND (data LIKE '%\"tool\":\"Read\"%' OR data LIKE '%\"tool\":\"Bash\"%')");
      const entries = [];
      const seen = new Set();
      const cumMap = new Map(); // path -> {n, r, s, last(ms)}
      const addE = (t, src, p, rg, sub) => { if (!p || seen.has(p)) return; seen.add(p); entries.push({ t: new Date(t).toISOString(), src, path: p, rg, sub }); };
      const cumRec = (p, isRead, t) => {
        const c = cumMap.get(p) || { n: 0, r: 0, s: 0, last: t };
        c.n++; if (isRead) c.r++; else c.s++;
        if (t > c.last) c.last = t;
        cumMap.set(p, c);
      };
      for (const s of sids) {
        for (const row of stmt.all(s, toMs)) {
          let d; try { d = JSON.parse(row.data); } catch { continue; }
          if (d.type !== 'tool' || !d.tool) continue;
          const sub = row.sid !== sid;
          const inp = (d.state && d.state.input) || {};
          const inWinP = row.t >= fromMs;
          if (d.tool === 'Read' && inp.file_path) {
            if (inWinP) addE(row.t, 'Read', inp.file_path, readRange({ off: Number(inp.offset) || 0, lim: Number(inp.limit) || 0 }), sub);
            cumRec(inp.file_path, true, row.t);
          } else if (d.tool === 'Bash' && inp.command) {
            for (const x of inferShellReads(String(inp.command))) {
              if (inWinP) addE(row.t, 'shell', x.p, x.rg || '—', sub);
              cumRec(x.p, false, row.t);
            }
          }
        }
      }
      entries.sort((a, b) => String(a.t).localeCompare(String(b.t)));
      const rows = [...cumMap.entries()].sort((a, b) => b[1].n - a[1].n || (b[1].last - a[1].last));
      const cumN = rows.reduce((s, [, c]) => s + c.n, 0);
      return { ok: true, entries, subCount: entries.filter(e => e.sub).length, cum: { n: cumN, files: cumMap.size, rows } };
    } finally { try { db.close(); } catch {} }
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

module.exports = { lookup };
