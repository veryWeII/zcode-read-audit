---
description: 审计速览:上一轮+累计的文件读取与输出速度(默认紧凑几行;--full 完整表格)
argument-hint: [--full | 会话ID,可组合]
---

生成审计报告。用 Bash 工具运行下面这条命令(首条是本机启动器,失败回退插件缓存内脚本),参数 $ARGUMENTS 原样透传:

```bash
node --no-warnings ~/.zcode/read-audit/report.js $ARGUMENTS 2>/dev/null || node --no-warnings "$(find ~/.zcode/cli/plugins -type f -name report.js -path '*read-audit*' 2>/dev/null | head -1)" $ARGUMENTS
```

- 无参数 = 当前会话紧凑速览(几行);`--full` = 完整折叠表格;`sess_…` 或 8 位短 ID = 复盘指定会话;可组合(如 `--full d011c81b`)。
- 脚本 stdout 已是最终展示格式,把它**逐字**粘贴给用户:不加开场白、不加解释、不改写、不增删、不自行补充审计数据。
- 脚本失败(退出码非 0、stderr 有信息)时如实说明原因即可,不要编造数据。
