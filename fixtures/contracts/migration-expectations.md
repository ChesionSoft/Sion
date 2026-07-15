# 迁移 Golden 契约

迁移将旧项目**复制**到用户选择的项目目录：`<target>/.sion/`。它不修改输入树，也不复制任何浏览器搜索运行时状态。

| 输入 | `.sion/` 输出 | Golden 断言 |
| --- | --- | --- |
| `project.json` | `manifest.json` | id、名称、客户、作者、版本与时间戳保持；输出写入 `schema_version: 1`。 |
| `nodes/*.json` | `nodes/*.json` | 12 个节点均存在；id、status、revision、updatedAt 保持；Markdown 字节一致，除非旧数组字段按迁移规则追加为 Markdown。 |
| 会话索引 | `chat/<node>/sessions.json` | 会话 id、名称、节点、数量、时间保持；`webSearchEnabled` 删除，迁移报告记一项已移除设置。 |
| 会话消息 | `chat/<node>/<session>.json` | role、content、reasoningContent、turnId、reasoningDurationMs、usage 与历史 sources 保持。 |
| `files/` | `files/` | 索引字段保持；每个原件和提取文本逐个计算 SHA-256 并与输入一致。缺提取文本时保持失败状态，不静默重提取。 |
| 自定义规则 | `agent-overrides/` | index 和自定义 Markdown 字节一致；默认规则改由应用资源包版本引用。 |
| `exports/` | `exports/` | 已有文件逐字节复制；历史 DOCX 不重新生成或重新 QA。 |
| `model-providers.json` | 应用数据目录 `providers.json` | API Key 写入系统凭据库，providers 文件仅存 `key_ref`；旧密钥不进入项目目录或日志。 |
| 浏览器设置/profile/cache | 无 | 不迁移；迁移报告记录跳过项。 |

Golden 测试至少比较 JSON 规范化内容、文件数量、原件/提取文本的 SHA-256、导出文件 SHA-256 和旧项目树的迁移前后 SHA-256。若输出已存在 `.sion/`，迁移器必须拒绝覆盖。
