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
An offline owner stays visible and blocks actions; selecting another instance
does not transfer ownership. Claims are read without acquiring them for display.

The selected header instance controls host terminals, authentication, namespace
selection and the default destination for new work. Its namespace scopes the
global view when the same repo is available in different namespaces. The instance
menu shows connection and auth status only, never a second deployment list.
Replica creation offers an explicit target selector. Branches and
worktrees come from that target's checkout. No repositories or `.env` files are
copied by linking. New replica IDs include an instance suffix to avoid collisions.

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

## Deployment ownership

Before a lifecycle action, DevDock atomically claims a ConfigMap named
`devdock-owner-<hash>` in the deployment's namespace. Its data contains only the
instance UUID and scoped deployment name. Kubernetes itself serializes creation;
two machines racing to claim the same deployment cannot both win. A failed
ownership read blocks the action. Existing managed sessions are claimed at boot.

Claims do not expire, including after disconnect, restart, purge or unlink.
Operate through the owner instance. Moving ownership is deliberately not automatic.
An operator must stop the old controller and explicitly remove its claim before
another instance can claim it. Do not remove claims while an old controller can
still run. This guard covers DevDock, not arbitrary `devspace` commands in a shell.
Both machines must run a guarded release before relying on the guarantee.

The Kubernetes identity needs `get` and `create` on ConfigMaps in its namespace.
No cluster-wide objects or new identity providers are needed.

## MCP

`devdock_instances` lists all targets. Every existing tool accepts an optional
`instance` UUID. Omitting it means the machine hosting that MCP daemon. Link and
unlink tools are available only in rw mode. Remote commands are never replayed
automatically after a timeout; check status before retrying.

For a private local socket, set `DEVDOCK_SOCKET` for the MCP process. The existing
`DEVDOCK_DAEMON` TCP setting remains supported. Unknown or offline targets fail
instead of falling back to the local machine.
