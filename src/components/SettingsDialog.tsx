import type { SettingsDialogProps } from "../types";

// Renders the saved projects directory and the native-dialog actions. The
// directory is only ever displayed here; React never creates or writes it.
// `onPickDirectory`/`onClearDirectory` are wired to the settings commands.
export function SettingsDialog({ settings, onPickDirectory, onClearDirectory, onClose }: SettingsDialogProps) {
  return (
    <section className="settings-dialog" role="dialog" aria-modal="true" aria-label="项目目录设置">
      <div className="settings-card">
        <div className="settings-head">
          <div>
            <p className="panel-kicker">项目目录</p>
            <h2>用于存放本地项目的目录</h2>
            <span>Sion 会在此目录自动创建并发现多个项目，无需每次选择。可以随时清除。</span>
          </div>
          <button onClick={onClose} type="button" aria-label="关闭设置">×</button>
        </div>
        <p className="settings-directory">
          {settings.projectsDirectory
            ? `当前项目目录：${settings.projectsDirectory}`
            : "未设置项目目录；请先选择一个目录。"}
        </p>
        <div className="settings-actions">
          <button className="settings-pick" onClick={onPickDirectory} type="button">更改目录</button>
          <button className="settings-clear" onClick={onClearDirectory} type="button">不设项目目录</button>
          <button className="settings-close" onClick={onClose} type="button">关闭</button>
        </div>
      </div>
    </section>
  );
}
