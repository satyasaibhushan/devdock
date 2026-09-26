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

`devdock.service` is the devbox's unit, with its rootless Docker socket and
allowlisted VPN proxy. On any other Linux machine, install from a checkout with
`install.sh` instead.

## Install on Linux

Prerequisites: Node (with `--use-env-proxy` when a proxy is set; the installer
checks), pnpm, git, curl, a systemd user session, and the tools DevDock drives
(`kubectl`, `devspace`, `aws`, `kubelogin`, Docker). Run once so the service
survives logout:

```sh
loginctl enable-linger
```

Get the source onto the machine. From a Mac checkout, sync it without build
output, which the installer regenerates:

```sh
rsync -az --exclude node_modules --exclude dist --exclude .turbo \
  --exclude '*.tsbuildinfo' ~/Code/Personal/devdock/ HOST:Code/Personal/devdock/
```

Then install from the checkout on that machine:

```sh
cd ~/Code/Personal/devdock
DEVDOCK_ROOTS=~/Code \
DEVDOCK_HTTPS_PROXY=http://127.0.0.1:18080 \
DEVDOCK_NO_PROXY=localhost,127.0.0.1,.amazonaws.com \
packages/daemon/systemd/install.sh
```

Omit the proxy variables when the machine reaches everything directly. Rerun the
same command after every sync or pull; each run builds a new release.

The installer:

1. Runs `pnpm install --frozen-lockfile`, builds core, daemon, MCP and web, and
   deploys production dependencies into a staging release. It then restores
   the checkout's dev dependencies, because pnpm 12's `deploy --prod` leaves it
   production-only.
2. Imports the staged modules with the target Node, then moves the release to
   `~/.local/share/devdock/releases/<time>-<commit>-<pid>`.
3. Writes `~/.config/systemd/user/devdock.service` from the environment, points
   `~/.local/share/devdock/current` at the release, and restarts the service.
4. Waits up to 10 seconds for `/health` on the socket. If the daemon does not
   come up, it restores the previous release and unit, or removes the unit on a
   first install, and exits non-zero.
5. Links `~/.local/bin/devdock-mcp` to the release's stdio MCP wrapper, which
   defaults `DEVDOCK_SOCKET` to the daemon socket.

Old releases are kept; delete them by hand when no longer needed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVDOCK_ROOTS` | `~/Code` | Checkout roots scanned for `.devspace` workloads |
| `DEVDOCK_HTTPS_PROXY` | `$HTTPS_PROXY` | Proxy for the daemon's HTTPS; set empty to disable |
| `DEVDOCK_NO_PROXY` | `$NO_PROXY`, else `localhost,127.0.0.1` | Hosts reached directly, written only with a proxy |
| `DEVDOCK_DOCKER_HOST` | `$DOCKER_HOST` | Docker socket, e.g. rootless |
| `DEVDOCK_PATH_PREFIX` | none | Extra `PATH` entries ahead of the defaults |
| `DEVDOCK_NODE_BIN`, `DEVDOCK_PNPM_BIN` | `node`, `pnpm` on `PATH` | Toolchain used to build and run |
| `DEVDOCK_INSTALL_ROOT` | `~/.local/share/devdock` | Releases, `current` and the `node` links |
| `DEVDOCK_UNIT_DEST` | `~/.config/systemd/user/devdock.service` | Unit path |
| `DEVDOCK_MCP_LINK` | `~/.local/bin/devdock-mcp` | MCP wrapper link |

The unit's `PATH` is `~/.local/bin`, the install's `bin`, then the system
directories. Put `kubectl`, `devspace`, `aws` and `kubelogin` in one of those
or add their directory with `DEVDOCK_PATH_PREFIX`.

After installing, link the machine from the Mac's instance selector (or
`devdock_instance_link`) through its SSH alias and sign in from the UI. The
link forwards the sign-in callback ports (8010, 8040) while a login is pending. Moving a deployment onto
it is covered in [linked instances](../../../docs/instances.md).

## Behind a proxy

Set the proxy only when some endpoints are unreachable directly. Each client
reads it differently:

- The daemon's own HTTPS (OIDC sign-in and refresh) uses `HTTPS_PROXY` only
  because the unit runs Node with `--use-env-proxy`. `install.sh` adds the flag
  when a proxy is set. A sign-in that fails with an HTML page instead of a token
  usually means a firewall answered; the daemon says so.
- AWS (STS, ECR, S3) often must stay direct: list `.amazonaws.com` in
  `NO_PROXY`.
- kubectl, kubelogin and devspace inherit the daemon's environment, so an EKS
  API host matches `.amazonaws.com` and goes direct. When the API is reachable
  only through the proxy, set it on the cluster in the kubeconfig:

  ```yaml
  clusters:
    - name: dev
      cluster:
        server: https://…eks.amazonaws.com
        proxy-url: http://127.0.0.1:18080
  ```

  `proxy-url` overrides the environment for that cluster only; the rest of AWS
  stays direct.

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
