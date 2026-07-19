# Sion Desktop Repository Notes

Sion is a local-first Tauri 2 desktop application: React/Vite provides the workbench UI and Rust owns all project state, model networking, file extraction, and export.

## Commands

```bash
npm run tauri dev
npm run lint
npm run build
npm run test:rust
npm run build:desktop
cargo test --workspace
cargo clippy --workspace -- -D warnings
```

The Tauri crate is `src-tauri/`; its independent `Cargo.toml` is deliberately excluded from the root Rust workspace. Rust domain crates live under `crates/`.

## Architecture

- `src/` — React/Vite workbench only. Use Tauri `invoke` for native actions; do not access the local filesystem or model network from the UI.
- `src-tauri/` — versioned Tauri command layer, native dialogs, app settings (project container), provider settings, bounded file preview, and DOCX export.
- `crates/sion-core` — pure workflow/domain types, default Markdown, agent rules, and validated `delivery` patch application.
- `crates/sion-storage` — direct UUID project-directory store, CAS node saves, sessions, attachments, and disk-first discovery.
- `crates/sion-agent` — provider SSE streaming, cancellation behavior, and run scheduling.
- `assets/agents/` — embedded Rust Agent rules for the 12 workflow nodes.

## Non-negotiable constraints

- New project data is written only to `<projects directory>/<project id>/`; writes must remain atomic and use CAS for node revisions.
- Global application configuration belongs only in `~/.sion/`. API keys are local plaintext in `~/.sion/providers.json`, must use restricted file permissions, and must never enter project data, exports, logs, or IPC summaries.
- The desktop runtime has no browser search, browser automation, Playwright, or web egress subsystem.
- Agent output is a fenced `delivery` JSON block. Default writes are scoped section patches and must be validated and previewed before save.
- Do not commit generated project data, exports, local `projects/`, `~/.sion/`, or `settings/` content.
- **Never commit or push `docs/` or `.github/` (including workflows).** These stay local only. Do not `git add` them, do not force-add them, and do not open PRs that include them. Plans/specs under `docs/superpowers/` and CI under `.github/workflows/` are machine-local working material.
