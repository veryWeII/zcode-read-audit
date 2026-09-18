#!/usr/bin/env node
// zcode-read-audit 安装器 / 卸载器
//   安装:node setup.js            (幂等,重复执行安全)
//   卸载:node setup.js --revert   (只摘除本工具注册的 hooks,不动其他配置)
//
// 做的事:
//   1. 探测 node 绝对路径(=process.execPath)与 gryph 绝对路径(where/which → npm 全局探测)
//   2. 生成 paths.json(机器相关,已 gitignore)
//   3. 备份 ~/.zcode/cli/config.json 后,幂等合并 hooks:
//      SessionStart/UserPromptSubmit/PostToolUse/PostToolUseFailure → gryph 审计转发
//      PostToolUse 另挂 tool-ledger.js 记账;Stop 挂 stop-hook.js 生成本轮清单
//   4. 复制 commands/reads.md → ~/.zcode/commands/(聊天内 /reads 命令)
//   5. 创建数据目录 ~/.zcode/read-audit/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const repoDir = __dirname;
const isWin = process.platform === 'win32';
const zcodeDir = path.join(os.homedir(), '.zcode');
const cliConfig = path.join(zcodeDir, 'cli', 'config.json');
const commandsDir = path.join(zcodeDir, 'commands');
const dataDir = path.join(zcodeDir, 'read-audit');

function log(msg) { console.log('[setup] ' + msg); }

// 探测 gryph 绝对路径:where/which 可能同时命中 .exe 与无扩展名的 shim,优先 .exe(直接 spawn 最稳)
function findGryph() {
  try {
    const out = execSync(isWin ? 'where gryph' : 'which gryph', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    for (const line of out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
      if (line.toLowerCase().endsWith('.exe')) return line;
    }
  } catch {}
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
    const cand = path.join(prefix, 'node_modules', '@safedep', 'gryph', 'bin', isWin ? 'gryph.exe' : 'gryph');
    if (fs.existsSync(cand)) return cand;
  } catch {}
  return null;
}

// 识别"由本工具管理"的 hook:gryph 转发条目、指向本仓库的条目、以及旧版 gryph-dashboard 安装
// (注意脚本类 hook 的特征路径在 args 里——command 只是 node.exe 本身)
const libDir = path.join(repoDir, 'lib').toLowerCase();
function isOurs(h) {
  const c = String(h.command || '').toLowerCase();
  const a = (h.args || []).map(String).join(' ').toLowerCase();
  if ((h.args || [])[0] === '_hook') return true;
  if (c.includes('gryph-dashboard') || a.includes('gryph-dashboard')) return true;
  if (c.includes(libDir) || a.includes(libDir)) return true;
  return false;
}

function stripOurs(config) {
  const events = config.hooks && config.hooks.events;
  if (!events) return;
  for (const ev of Object.keys(events)) {
    events[ev] = (events[ev] || [])
      .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) }))
      .filter(g => (g.hooks || []).length > 0 || Object.keys(g).some(k => k !== 'hooks' && k !== 'matcher'));
  }
}

function installHooks(config, nodeExe, gryphExe) {
  if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};
  config.hooks.enabled = true;
  if (!config.hooks.events) config.hooks.events = {};

  // 超时余量:gryph 转发 25s(长会话 transcript 大、入库慢,丢事件不影响本轮清单);
  // 本地脚本纯追加/纯读,实际毫秒级,下面给的时限只是保险丝
  const script = (name, timeoutMs, msg) => ({
    type: 'process', command: nodeExe, args: [path.join(repoDir, 'lib', name)],
    timeoutMs, statusMessage: 'read-audit: ' + msg
  });
  const gryphHook = ev => ({
    type: 'process', command: gryphExe, args: ['_hook', 'claude-code', ev],
    timeoutMs: 25000, statusMessage: 'gryph: ' + ev
  });

  stripOurs(config);
  const E = config.hooks.events;
  const upsert = (ev, hooks) => { E[ev] = [...(E[ev] || []), { hooks }]; };

  if (gryphExe) {
    upsert('SessionStart', [gryphHook('SessionStart')]);
    upsert('UserPromptSubmit', [gryphHook('UserPromptSubmit')]);
    upsert('PostToolUseFailure', [gryphHook('PostToolUseFailure')]);
    E.PostToolUse = [...(E.PostToolUse || []), { hooks: [gryphHook('PostToolUse'), script('tool-ledger.js', 10000, '记账')] }];
  } else {
    upsert('PostToolUse', [script('tool-ledger.js', 10000, '记账')]);
    log('⚠ 未找到 gryph,已跳过 gryph 审计转发(仅记账+每轮清单可用);安装: npm i -g @safedep/gryph 后重跑');
  }
  upsert('Stop', [script('stop-hook.js', 25000, '汇总本轮读取文件')]);
}

function main() {
  if (!fs.existsSync(cliConfig)) {
    log('未找到 ' + cliConfig + ' —— 请确认已安装并运行过 ZCode CLI/桌面端后重试');
    process.exit(1);
  }

  if (process.argv.includes('--revert')) {
    const config = JSON.parse(fs.readFileSync(cliConfig, 'utf8'));
    stripOurs(config);
    fs.writeFileSync(cliConfig, JSON.stringify(config, null, 2));
    try { fs.rmSync(path.join(commandsDir, 'reads.md')); log('已移除 /reads 命令'); } catch {}
    try { fs.rmSync(path.join(repoDir, 'paths.json')); } catch {}
    log('已摘除本工具全部 hooks(其他配置未动)。已开的会话要等新会话才彻底脱离;数据目录保留:' + dataDir);
    return;
  }

  const nodeExe = process.execPath;
  const gryphExe = findGryph();
  log('node: ' + nodeExe);
  log('gryph: ' + (gryphExe || '(未找到)'));

  fs.writeFileSync(path.join(repoDir, 'paths.json'), JSON.stringify({ gryph: gryphExe || 'gryph', dataDir, port: 7431 }, null, 2));
  fs.mkdirSync(dataDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(cliConfig, cliConfig + '.bak-read-audit-' + stamp);

  const config = JSON.parse(fs.readFileSync(cliConfig, 'utf8'));
  installHooks(config, nodeExe, gryphExe);
  fs.writeFileSync(cliConfig, JSON.stringify(config, null, 2));

  fs.mkdirSync(commandsDir, { recursive: true });
  fs.copyFileSync(path.join(repoDir, 'commands', 'reads.md'), path.join(commandsDir, 'reads.md'));

  log('安装完成:');
  log('  • hooks 已写入 ' + cliConfig + '(备份: *.bak-read-audit-' + stamp + ')');
  log('  • /reads 命令已安装到 ' + path.join(commandsDir, 'reads.md'));
  log('  • 数据目录: ' + dataDir);
  log('注意:hook 配置按「内部会话创建」加载——已开的对话需新开对话/重启/上下文压缩后生效');
  log('仪表盘: npm start  →  http://127.0.0.1:7431');
}

main();
