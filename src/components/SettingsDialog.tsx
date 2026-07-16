import type { SettingsDialogProps } from "../types";

// Renders the saved default project directory and the native-dialog actions.
// The directory is only ever displayed here; React never creates or writes it.
// Task 6 wires `onPickDirectory`/`onClearDirectory` to the settings commands.
export function SettingsDialog({ settings, onPickDirectory, onClearDirectory, onClose }: SettingsDialogProps) {
  return (
    <section className="settings-dialog" role="dialog" aria-modal="true" aria-label="默认项目目录设置">
      <div className="settings-card">
        <div className="settings-head">
          <div>
            <p className="panel-kicker">默认项目目录</p>
            <h2>新建项目时的起始目录</h2>
            <span>设置后，创建项目时的目录选择器会从这里打开。可以随时清除。</span>
          </div>
          <button onClick={onClose} type="button" aria-label="关闭设置">×</button>
        </div>
        <p className="settings-directory">
          {settings.defaultProjectDirectory
            ? `当前默认目录：${settings.defaultProjectDirectory}`
            : "未设置默认目录；创建项目时将使用系统默认位置。"}
        </p>
        <div className="settings-actions">
          <button className="settings-pick" onClick={onPickDirectory} type="button">更改目录</button>
          <button className="settings-clear" onClick={onClearDirectory} type="button">不设默认目录</button>
          <button className="settings-close" onClick={onClose} type="button">关闭</button>
        </div>
      </div>
    </section>
  );
}
