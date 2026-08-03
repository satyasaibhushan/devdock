import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const installScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'launchd', 'install.sh')

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function executable(path: string, contents: string): void {
  writeFileSync(path, contents)
  chmodSync(path, 0o755)
}

describe('launchd installer', () => {
  it('installs a release that survives deletion of checkout dependencies and build output', () => {
    const root = mkdtempSync(join(tmpdir(), 'devdock-install-'))
    dirs.push(root)
    const home = join(root, 'home')
    const repo = join(root, 'repo')
    const bin = join(root, 'bin')
    const installRoot = join(home, '.local', 'share', 'devdock')
    const plist = join(home, 'Library', 'LaunchAgents', 'com.devdock.daemon.plist')
    const log = join(root, 'commands.log')
    mkdirSync(join(repo, 'packages', 'web'), { recursive: true })
    mkdirSync(bin, { recursive: true })

    executable(
      join(bin, 'pnpm'),
      `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\\n' "$*" >> "$DEVDOCK_TEST_LOG"
if [[ " $* " == *" @devdock/web "* ]]; then
  mkdir -p "$DEVDOCK_REPO_ROOT/packages/web/dist"
  printf '<html>devdock</html>\\n' > "$DEVDOCK_REPO_ROOT/packages/web/dist/index.html"
fi
if [[ " $* " == *" deploy "* ]]; then
  target="${'${@: -1}'}"
  mkdir -p "$target/dist" "$target/node_modules/@devdock/core/dist"
  printf 'export {}\\n' > "$target/dist/index.js"
  printf 'export {}\\n' > "$target/dist/routes.js"
  printf 'export {}\\n' > "$target/node_modules/@devdock/core/dist/index.js"
fi
`,
    )
    executable(join(bin, 'node'), '#!/usr/bin/env bash\nexit 0\n')
    executable(
      join(bin, 'launchctl'),
      `#!/usr/bin/env bash
printf 'launchctl %s\\n' "$*" >> "$DEVDOCK_TEST_LOG"
state_file="$DEVDOCK_TEST_LOG.state"
count_file="$DEVDOCK_TEST_LOG.count"
case "${'$'}{1:-}" in
  bootout)
    printf 'stopping\\n' > "$state_file"
    printf '0\\n' > "$count_file"
    ;;
  bootstrap)
    if [[ -f "$state_file" ]] && grep -q stopping "$state_file"; then exit 5; fi
    printf 'running\\n' > "$state_file"
    ;;
  print)
    if [[ ! -f "$state_file" ]]; then exit 1; fi
    if grep -q stopping "$state_file"; then
      count="$(cat "$count_file")"
      if ((count < 1)); then
        printf '%s\\n' "$((count + 1))" > "$count_file"
        printf 'state = stopping\\n'
        exit 0
      fi
      rm -f "$state_file" "$count_file"
      exit 1
    fi
    printf 'state = running\\n'
    ;;
esac
`,
    )
    executable(join(bin, 'curl'), '#!/usr/bin/env bash\nexit 0\n')

    execFileSync('/bin/bash', [installScript], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        DEVDOCK_REPO_ROOT: repo,
        DEVDOCK_INSTALL_ROOT: installRoot,
        DEVDOCK_PLIST_DEST: plist,
        DEVDOCK_TEST_LOG: log,
      },
      stdio: 'pipe',
    })

    const installedPlist = readFileSync(plist, 'utf8')
    const daemonPath = [...installedPlist.matchAll(/<string>([^<]+\/dist\/index\.js)<\/string>/g)]
      .map((match) => match[1])
      .find((path) => path?.includes('/releases/'))
    expect(daemonPath).toBeDefined()
    expect(daemonPath).toContain(installRoot)
    expect(existsSync(daemonPath as string)).toBe(true)

    rmSync(join(repo, 'node_modules'), { recursive: true, force: true })
    rmSync(join(repo, 'packages', 'core', 'dist'), { recursive: true, force: true })
    rmSync(join(repo, 'packages', 'daemon', 'dist'), { recursive: true, force: true })
    expect(existsSync(daemonPath as string)).toBe(true)

    const calls = readFileSync(log, 'utf8')
    expect(calls).toContain('pnpm --filter @devdock/daemon deploy --prod --legacy')
    expect(calls).toContain('launchctl bootstrap')
  })
})
