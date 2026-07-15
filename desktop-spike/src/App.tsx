import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

const API_VERSION = 1;

type CheckState = "idle" | "running" | "passed" | "failed";

type VersionResponse = {
  apiVersion: number;
  appVersion: string;
  rustTarget: string;
};

type SpikeCheck = {
  label: string;
  detail: string;
};

function stateLabel(state: CheckState): string {
  if (state === "running") return "验证中";
  if (state === "passed") return "通过";
  if (state === "failed") return "失败";
  return "待验证";
}

export function App() {
  const [version, setVersion] = useState<VersionResponse | null>(null);
  const [versionError, setVersionError] = useState("");
  const [docx, setDocx] = useState<CheckState>("idle");
  const [keyring, setKeyring] = useState<CheckState>("idle");
  const [details, setDetails] = useState<Record<string, string>>({});

  useEffect(() => {
    void loadVersion();
  }, []);

  async function loadVersion() {
    setVersionError("");
    try {
      const response = await invoke<VersionResponse>("app_get_version", {
        request: { apiVersion: API_VERSION },
      });
      setVersion(response);
    } catch (error) {
      setVersionError(String(error));
    }
  }

  async function runCheck(command: "spike_docx_check" | "spike_keyring_check", key: "docx" | "keyring") {
    key === "docx" ? setDocx("running") : setKeyring("running");
    try {
      const result = await invoke<SpikeCheck>(command, {
        request: { apiVersion: API_VERSION },
      });
      setDetails((current) => ({ ...current, [key]: `${result.label} · ${result.detail}` }));
      key === "docx" ? setDocx("passed") : setKeyring("passed");
    } catch (error) {
      setDetails((current) => ({ ...current, [key]: String(error) }));
      key === "docx" ? setDocx("failed") : setKeyring("failed");
    }
  }

  const checks = [
    {
      id: "ipc",
      title: "版本化 IPC",
      eyebrow: "API CONTRACT / V1",
      state: version ? "passed" : versionError ? "failed" : "running",
      detail: version
        ? `Rust ${version.appVersion} · ${version.rustTarget}`
        : versionError || "正在连接 Rust 应用服务",
      action: loadVersion,
      actionLabel: "重新协商",
    },
    {
      id: "docx",
      title: "DOCX 最小往返",
      eyebrow: "DOCUMENT PIPELINE",
      state: docx,
      detail: details.docx || "生成中文文档、解包并检查 document.xml",
      action: () => runCheck("spike_docx_check", "docx"),
      actionLabel: "运行检查",
    },
    {
      id: "keyring",
      title: "系统凭据库",
      eyebrow: "SECRET BOUNDARY",
      state: keyring,
      detail: details.keyring || "写入、读取并删除一次临时凭据",
      action: () => runCheck("spike_keyring_check", "keyring"),
      actionLabel: "运行检查",
    },
  ] as const;

  return (
    <main className="spike-shell">
      <header className="masthead">
        <div>
          <p className="kicker">SION / DESKTOP FOUNDATION</p>
          <h1>可靠性<br /><em>不是假设。</em></h1>
        </div>
        <div className="run-mark" aria-label="A prime spike">A′<span>SPIKE</span></div>
      </header>

      <section className="thesis" aria-label="spike scope">
        <span className="index">01</span>
        <p>在替换现有运行时之前，先让最脆弱的边界自己说话。</p>
        <span className="rule" />
        <p className="muted">IPC · 密钥 · 文档 · 流式取消</p>
      </section>

      <section className="check-grid" aria-label="验证项目">
        {checks.map((check, index) => (
          <article className="check-card" key={check.id}>
            <div className="card-topline">
              <span>{String(index + 1).padStart(2, "0")}</span>
              <span className={`state state-${check.state}`}>{stateLabel(check.state)}</span>
            </div>
            <p className="card-eyebrow">{check.eyebrow}</p>
            <h2>{check.title}</h2>
            <p className="card-detail">{check.detail}</p>
            <button disabled={check.state === "running"} onClick={check.action} type="button">
              <span>{check.actionLabel}</span><b>↗</b>
            </button>
          </article>
        ))}
      </section>

      <footer>
        <span>NO NEXT SERVER · NO BROWSER AUTOMATION · NO COMPROMISE</span>
        <span>LOCAL BUILD / {version?.rustTarget ?? "NEGOTIATING"}</span>
      </footer>
    </main>
  );
}
