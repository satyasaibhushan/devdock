import { describe, expect, it, vi } from 'vitest'
import { type RunResult, loginShell, loginShellArgs } from './exec.js'
import { sessionName } from './registry.js'
import { Supervisor, devspaceArgs, devspaceCommand, shellQuote, verbLabel } from './supervisor.js'
import type { Repo } from './types.js'

const repo: Repo = {
  id: 'svc-a',
  name: 'svc-a',
  path: '/home/me/Code/svc a',
  configPath: '/home/me/Code/svc a/devspace.yaml',
  ports: [],
  session: sessionName('svc-a'),
}

/** A multi-service repo driven by a `./devspace` wrapper at its root. */
const wrapped: Repo = {
  ...repo,
  id: 'agents-api',
  name: 'agents-api',
  path: '/home/me/Code/agents/.devspace/agents-api',
  root: '/home/me/Code/agents',
  configPath: '/home/me/Code/agents/.devspace/agents-api/devspace.yaml',
  session: sessionName('agents-api'),
}

function ok(stdout = ''): RunResult {
  return { code: 0, stdout, stderr: '' }
}

describe('Supervisor', () => {
  it('starts devspace dev inside a named tmux session, via a login shell', async () => {
    const runner = vi.fn(async () => ok())
    await new Supervisor(runner).start(repo)
    expect(runner).toHaveBeenCalledWith('tmux', [
      'new-session',
      '-d',
      '-s',
      'devdock-svc-a',
      `${loginShell} ${loginShellArgs} ${shellQuote("cd '/home/me/Code/svc a' && devspace dev")}`,
    ])
  })

  it('start mirrors the pane to a file when given one', async () => {
    const runner = vi.fn(async () => ok())
    await new Supervisor(runner).start(repo, '/tmp/svc-a.dev.log')
    // pane-targeting commands need the `=name:` exact form, not bare `=name`. No
    // `-o`: that flag toggles the pipe, so pipe() guards on pane_pipe instead.
    expect(runner).toHaveBeenCalledWith('tmux', [
      'pipe-pane',
      '-t',
      '=devdock-svc-a:',
      "cat >> '/tmp/svc-a.dev.log'",
    ])
  })

  it('pipe is a no-op when the pane is already piped (avoids toggling it off)', async () => {
    const runner = vi.fn(async (_c: string, args: string[]) =>
      args[0] === 'display-message' ? ok('1') : ok(),
    )
    await new Supervisor(runner).pipe(repo, '/tmp/svc-a.dev.log')
    expect(runner).toHaveBeenCalledWith('tmux', [
      'display-message',
      '-p',
      '-t',
      '=devdock-svc-a:',
      '#{pane_pipe}',
    ])
    expect(runner).not.toHaveBeenCalledWith('tmux', expect.arrayContaining(['pipe-pane']))
  })

  it('start keeps the pane alive so a died dev session is visible, not gone', async () => {
    const runner = vi.fn(async () => ok())
    await new Supervisor(runner).start(repo)
    expect(runner).toHaveBeenCalledWith('tmux', [
      'set-option',
      '-w',
      '-t',
      '=devdock-svc-a:',
      'remain-on-exit',
      'on',
    ])
  })

  it('start turns on mouse mode so a wheel scrolls tmux history instead of leaking arrow keys', async () => {
    const runner = vi.fn(async () => ok())
    await new Supervisor(runner).start(repo)
    // option commands need the `=name:` target form, like pipe-pane (bare
    // `=name` is rejected with "no such session" on tmux 3.6b).
    expect(runner).toHaveBeenCalledWith('tmux', [
      'set-option',
      '-t',
      '=devdock-svc-a:',
      'mouse',
      'on',
    ])
  })

  it('does not pipe when the session failed to start', async () => {
    const runner = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'duplicate session' }))
    await new Supervisor(runner).start(repo, '/tmp/svc-a.dev.log')
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('build streams deploy output through the stream runner, via a login shell', async () => {
    const streamRunner = vi.fn(
      async (_c: string, _a: string[], _o: { cwd?: string }, onLine: (l: string) => void) => {
        onLine('deploying chart…')
        return ok()
      },
    )
    const lines: string[] = []
    await new Supervisor(undefined, streamRunner).build(repo, (l) => lines.push(l))
    expect(streamRunner).toHaveBeenCalledWith(
      loginShell,
      [loginShellArgs, devspaceCommand(repo, 'deploy')],
      {},
      expect.any(Function),
    )
    expect(lines).toEqual(['deploying chart…'])
  })

  it('kill purges (via a login shell) then kills the session', async () => {
    const calls: { cmd: string; args: string[] }[] = []
    const runner = vi.fn(async (cmd: string, args: string[]) => {
      calls.push({ cmd, args })
      return ok()
    })
    await new Supervisor(runner).kill(repo)
    expect(calls[0]).toEqual({
      cmd: loginShell,
      args: [loginShellArgs, devspaceCommand(repo, 'purge')],
    })
    expect(calls[1]).toEqual({ cmd: 'tmux', args: ['kill-session', '-t', '=devdock-svc-a'] })
  })

  it('clear kills the session, releases the lock, and runs reset pods (not purge)', async () => {
    const calls: { cmd: string; args: string[] }[] = []
    const nsRepo: Repo = { ...repo, name: 'svc-a', namespace: 'panels' }
    const runner = vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
      calls.push({ cmd, args })
      if (cmd === 'kubectl' && args.includes('get')) {
        return ok(JSON.stringify({ data: { 'svc-a': 'server: http://localhost:8091\nrunID: x' } }))
      }
      return ok()
    })
    await new Supervisor(runner).clear(nsRepo)
    expect(calls[0]).toEqual({ cmd: 'tmux', args: ['kill-session', '-t', '=devdock-svc-a'] })
    expect(calls.some((c) => c.cmd === 'kubectl' && c.args.includes('patch'))).toBe(true)
    expect(calls).toContainEqual({
      cmd: loginShell,
      args: [loginShellArgs, devspaceCommand(nsRepo, 'reset pods')],
    })
    expect(calls.some((c) => c.args.includes(devspaceCommand(nsRepo, 'purge')))).toBe(false)
  })

  it('exec sends a command into the dev session', async () => {
    const runner = vi.fn(async () => ok())
    await new Supervisor(runner).exec(repo, 'pnpm test')
    expect(runner).toHaveBeenCalledWith('tmux', [
      'send-keys',
      '-t',
      '=devdock-svc-a:',
      'pnpm test',
      'Enter',
    ])
  })

  it('hasSession matches the session name exactly, not by prefix', async () => {
    // tmux -t prefix-matching made `devdock-dashboard` claim
    // `devdock-dashboard-api-accounts`; `=` forces the exact name.
    const runner = vi.fn(async () => ok())
    await new Supervisor(runner).hasSession(repo)
    expect(runner).toHaveBeenCalledWith('tmux', ['has-session', '-t', '=devdock-svc-a'])
  })

  it('lists only devdock- sessions', async () => {
    const runner = vi.fn(async () => ok('devdock-svc-a\nother\ndevdock-svc-b\n'))
    expect(await new Supervisor(runner).listSessions()).toEqual(['devdock-svc-a', 'devdock-svc-b'])
  })

  it('sessionStates maps devdock sessions to whether their pane has died', async () => {
    const runner = vi.fn(async () =>
      ok('devdock-svc-a 0 100\nother 1 101\ndevdock-svc-b 1 102\ndevdock-svc-a 0 100\n'),
    )
    const states = await new Supervisor(runner).sessionStates()
    expect(runner).toHaveBeenCalledWith('tmux', [
      'list-panes',
      '-a',
      '-F',
      '#{session_name} #{pane_dead} #{session_created}',
    ])
    expect(states.get('devdock-svc-a')).toEqual({ dead: false, createdAt: 100000 })
    expect(states.get('devdock-svc-b')).toEqual({ dead: true, createdAt: 102000 })
    expect(states.has('other')).toBe(false) // non-devdock sessions ignored
  })

  it('retires a stale session without resetting pods or purging', async () => {
    const calls: { cmd: string; args: string[] }[] = []
    const nsRepo: Repo = { ...repo, namespace: 'panels' }
    const runner = vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
      calls.push({ cmd, args })
      if (cmd === 'kubectl' && args.includes('get')) {
        return ok(JSON.stringify({ data: { 'svc-a': 'server: http://localhost:8091\nrunID: x' } }))
      }
      return ok()
    })
    await new Supervisor(runner).retireSession(nsRepo)
    expect(calls[0]).toEqual({ cmd: 'tmux', args: ['kill-session', '-t', '=devdock-svc-a'] })
    expect(calls.some((c) => c.cmd === 'kubectl' && c.args.includes('patch'))).toBe(true)
    expect(calls.some((c) => c.args.includes(devspaceCommand(nsRepo, 'reset pods')))).toBe(false)
    expect(calls.some((c) => c.args.includes(devspaceCommand(nsRepo, 'purge')))).toBe(false)
  })

  describe('externalDevPids / stopExternalDev (move here)', () => {
    // The lock lives in the `devspace-dependencies` ConfigMap: one key per
    // project (repo.name), value `server: http://localhost:<port>` + a runID.
    // The owning process is whatever listens on that port; a stale lock has no
    // listener. `lockRunner` simulates the ConfigMap + lsof port lookup + kill.
    function lockRunner(opts: {
      port?: number
      listeners?: Record<number, number>
      alive?: Set<number>
    }) {
      const { port, listeners = {}, alive = new Set<number>() } = opts
      return vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
        if (cmd === 'kubectl') {
          const data: Record<string, string> = {}
          if (port !== undefined) data[repo.name] = `server: http://localhost:${port}\nrunID: abc`
          return ok(JSON.stringify({ data }))
        }
        if (cmd === 'lsof') {
          // Lock path: `-iTCP:<port> -sTCP:LISTEN` → the listening pid (if any).
          const tcp = args.find((a) => a.startsWith('-iTCP:'))
          const p = tcp ? Number(tcp.slice('-iTCP:'.length)) : Number.NaN
          const pid = listeners[p]
          return pid ? ok(`p${pid}\n`) : { code: 1, stdout: '', stderr: '' }
        }
        if (cmd === 'kill') {
          const pid = Number(args[1])
          if (args[0] === '-0') return alive.has(pid) ? ok() : { code: 1, stdout: '', stderr: '' }
          return ok() // -TERM / -KILL
        }
        return ok()
      })
    }

    it('resolves the lock owner port to its listening PID', async () => {
      const runner = lockRunner({ port: 8091, listeners: { 8091: 111 } })
      expect(await new Supervisor(runner).externalDevPids(repo)).toEqual([111])
    })

    it('treats a lock with no listener as stale (no pid to take over)', async () => {
      const runner = lockRunner({ port: 8091, listeners: {} })
      expect(await new Supervisor(runner).externalDevPids(repo)).toEqual([])
    })

    it('returns no pid when the project has no lock entry', async () => {
      const runner = lockRunner({ port: undefined }) // ConfigMap present, key absent
      expect(await new Supervisor(runner).externalDevPids(repo)).toEqual([])
    })

    it('SIGTERMs the lock owner and reports it, leaving deployments alone', async () => {
      const runner = lockRunner({ port: 8091, listeners: { 8091: 111 } })
      const { pids } = await new Supervisor(runner).stopExternalDev(repo)
      expect(pids).toEqual([111])
      expect(runner).toHaveBeenCalledWith('kill', ['-TERM', '111'])
      // Never purges/deploys: no login-shell devspace command is issued.
      expect(runner).not.toHaveBeenCalledWith(loginShell, expect.anything())
    })

    it('escalates to SIGKILL only when the owner lingers after SIGTERM', async () => {
      const runner = lockRunner({ port: 8091, listeners: { 8091: 111 }, alive: new Set([111]) })
      await new Supervisor(runner).stopExternalDev(repo, undefined, { tries: 2, intervalMs: 1 })
      expect(runner).toHaveBeenCalledWith('kill', ['-KILL', '111'])
    })

    it('signals nothing when the lock is already free (stale)', async () => {
      const runner = lockRunner({ port: 8091, listeners: {} })
      const { pids } = await new Supervisor(runner).stopExternalDev(repo)
      expect(pids).toEqual([])
      expect(runner).not.toHaveBeenCalledWith('kill', expect.arrayContaining(['-TERM']))
    })

    // When the ConfigMap can't be read (no namespace/RBAC/kubectl), fall back to
    // matching the `devspace dev` process by its service-dir cwd.
    const psOut = [
      '111 /usr/local/bin/devspace dev -n panels',
      '222 /usr/local/bin/devspace deploy -n panels',
      '333 /usr/local/bin/devspace enter -n panels',
      '444 /opt/devspace dev -n other',
    ].join('\n')

    function fallbackRunner(cwds: Record<number, string>, psListing = psOut) {
      return vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
        if (cmd === 'kubectl') return { code: 1, stdout: '', stderr: 'forbidden' }
        if (cmd === 'ps') return ok(psListing)
        if (cmd === 'lsof') {
          const pid = Number(args[args.indexOf('-p') + 1])
          const cwd = cwds[pid]
          return cwd ? ok(`p${pid}\nfcwd\nn${cwd}\n`) : { code: 1, stdout: '', stderr: '' }
        }
        return ok()
      })
    }

    it('falls back to a cwd process scan when the lock ConfigMap is unreadable', async () => {
      const runner = fallbackRunner({ 111: repo.path, 444: '/somewhere/else' })
      expect(await new Supervisor(runner).externalDevPids(repo)).toEqual([111])
    })

    it('fallback disambiguates one-config workloads by WORKLOAD_TYPE', async () => {
      const ps = [
        '111 devspace dev --var WORKLOAD_TYPE=api -n panels',
        '222 devspace dev --var WORKLOAD_TYPE=worker -n panels',
      ].join('\n')
      const worker: Repo = { ...repo, varDefaults: { WORKLOAD_TYPE: 'worker' } }
      const runner = fallbackRunner({ 111: repo.path, 222: repo.path }, ps)
      expect(await new Supervisor(runner).externalDevPids(worker)).toEqual([222])
    })
  })

  describe('non-interactive args (question vars + namespace)', () => {
    const prompty: Repo = {
      ...repo,
      namespace: 'panels',
      varDefaults: { WORKLOAD_TYPE: 'api', TARGET_REGION: 'us' },
    }

    it('answers question vars with their defaults and pins the namespace', () => {
      expect(devspaceArgs(prompty)).toEqual([
        '--var',
        'WORKLOAD_TYPE=api',
        '--var',
        'TARGET_REGION=us',
        '-n',
        'panels',
      ])
      expect(devspaceArgs(repo)).toEqual([])
    })

    it('build and kill route the answered command through a login shell', async () => {
      const runner = vi.fn(async () => ok())
      const sup = new Supervisor(runner)
      await sup.build(prompty)
      expect(runner).toHaveBeenCalledWith(loginShell, [
        loginShellArgs,
        devspaceCommand(prompty, 'deploy'),
      ])
      await sup.kill(prompty)
      expect(runner).toHaveBeenCalledWith(loginShell, [
        loginShellArgs,
        devspaceCommand(prompty, 'purge'),
      ])
    })

    it('start embeds the answered command in the tmux login-shell call', async () => {
      const runner = vi.fn(async () => ok())
      await new Supervisor(runner).start(prompty)
      expect(runner).toHaveBeenCalledWith('tmux', [
        'new-session',
        '-d',
        '-s',
        'devdock-svc-a',
        `${loginShell} ${loginShellArgs} ${shellQuote(devspaceCommand(prompty, 'dev'))}`,
      ])
    })
  })
})

describe('devspaceCommand', () => {
  it('cd-s into the repo path, answers question vars, and pins the namespace', () => {
    const prompty: Repo = {
      ...repo,
      namespace: 'panels',
      varDefaults: { WORKLOAD_TYPE: 'api', TARGET_REGION: 'us' },
    }
    expect(devspaceCommand(prompty, 'deploy')).toBe(
      "cd '/home/me/Code/svc a' && devspace deploy --var 'WORKLOAD_TYPE=api' --var 'TARGET_REGION=us' -n 'panels'",
    )
  })

  it('has no DEVSPACE_BINARY_DIR for a single-config repo', () => {
    expect(devspaceCommand(repo, 'dev')).toBe("cd '/home/me/Code/svc a' && devspace dev")
  })

  it('exports DEVSPACE_BINARY_DIR=<root> for a ./devspace-wrapper repo', () => {
    expect(devspaceCommand(wrapped, 'deploy')).toBe(
      "export DEVSPACE_BINARY_DIR='/home/me/Code/agents' && " +
        "cd '/home/me/Code/agents/.devspace/agents-api' && devspace deploy",
    )
  })
})

describe('verbLabel', () => {
  it('shows ./devspace for a wrapper repo (driven by the repo script)', () => {
    expect(verbLabel(wrapped, 'deploy')).toBe('./devspace deploy')
  })

  it('shows devspace for a plain repo, with question vars + namespace', () => {
    const prompty: Repo = { ...repo, namespace: 'panels', varDefaults: { WORKLOAD_TYPE: 'api' } }
    expect(verbLabel(prompty, 'deploy')).toBe('devspace deploy --var WORKLOAD_TYPE=api -n panels')
  })
})

describe('shellQuote', () => {
  it('escapes single quotes', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'")
  })
})
