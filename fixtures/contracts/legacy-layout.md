# 旧 Sion 项目布局（迁移输入契约）

迁移器接收用户选定的旧 Sion 工作区根目录，并读取：

```text
<legacy-root>/
  projects/<project-id>/
    project.json
    nodes/<workflow-node-id>.json
    chat/<workflow-node-id>/index.json
    chat/<workflow-node-id>/<session-id>.json
    files/index.json
    files/<stored attachment>
    files/<extracted text>.txt
    agent-overrides/index.json
    agent-overrides/<workflow-node-id>.md
    exports/<artifact>
  settings/model-providers.json
  settings/browser-search.json              # 永远跳过
```

旧版还可能含 `chat/<workflow-node-id>.json` 的单一历史会话、`nodes` 内的 `assumptions` / `openQuestions`、`.append-journal.json` 和浏览器 profile/cache。迁移器必须把前两者作为明确兼容输入；append journal 只能在记录完整性可证明时恢复，否则报告并拒绝静默丢失。所有浏览器相关目录、设置与事件均跳过。

fixture 中的所有时间、UUID、provider URL 和凭据都是人工构造的脱敏值，不能替换为真实用户数据。
