# @devdock/tray — menu-bar app (Tauri v2)

A tiny background agent that lives in the macOS menu bar (Windows/Linux tray). It
is a **thin client of the daemon** (`packages/daemon`): it polls `GET /repos`,
renders a glanceable status dot per repo, and pops the web UI (`packages/web`) in
your browser on click. No devspace/kubectl logic lives here — the daemon is the
one brain.

| Dot | Status            |
|-----|-------------------|
| 🟢  | `RUNNING_MANAGED` |
| 🟡  | `RUNNING_EXTERNAL`|
| 🔵  | `BUILDING`        |
| 🔴  | `CRASHED`         |
| ⚪️  | `STOPPED`         |

## Prerequisites

Building requires the **Rust toolchain** (`rustup`/`cargo`) and the platform
Tauri deps — it is not part of the TypeScript `pnpm -r build`. See
<https://v2.tauri.app/start/prerequisites/>.

## Run / build

```sh
pnpm --filter @devdock/tray dev        # tauri dev (live)
pnpm --filter @devdock/tray app:build  # tauri build (bundled app)
```

Config via env (read by the Rust app):

- `DEVDOCK_DAEMON` — daemon base URL (default `http://127.0.0.1:7717`)
- `DEVDOCK_WEB` — web UI URL to pop (default `http://127.0.0.1:5273`)

Icons in `src-tauri/icons/` are generated from a source PNG with
`pnpm --filter @devdock/tray tauri icon <source.png>`.
