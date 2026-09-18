---
description: 查询 AI 读过哪些文件(审计),支持 文件模式/会话ID/时间范围
argument-hint: [文件关键词 | 会话ID | --today]
---

查询审计日志并在对话中渲染结果。数据源优先用本地账本 `~/.zcode/read-audit/ledger.jsonl`(cat 直接读,按 sid 精确),查全局统计再用 gryph。根据参数 $ARGUMENTS 选择模式:

## 无参数或 --today:展示今天所有文件读取
依次运行(用 Bash 工具),把结果整理成两张 Markdown 表格展示:

```bash
gryph query --action file_read --format json --today
gryph sessions
```

第一张表「按会话分组」:列 = 会话ID(短)、读取文件数、读取的文件路径(去重)。
第二张表「总计」:列 = 会话数、读取事件总数、涉及文件总数、exec/write 统计(用 `gryph logs --format json --today`)。

## 参数是文件关键词:检查该文件是否被读过
先读账本(近48h):

```bash
cat ~/.zcode/read-audit/ledger.jsonl 2>/dev/null | grep -i "关键词"
```

再补全局:

```bash
gryph query --action file_read --format json --today
```

在结果中过滤 Path 包含关键词的记录,明确回答「已读/未读」,列出:读取时间、会话ID、完整路径、来源(Read 工具还是 shell 推定)。若都未读,再用 `gryph logs --format json --today` 检查 Command 字段是否含关键词(cat/grep 间接读)。

## 参数是会话ID(8位短ID):复盘该会话
```bash
gryph session $ARGUMENTS --show-diff
```
输出该会话完整活动时间线:读了什么、改了什么(diff 摘要)、执行了什么命令。

注意:所有 gryph 命令加 --format json 拿结构化数据,不要解析表格输出;gryph 不在 PATH 时全路径一般为 `<npm 全局前缀>/node_modules/@safedep/gryph/bin/gryph.exe`。
