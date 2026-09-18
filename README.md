# zcode-read-audit

ZCode 桌面端的**文件读取审计工具**:让 AI 每轮对话读过的文件"不依赖模型自觉"地自动展示,并配合实时仪表盘与按需查询。

## 功能一览

| 能力 | 形态 | 说明 |
|---|---|---|
| 每轮读取清单 | 对话末尾自动附上(可折叠表格) | Stop hook 从审计账本计算,模型只负责原样复读;Read 工具与 shell 命令(cat/grep 等)两类来源都覆盖,含行级范围与会话累计统计;0 读取的回合也展示(确认审计在工作) |
| 实时仪表盘 | `npm start` → http://127.0.0.1:7431 | 分会话 + 总计,每 3 秒刷新,含 shell 读取推定(紫色)、敏感文件高亮 |
| 按需深查 | 聊天输入框 `/reads` | 文件关键词 → 读没读过;会话 ID → 完整复盘(含 diff) |
| 全局审计库 | gryph SQLite | 所有工具调用落库,含敏感文件检测(.env/*.pem/.ssh 等) |

## 安装

### 方式一:ZCode 插件(推荐,零配置)

1. ZCode → 设置 → 插件管理 → 发现(Discover)→ `+` 添加市场:本仓库的 **GitHub 地址**或**本地目录**;
2. 安装 `zcode-read-audit`,完成。禁用/卸载同样在插件管理里一键操作。

插件模式零依赖即可用(每轮清单、行级范围、会话累计、`/reads`),hook 由插件自动启用,**新开的对话**立即生效。需要全局审计库(gryph)与仪表盘时,克隆本仓库走方式二。

> ⚠ 两种方式**二选一**:同时启用会双份记账、双份清单。从方式二切到方式一,先 `node setup.js --revert` 摘除旧 hooks。

### 方式二:setup.js(增强模式,含 gryph 转发与仪表盘)

```bash
# 1. 依赖:gryph(可选,没有则仅少全局审计/仪表盘)
npm i -g @safedep/gryph

# 2. 克隆本仓库后执行安装器
node setup.js

# 3. (可选)启动仪表盘
npm start
```

安装器会:探测 node/gryph 绝对路径 → 生成 `paths.json` → 备份并幂等合并 `~/.zcode/cli/config.json` 的 hooks → 安装 `/reads` 命令 → 创建数据目录 `~/.zcode/read-audit/`。

**生效时机**:hook 配置按「内部会话创建」加载——安装后**新开的对话**立即生效;已开的旧对话要等重启/上下文压缩/fork 后切换。

### 设置

- `~/.zcode/read-audit/settings.json` → `{"restructure": false}`:关闭「摘要+完整说明」内容层折叠,回到仅在回复末尾追加裸清单;缺省(或删除该文件)= 开启。插件模式下也可经插件设置界面(userConfig `restructure`)切换,两者取前者优先。
- `paths.json`(仅方式二)记录 gryph 路径/数据目录/仪表盘端口,换机器重跑 `setup.js` 再生成。

## 卸载

- 插件模式:插件管理里卸载/禁用即可,hook 随插件停止贡献;
- setup.js 模式:`node setup.js --revert`,只摘除本工具注册的 hooks 与 `/reads` 命令,不动其他配置。

两种模式的数据目录(`~/.zcode/read-audit/`)均保留,可手动删除。

## 工作原理

```
┌─ PostToolUse ──┬─ gryph _hook claude-code PostToolUse   → 全局审计库(SQLite)
│                └─ tool-ledger.js                        → 本地账本 ledger.jsonl(按原始 session_id)
│
└─ Stop ────────── stop-hook.js
                    ├─ 转发负载给 gryph
                    ├─ 从账本取「本轮」窗口内该会话的读取记录
                    │    (窗口起点=上次 Stop 的水位;Read 工具直取,shell 命令按 cat/head/grep/rg/sed… 推定路径)
                    └─ 有内容则以 {"decision":"block","reason":清单} 请求续写,
                         模型输出「最终展示版」:摘要 + ⚠️需注意与下一步(如有,独立折叠)+ 📖完整说明(折叠)+ 文末清单;
                         0 读取回合也展示清单(仅清单)
```

关键设计:

- **不依赖模型自觉**:清单内容由脚本从审计数据计算,模型无法"忘了报"或"少报"——它只是复读
- **双账本**:gryph 的会话 ID 是 UUIDv5 派生,与 ZCode 原始 `sess_` ID 无关联,不能用于会话过滤;本地账本记录 payload 原始 session_id,与 Stop 负载同源,精确匹配。gryph 仅作全局统计与旧会话回退
- **水位防抖 + 续写收尾识别**:每会话记录上次 Stop 水位且先推水位再干活;`stop_hook_active` 为真、或「0 新读取 + 刚发过清单」的 Stop 视为续写收尾直接放行——每回合固定一次续写,不会连环触发
- **shell 读取推定**:Bash 命令按 `&&`/`;`/`|`/`(` 分段,识别读取类命令后提取路径参数(绝对路径、`./`、`../`、`~/`);`sed -i` 排除。启发式,变量拼接/命令替换的路径识别不了,展示时标注"shell 推定"
- **行级范围**:Read 工具记录 offset/limit(缺省=全文),shell 识别 `head/tail -n`、`sed -n a,bp`;gryph 无行级数据,回退模式与仪表盘不显示范围
- **会话累计**:同一遍账本扫描顺出该会话历史读取总数(去重文件数),以二级 `<details>` 展开按文件聚合的明细表(次数/来源构成/最近读取,按次数排序);受账本 48h 留存限制,更早历史走 /reads 或仪表盘

## 排障

- **清单没出现**:看 `~/.zcode/read-audit/.stop-debug.log` 最后几行——`no sid` / `no reads this turn, pass` / `block emitted` 分别对应不同环节;`block emitted` 有了但界面没显示,则是该会话加载的还是旧 hook 配置(见"生效时机")
- **仪表盘打不开**:检查端口占用(`netstat -ano | findstr 7431`);系统代理可能拦 localhost,curl 加 `--noproxy "*"`
- **gryph 事件缺失**:长会话 transcript 大,gryph hook 可能慢——安装器已把超时设为 25s,仍丢事件时每轮清单不受影响(走本地账本)
- **手动测试**:向脚本灌模拟负载即可,例:`echo '{"session_id":"sess_X","hook_event_name":"Stop"}' | node lib/stop-hook.js`

## 已知边界

- 清单渲染最后一步仍由模型执行(指令要求逐字复制,乱改概率极低;账本/仪表盘始终是权威数据源)
- 最终展示版为模型重构(摘要+需注意与下一步+折叠全文+清单),原始回复保留在工作记录折叠中作备份;重构与复读意味着 token 开销与回复长度成正比,且每回合固定一次续写(0 读取也展示,确认审计在工作)
- 会话首次触发只回溯 1 小时,清单上限 20 条(超出提示用 `/reads` 查全量)
- ZCode 插件体系无自定义 UI 面板扩展点,折叠表格(`<details>`)是聊天 Markdown 体系内的最优形态

## 致谢

- [safedep/gryph](https://github.com/safedep/gryph) — 审计内核(Apache 2.0)
