# devdock

A global control plane for [DevSpace](https://www.devspace.sh/) sessions — **start, kill, build, and attach** to dev pods across every repo on your machine, from one always-on daemon.

Built for two users sharing the same brain: a human at a menu bar, and an AI agent over MCP.

## The problem

Working with DevSpace means walking each repo by hand: `cd` in, run `devspace dev`, leave a terminal hostage to its foreground sync, repeat for every service — and remember to `devspace purge` when you're done (you don't). Idle syncs quietly eat your laptop.

devdock makes that a single pane of control. It's not a Kubernetes IDE and not a DevSpace replacement — it's a thin, opinionated orchestrator *over* the tools you already trust (`devspace`, `kubectl`, `tmux`), exposing them through one consistent surface.

## The verbs

| Action | Underlying command | Meaning |
| --- | --- | --- |
| **Start** | `devspace dev` | Build + deploy + file-sync + port-forward + in-pod dev terminal |
| **Build** | `devspace deploy` | Build & deploy the workload without entering dev mode |
| **Kill** | `devspace purge` | Tear the deployment down; free cluster *and* local sync resources |
| **Listen** | `tmux attach -r` / `kubectl logs -f` | Read-only view of the running process and its crashes |
| **Attach** | `tmux attach` / `kubectl exec -it` | Read-write terminal: run `python main.py`, poke around, restart |

## How it works

Three thin layers over `devspace` + `kubectl` + `tmux`:

- **Clients** — a menu-bar GUI + web view (you: glance + click), an MCP server (agent: call + read), and a CLI. All call the *same* core service layer.
- **Control daemon** — the only brain. Headless, always-on (launchd). Scans `~/Code/**/.devspace/*/devspace.yaml`, reconciles desired vs. actual cluster state, supervises subprocesses, brokers PTYs and log tails over websockets, watches for crashes, and persists state in SQLite.
- **Execution** — each `devspace dev` runs inside its own named `tmux` session (`devdock-<repo>`), so it survives daemon restarts and the daemon never blocks on it.

### Two key design decisions

- **tmux owns the process.** Launching `devspace dev` inside a named tmux session means dev mode outlives the daemon, gives read-only (`-r`) vs read-write attach for free, and feeds a web terminal via node-pty → xterm.js without ttyd.
- **State comes from the cluster.** devdock never trusts its own memory — on boot and on a timer it reconciles against live `kubectl` output, so it's crash-proof and can adopt pods it never started (`RUNNING`, `CRASHED`, `STOPPED`, managed vs. external).

### One brain, two doors

The core service layer has **zero transport knowledge**. The human GUI and the agent's MCP verbs are two doors into one room, so they never drift. The read-only vs read-write terminal distinction you want for yourself *is* the permission scope for the agent: a read-only token can observe and diagnose; a read-write token can restart and run.

## Stack

TypeScript end-to-end — Fastify (HTTP/WS), node-pty ↔ xterm.js for terminals, Tauri for the menu-bar tray, SQLite for state, and an MCP server for the agent.

## Status

Design spec. See [`devdock.html`](devdock.html) for the full architecture document.
