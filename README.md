# Sion

Sion 是一款本地优先的项目设计文档桌面应用。它使用 Tauri 2、Rust 核心和 React/Vite 工作台，支持 macOS（Apple Silicon、Intel）与 Windows x64。

项目数据由用户选择的项目目录持有，所有新数据都位于 `<项目目录>/.sion/`。模型密钥只保存到操作系统的 Keychain / Credential Manager；新运行时没有网页搜索、浏览器自动化或 Playwright 依赖。

## 本地开发

```bash
npm install
npm run tauri dev
```

常用验证命令：

```bash
npm run lint
npm run build
npm run test:rust
npm run build:desktop
cargo test --workspace
cargo clippy --workspace -- -D warnings
```

`npm run bundle` 在当前平台生成安装包。macOS 最低版本为 11；Intel 和 Windows x64 由 GitHub Actions 的对应 runner 构建验证。

面向普通用户的安装包还需要平台代码签名；macOS 直链分发还需要 Apple 公证。开发包与正式发布包的差异、机密边界和验收步骤见[发布清单](RELEASE.md)。

## 数据迁移

首次打开时可从旧 Sion 工作区选择项目迁移。迁移读取旧 `projects/` 和 `settings/model-providers.json`，写入新的 `.sion/` 目录并以临时目录校验后原子提交。

- 迁移节点、聊天会话、附件、覆盖规则、导出，以及可用的历史元数据；
- 旧 API Key 迁移到系统凭据库，元数据中不写入明文密钥；
- 浏览器搜索配置、缓存和网页抓取状态不会迁移，也不会在新应用运行。

## 设计约束

- Agent 默认输出受校验的分节补丁；预览展示补丁应用后的完整节点，确认保存使用 revision/CAS 防止覆盖并发修改。
- Agent 同时最多运行两个任务；同一项目、同一节点只允许一个修改性任务。
- 支持 TXT、PDF、DOCX、XLSX 附件的本地提取与上下文选择；无法提取的附件不会伪装为可用文本。
- DOCX 导出通过系统保存面板写入用户选择的位置。
