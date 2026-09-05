# Devbox runtime

The user service runs a private release from `~/.local/share/devdock/current`.
The `node` symlink beside it points to the installed Node executable; `bin/node`
points to the same executable for child processes.

`DEVDOCK_SOCKET` replaces the TCP listener. Its parent must be owned by the
daemon user and inaccessible to other accounts. The socket has mode `0600`.
systemd creates the private runtime directory and removes it when the service
stops. Do not expose the socket through an unauthenticated TCP proxy on a shared
host: the daemon includes local terminal and credential operations.

`DEVDOCK_AWS_AUTH=external` keeps the existing AWS profile and its credential
provider responsible for login. Without it, DevDock owns AWS login as before.
Kubernetes authentication still uses the existing kubeconfig and token cache.

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
