# Sion Desktop A′ Spike

这是桌面重构前的隔离验证工程。它与现有 Next.js 代码并存，但不引用、启动或打包任何旧运行时代码；A′ 全部通过后，才允许 `codex/desktop-rust` 覆盖仓库根目录。

它验证五个不能靠设计文档保证的边界：

- Tauri React UI 与 Rust command 的版本化 IPC；
- OpenAI-compatible Chat Completions 与 Responses 的本地 SSE 流及取消；
- 中文 DOCX 的生成、ZIP 解包和基础结构检查；
- 系统凭据库的写入、读取和清理。
- 旧项目向 `<项目目录>/.sion/` 的暂存、校验、原子提交与失败回滚。

## 本地命令

```bash
npm install
npm run lint
npm run build
npm run test:rust
npm run test:keyring  # 写入并立即删除一个随机的系统临时凭据
npm run bundle
```

`npm run tauri dev` 会启动带有三项可点击检查的本机窗口。模型 SSE 测试使用内嵌本地 HTTP 服务器，不会请求任何真实模型；Keychain 测试使用随机账号和随机密钥，在验证后删除。

当前 A′ 在 macOS Apple Silicon 上必须全部通过。macOS Intel 与 Windows x64 的编译和真实凭据库验证由对应 CI / 真机完成后，才允许正式声称跨平台支持。

## 迁移契约

Rust 层已提供版本化的 `migration_inspect` 和 `migration_run` command。迁移始终读取旧工作区，绝不修改源 `projects/`；目标先写入 `.sion.migrating-<uuid>/`，完成后才重命名为 `.sion/`。

- 迁移节点、会话、附件、覆盖规则和既有导出；历史来源与 token 元数据保留。
- `webSearchEnabled`、浏览器设置及浏览器缓存不会进入新项目，报告会明确记录。
- 旧版单文件聊天会转为一个确定的 `legacy-import` 会话；节点的 `assumptions` / `openQuestions` 会并入 Markdown。
- 未恢复的 `.append-journal.json` 会使导入失败，避免静默丢失消息。
- 旧附件索引没有哈希字段，因此迁移器会对每个源文件和目标文件实际计算 SHA-256 对比，并校验索引中的字节数和文本 UTF-16 字符数。
