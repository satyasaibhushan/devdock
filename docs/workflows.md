# Workflows

Checkout metadata shows the selected machine's path, branch, short commit and
working-tree changes. It does not claim that a pod has received those changes.

The machine view lists all live terminals registered with that DevDock daemon,
including terminals opened through MCP. Repo views keep their workload filter.
Host shells and DevSpace shells have distinct labels. The dropdown beside `+`
exposes both options; right-click and Shift+F10 still work. Unrelated SSH/tmux
sessions outside DevDock are not part of this registry.

## Machine prerequisites

Each daemon reads `~/.devdock/workflow.json`, beside its state file. Different
machines keep different files. This file is owner-managed, never loaded from a
repo and never editable through HTTP/MCP. Existing auth gates still apply.

```json
{
  "prerequisites": [
    {
      "id": "docker",
      "label": "Container engine",
      "command": ["docker", "info", "--format", "{{.ServerVersion}}"],
      "actions": ["build", "build_start", "restart", "verify"],
      "timeoutMs": 10000
    },
    {
      "id": "environment",
      "label": "Repo environment file",
      "command": ["test", "-s", ".env"]
    }
  ],
  "verification": {
    "example-repo": {
      "url": "https://your-development-host.example/health",
      "status": 200,
      "contains": "healthy",
      "timeoutMs": 10000
    }
  }
}
```

Commands are executable-plus-arguments arrays, not interpolated shell strings.
They run in the selected workload's checkout, with `DEVDOCK_REPO`,
`DEVDOCK_WORKLOAD` and `DEVDOCK_NAMESPACE` environment variables. Use absolute
executable paths where the daemon's PATH differs from your interactive shell.
For machine-specific networking checks, point a command at the existing VPN
utility's non-interactive readiness check. The VPN utility owns its networking
logic; DevDock does not install, connect, repair or restart it. Commands must
be bounded, non-interactive checks, not repair or login scripts.

Exit zero means passed. Other exits mean failed, except 2, 126, 127 and execution
errors, which mean unknown. Timeouts also mean unknown. Both failed and unknown
block the operation. Raw command output is discarded and never exposed in the
UI, MCP or operation history. Do not embed credentials in commands.

Without an `actions` list a check applies to every action except destroy.
Without a file there are no custom checks; built-in auth checks still run.
Malformed configuration fails closed. Checks can be run explicitly from the UI
or `devdock_prerequisites`, and run before workflow actions. Direct deploy/dev
paths also check prerequisites. No check starts UAT or changes infrastructure
unless the owner explicitly configures a command that does so.

## Background operations

UI lifecycle actions and MCP lifecycle tools return an operation receipt rather
than holding a client connection open for the whole deployment. The original
synchronous HTTP routes remain compatible with older callers.

- `POST /repos/:repo/operations` accepts `action` and optional `workload`.
- `GET /operations?repo=...` lists recent and active receipts.
- `GET /operations/:id` returns status, checks and bounded activity history.
- MCP exposes `devdock_operation_start`, `devdock_operation_status` and
  `devdock_operations`. All support the existing explicit instance routing.

Stages are checking, deploying, starting, waiting, stopping and verifying.
The operation is active until its required steps complete. A successful deploy
alone does not claim that the app is ready. Dev operations wait up to 30 minutes
for a managed session with ready pods. The verify action deploys if stopped,
starts dev if deployed, or verifies an already-running managed workload. It
then makes a bounded GET to the configured endpoint. Both status and optional
response text must match. Redirects are rejected; response bodies are not logged.

Concurrent requests for the same action on an active workload return its existing
ID. Conflicting actions are rejected. Receipts, prerequisite results and stage
activity persist beside the state file, retaining 100 completed operations and
500 activity entries per operation. Existing application/container log tools
remain separate from this operation activity history.

On daemon restart, only starting/waiting/verifying operations with a verified
surviving dev session in their pinned namespace reconnect. Everything else is
marked interrupted, never automatically replayed. An interrupted deployment is
not assumed failed or rolled back; inspect it before explicitly starting again.
Stopping a dev session interrupts its waiting operation and preserves deployment.
It does not cancel an in-progress deploy or purge.

Live UAT deployment and verification are a separate final acceptance test.
