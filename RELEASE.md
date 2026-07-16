# Sion 发布清单

本文区分“开发验证包”和“可面向普通用户分发的正式包”。证书、私钥、App
专用密码和 PFX 文件均不得提交到仓库、构建日志或项目的 `.sion/` 目录。

## 发布前验证

在发布分支的干净工作树中执行：

```bash
npm ci
npm run lint
npm run build
cargo test --workspace
cargo clippy --workspace -- -D warnings
npm run test:rust
npm run test:no-browser-runtime
node fixtures/validate-fixtures.mjs
```

随后在 macOS Apple Silicon runner 构建通用包，并在 Windows runner 构建两个
安装器。`.github/workflows/desktop.yml` 上传的产物应包括：

- Universal macOS DMG（Apple Silicon 与 Intel）；
- Intel macOS DMG；
- Windows NSIS `.exe` 与 WiX `.msi`。

## macOS 正式分发

DMG 直链分发需要 `Developer ID Application` 证书和 Apple 公证；仅使用免费
Apple Developer 账户不能公证。先在构建机钥匙串中安装证书，并确认它可用：

```bash
security find-identity -v -p codesigning
```

将该输出中的完整签名身份设置为 `APPLE_SIGNING_IDENTITY`。公证可使用 Apple ID
方案：`APPLE_ID`、应用专用密码 `APPLE_PASSWORD`、以及 `APPLE_TEAM_ID`；或者使用
App Store Connect API 凭据。不得把这些值写入 shell 历史、仓库或 CI 输出。

然后构建并验证：

```bash
npm run bundle:mac-universal
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
codesign --verify --deep --strict --verbose=2 \
  src-tauri/target/universal-apple-darwin/release/bundle/macos/Sion.app
hdiutil verify \
  "src-tauri/target/universal-apple-darwin/release/bundle/dmg/Sion_${VERSION}_universal.dmg"
```

若改为 CI 签名，使用 GitHub Secrets 注入 `APPLE_CERTIFICATE`（base64 `.p12`）、
`APPLE_CERTIFICATE_PASSWORD` 和临时钥匙串密码；还需要上述公证凭据。当前
`desktop.yml` 是不接触机密的构建验证工作流，正式发布工作流应与它分离，且只在
受保护的 tag 或环境上运行。

没有 Apple 证书时可以生成开发验证 DMG，但它不等同于正式分发包；不要将 ad-hoc
签名当成公证替代品。

## Windows 正式分发

Windows 产物由 `npm run bundle:windows` 在 Windows runner 上生成，包括 NSIS 和
MSI。未签名的安装器可以运行，但通过浏览器下载时会触发 SmartScreen 提示。

正式分发前选择以下一种由团队持有的签名方案：

- 组织/扩展验证代码签名证书，并在 Windows 构建机或短期 CI 证书存储中导入；
- Azure Key Vault / Azure Artifact Signing，并通过 Tauri 的 `bundle.windows.signCommand`
  调用受管签名工具；
- Microsoft Store 分发，并按 Store 流程签名和提交。

证书指纹、时间戳 URL 或 `signCommand` 属于发布环境配置；在获得实际签名方案前，
不要填入虚构值。CI 中的 PFX、密码和 Azure 凭据只能通过受保护的 Secrets 传入，
构建结束后应销毁临时证书文件。

## 最终验收

每个平台都在未安装开发环境的测试账户上执行：安装、首次启动、创建项目、迁移一份
旧项目、配置一个测试模型提供商、导入附件、运行一次 Agent、导出 DOCX。确认新数据
仅写入 `<项目目录>/.sion/`，且凭据未出现在项目树、导出物或日志中。
