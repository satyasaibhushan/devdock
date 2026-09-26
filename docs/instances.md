# Linked instances

Open the instance selector beside the DevDock title, then **Link machine**.
Enter an existing SSH alias and the daemon's private socket, for example
`devbox` and `/run/user/1000/devdock/control.sock`. Both daemons need this release.

The initiating daemon maintains one SSH connection with private Unix forwards
in both directions. The return connection lets devbox control the laptop without
an SSH server on the laptop. Each side sees the other in its instance selector
and MCP. The initiating daemon reconnects every 15 seconds while running.
Closing a browser does not close the link. An offline laptop remains offline,
its work is not silently moved elsewhere.

The header shows connected instances, with a symbol shared by their repo rows.
The sidebar is one global repository list, not a separate list per machine.
Deployment actions, logs and terminals follow each workload's ownership claim.
An offline owner stays visible and blocks actions until it is moved. Claims are
read without acquiring them for display.

The header lists connected machines without selecting a global workspace.
Each workload has a machine picker beside its name, listing machines with that
checkout. For unclaimed work it picks where new work runs; for claimed work,
picking another machine asks to move the deployment there (see below). Host terminals have
their own machine picker; replicas choose their target in the creation dialog.
Authentication and namespace controls identify the current action target or
deployment owner. The instance menu shows connection and auth status only.
Replica creation offers an explicit target selector. Branches and
worktrees come from that target's checkout. No repositories or `.env` files are
copied by linking. New replica IDs include an instance suffix to avoid collisions.

The terminal panel appears only while a dev session runs; otherwise the logs
take the whole pane.

`Stop session` is available while a managed dev session exists, including while
waiting for a pod in BUILDING. It stops that instance's tmux dev session and
automatic reconnection, keeping the deployment, pods and ownership claim.
It does not run purge, reset pods, deploy or rebuild. `Destroy` remains separate.

In a repo's terminal panel, click `+` for a DevSpace shell. Right-click `+`
for `Open DevSpace terminal` or `Open normal terminal`. The normal shell runs
in that repo's checkout on the same instance, not necessarily on the browser's
machine. Both appear as tabs. The menu also opens with Shift+F10.

## Authentication and authority

SSH uses the user's existing configuration with batch mode and host-key checking.
Linking never copies Google, AWS, Kubernetes or VPN tokens. Peer routing refuses
the AWS credential endpoint, recursive instance proxies and arbitrary paths.
The daemon identity is persisted in `~/.devdock/instance.json` and checked again
before each request, including after reconnects. Do not copy that file between
machines. Links are persisted in `~/.devdock/instances.json`.

Remote terminals are disabled by default. Enabling them grants the SSH account's
shell authority, including its ability to read its own files. This is an owner UI
feature, not a credential isolation mechanism. Never give a restricted agent the
owner daemon's control socket, control token, or owner SSH key. Keep its restricted
OS account and bridge. MCP's ro/rw tool selection is not an OS security boundary.

Interactive sign-in still happens on the machine owning the auth flow. The
directory reports it; linking does not transfer browser cookies or defeat expiry.
The browser usually runs on the initiating machine, so while a linked machine
waits on a sign-in, the initiating daemon forwards that sign-in's localhost
callback port (kubelogin 8040, AWS 8010) over SSH. The forward exists only while
the sign-in is pending, so the initiating machine's own sign-ins keep the ports
otherwise. A busy local port is retried every 10 seconds.

## Deployment ownership

Before a lifecycle action, DevDock atomically claims a ConfigMap named
`devdock-owner-<hash>` in the deployment's namespace. Its data contains only the
instance UUID and scoped deployment name. Kubernetes itself serializes creation;
two machines racing to claim the same deployment cannot both win. A failed
ownership read blocks the action. Existing managed sessions are claimed at boot.

Claims do not expire on disconnect, restart or unlink. A successful purge
releases the claim, since nothing of that workload runs any more.

Moving is explicit, from the workload's machine picker or the `devdock_move`
MCP tool. Both go through the initiating daemon: `GET /instances/move-plan`
previews it and `POST /instances/move` runs it.

- Owner online: the owner stops its dev session (pods keep running) and deletes
  its claim (`POST /repos/:id/release`). If a dev session was live, the target
  starts dev and claims it: plain start when both checkouts are at the same
  commit, build + start otherwise, since the running image came from the
  owner's code. Otherwise the target's next verb claims it. `followUp`
  overrides this.
- Owner unreachable: the target deletes the claim only while it still names that
  owner, then claims it (`POST /repos/:id/take-over`). When the old owner returns,
  its reconcile sees the claim names someone else, kills its tmux session and
  pauses reconnects. It leaves the DevSpace session lock alone, since the new
  owner's session holds it.

Neither path deletes a claim held by any other instance. This guard covers
DevDock, not arbitrary `devspace` commands in a shell.

The Kubernetes identity needs `get`, `create` and `delete` on ConfigMaps in its
namespace.
No cluster-wide objects or new identity providers are needed.

## MCP

`devdock_instances` lists all targets. Every existing tool accepts an optional
`instance` UUID. Omitting it means the machine hosting that MCP daemon. Link and
unlink tools are available only in rw mode. Remote commands are never replayed
automatically after a timeout; check status before retrying.

For a private local socket, set `DEVDOCK_SOCKET` for the MCP process. The existing
`DEVDOCK_DAEMON` TCP setting remains supported. Unknown or offline targets fail
instead of falling back to the local machine.
