# Sion 发布清单

本文区分“开发验证包”和“可面向普通用户分发的正式包”。证书、私钥、App
专用密码和 PFX 文件均不得提交到仓库、构建日志或项目数据中。

## 版本与产物

应用版本以以下文件保持一致（semver，例如 `1.0.0`）：

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- 根 `Cargo.toml` 的 `[workspace.package].version`（工作区 crate 通过
  `version.workspace = true` 继承）

对应 Git tag 为 `v1.0.0`。

未签名开发验证包产物：

| 平台 | 产物 | 构建方式 |
| --- | --- | --- |
| macOS Universal | `Sion_<version>_universal.dmg` | CI `macos-latest` 或 `npm run bundle:mac-universal` |
| Windows x64 | NSIS `.exe` | CI `windows-latest`（`--bundles nsis`）或本机 `npm run bundle:windows` |

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
npm run test:no-legacy-migration-runtime
npm run test:storage-contract
```

## CI 自动发布（推荐）

`.github/workflows/release.yml` 在推送 `v*` tag 时：

1. 在 `macos-latest` 构建 Universal DMG（Apple Silicon + Intel）；
2. 在 `windows-latest` 构建 NSIS 安装器；
3. 使用 `tauri-apps/tauri-action` 创建/更新同名 GitHub Release，并上传安装包。

发布步骤：

```bash
# 1. 确认版本号已改为目标 semver，且工作树干净
# 2. 合并到 main 并推送
git push origin main

# 3. 打 tag 并推送（触发 Release workflow）
git tag v1.0.0
git push origin v1.0.0

# 4. 在 GitHub Actions 中确认 Release 任务成功，并检查
#    https://github.com/ChesionSoft/Sion/releases
```

也可在 Actions 页对 `Release` 工作流执行 `workflow_dispatch`，并填入已有 tag
（例如 `v1.0.0`）以重建产物。

当前 workflow **不注入** Apple / Windows 签名机密，产出为未签名开发验证包：

- macOS：首次打开可能被 Gatekeeper 拦截，可用右键 → 打开；
- Windows：浏览器下载可能触发 SmartScreen，可在“更多信息”中选择仍要运行。

不要把未签名包表述为已公证或已代码签名的正式分发包。

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
`APPLE_CERTIFICATE_PASSWORD` 和临时钥匙串密码；还需要上述公证凭据。正式签名
发布工作流应与未签名验证流分离，且只在受保护的 tag 或 environment 上运行。

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

每个平台都验证：首次选择一次项目目录，连续创建两个项目且不再次弹出目录选择器；两个项目分别写入 `<项目目录>/<项目 ID>/`。
确认目录内不存在 `.sion/` 子目录；模型配置只写入 `~/.sion/providers.json`，权限受限，API Key 不出现在项目树、导出物、日志或 IPC 列表响应中。
