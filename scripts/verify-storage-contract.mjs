import { readFile } from "node:fs/promises";

const files = [
  "src/App.tsx",
  "src/components/app/ProjectHome.tsx",
  "src/components/settings/SettingsDialog.tsx",
  "src/components/settings/ProviderEditorDialog.tsx",
  "src/components/workspace/ConversationPane.tsx",
  "src/components/workspace/ConversationModelMenu.tsx",
  "src/components/workspace/ConversationFileMenu.tsx",
  "src/components/workspace/FilePoolWorkspace.tsx",
  "src-tauri/src/lib.rs",
  "src-tauri/src/conversation_runtime.rs",
  "src-tauri/src/provider_settings.rs",
  "crates/sion-storage/src/lib.rs",
];
const forbidden = [
  ["project-level .sion", /\.sion\/(?:chat|files|nodes|runs)|写入 \.sion|项目.*\.sion/],
  ["credential store", /Keychain|Credential Manager|钥匙串|系统凭据库|keyring/i],
  ["old setting", /defaultProjectDirectory|default_project_directory/],
];
const failures = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const [label, pattern] of forbidden) {
    if (pattern.test(source)) failures.push(`${file}: ${label}`);
  }
}
if (failures.length) {
  throw new Error(`storage contract violations:\n${failures.join("\n")}`);
}
