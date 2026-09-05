# Devbox runtime

The user service runs a private release from `~/.local/share/devdock/current`.
The `node` symlink beside it points to the installed Node executable; `bin/node`
points to the same executable for child processes.

`DEVDOCK_SOCKET` replaces the TCP listener. Its parent must be owned by the
daemon user and inaccessible to other accounts. The socket has mode `0600`.
systemd creates the private runtime directory and removes it when the service
stops. Do not expose the socket through an unauthenticated TCP proxy on a shared
host: the daemon includes local terminal and credential operations.

DevDock owns AWS login and refresh. Do not set `DEVDOCK_AWS_AUTH=external` when
using `aws-cli-oidc`: that helper caches AWS credentials but discards the refresh
token. Configure the `devspace` profile's `credential_process` to invoke the
installed `packages/daemon/dist/awsCred.js` using the installed Node executable,
with `DEVDOCK_SOCKET=/run/user/1000/devdock/control.sock` in its environment.
Use the actual daemon user's runtime directory on other machines.

The unit requires Node with `--use-env-proxy` support. Its browser helper records
the initial login URL; forward localhost port 8010 to the devbox for the human
sign-in. The refresh token lives in `~/.devdock/aws-oidc.json`, mode `0600`, under
the private daemon account's `0700` directory. Never grant agents that account's
shell or expose the credential socket. Renewal no longer depends on unlocking
the desktop keyring. Provider expiry and revocation still require sign-in.
Kubernetes authentication retains its separate kubeconfig and token cache.

The unit uses the devbox's rootless Docker socket and allowlisted VPN proxy.
Adjust those paths and `DEVDOCK_ROOTS` for another machine. Install the unit in
`~/.config/systemd/user/devdock.service` and enable it after building the release.

Inspect without printing credentials:

```sh
systemctl --user status devdock
curl --unix-socket "$XDG_RUNTIME_DIR/devdock/control.sock" http://localhost/health
journalctl --user -u devdock -f
```

Deployment output is available through DevDock's workload log stream, separate
from the daemon journal. The macOS daemon and clients remain unchanged.
# Linked instances and MCP

The instance selector links another daemon through an existing SSH alias. See
[linked instances](../../../docs/instances.md) for the protocol and ownership rules.
The portable release can include `packages/mcp` alongside `packages/daemon`.
Install the adjacent `devdock-mcp` wrapper into the owner's `~/.local/bin` to use
that MCP over the private control socket. Do not grant this owner socket or
wrapper to a restricted agent account.
