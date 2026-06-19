import { describe, expect, it, vi } from 'vitest'
import { type RunResult, loginShell } from './exec.js'
import { sessionName } from './registry.js'
import { Supervisor, devspaceArgs, devspaceCommand, shellQuote } from './supervisor.js'
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
      `${loginShell} -lc ${shellQuote("cd '/home/me/Code/svc a' && devspace dev")}`,
    ])
  })

  it('start mirrors the pane to a file when given one', async () => {
    const calls: string[][] = []
    const runner = vi.fn(async (_c: string, args: string[]) => {
      calls.push(args)
      return ok()
    })
    await new Supervisor(runner).start(repo, '/tmp/svc-a.dev.log')
    expect(calls[1]).toEqual([
      'pipe-pane',
      '-o',
      '-t',
      '=devdock-svc-a',
      "cat >> '/tmp/svc-a.dev.log'",
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
      ['-lc', devspaceCommand(repo, 'deploy')],
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
    expect(calls[0]).toEqual({ cmd: loginShell, args: ['-lc', devspaceCommand(repo, 'purge')] })
    expect(calls[1]).toEqual({ cmd: 'tmux', args: ['kill-session', '-t', '=devdock-svc-a'] })
  })

  it('exec sends a command into the dev session', async () => {
    const runner = vi.fn(async () => ok())
    await new Supervisor(runner).exec(repo, 'pnpm test')
    expect(runner).toHaveBeenCalledWith('tmux', [
      'send-keys',
      '-t',
      '=devdock-svc-a',
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
      expect(runner).toHaveBeenCalledWith(loginShell, ['-lc', devspaceCommand(prompty, 'deploy')])
      await sup.kill(prompty)
      expect(runner).toHaveBeenCalledWith(loginShell, ['-lc', devspaceCommand(prompty, 'purge')])
    })

    it('start embeds the answered command in the tmux login-shell call', async () => {
      const runner = vi.fn(async () => ok())
      await new Supervisor(runner).start(prompty)
      expect(runner).toHaveBeenCalledWith('tmux', [
        'new-session',
        '-d',
        '-s',
        'devdock-svc-a',
        `${loginShell} -lc ${shellQuote(devspaceCommand(prompty, 'dev'))}`,
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

describe('shellQuote', () => {
  it('escapes single quotes', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'")
  })
})
