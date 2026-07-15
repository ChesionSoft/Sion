# Sion Desktop A′ Spike

这是桌面重构前的隔离验证工程。它与现有 Next.js 代码并存，但不引用、启动或打包任何旧运行时代码；A′ 全部通过后，才允许 `codex/desktop-rust` 覆盖仓库根目录。

它验证四个不能靠设计文档保证的边界：

- Tauri React UI 与 Rust command 的版本化 IPC；
- OpenAI-compatible Chat Completions 与 Responses 的本地 SSE 流及取消；
- 中文 DOCX 的生成、ZIP 解包和基础结构检查；
- 系统凭据库的写入、读取和清理。

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
