// 路径解析:优先读仓库根的 paths.json(setup.js 生成,含本机绝对路径),否则用默认值。
// paths.json 是机器相关产物,已列入 .gitignore;换机器重跑 setup.js 即可。
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoDir = path.join(__dirname, '..');
let override = {};
try { override = JSON.parse(fs.readFileSync(path.join(repoDir, 'paths.json'), 'utf8')); } catch {}

module.exports = {
  repoDir,
  dataDir: override.dataDir || path.join(os.homedir(), '.zcode', 'read-audit'),
  gryph: override.gryph || 'gryph',
  port: override.port || 7431,
};
