import { describe, expect, it, vi } from 'vitest'
import type { RunResult } from './exec.js'
import { sessionName } from './registry.js'
import { Supervisor, devspaceArgs, shellQuote } from './supervisor.js'
import type { Repo } from './types.js'

const repo: Repo = {
  id: 'svc-a',
  name: 'svc-a',
  path: '/home/me/Code/svc a',
  configPath: '/home/me/Code/svc a/devspace.yaml',
  ports: [],
  session: sessionName('svc-a'),
}

function ok(stdout = ''): RunResult {
  return { code: 0, stdout, stderr: '' }
}

describe('Supervisor', () => {
  it('starts devspace dev inside a named, quoted tmux session', async () => {
    const runner = vi.fn(async () => ok())
    await new Supervisor(runner).start(repo)
    expect(runner).toHaveBeenCalledWith('tmux', [
      'new-session',
      '-d',
      '-s',
      'devdock-svc-a',
      "cd '/home/me/Code/svc a' && devspace dev",
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

  it('build streams deploy output through the stream runner', async () => {
    const streamRunner = vi.fn(
      async (_c: string, _a: string[], _o: { cwd?: string }, onLine: (l: string) => void) => {
        onLine('deploying chart…')
        return ok()
      },
    )
    const lines: string[] = []
    await new Supervisor(undefined, streamRunner).build(repo, (l) => lines.push(l))
    expect(streamRunner).toHaveBeenCalledWith(
      'devspace',
      ['deploy'],
      { cwd: repo.path },
      expect.any(Function),
    )
    expect(lines).toEqual(['deploying chart…'])
  })

  it('kill purges then kills the session', async () => {
    const calls: string[][] = []
    const runner = vi.fn(async (_c: string, args: string[]) => {
      calls.push(args)
      return ok()
    })
    await new Supervisor(runner).kill(repo)
    expect(calls[0]).toEqual(['purge'])
    expect(calls[1]).toEqual(['kill-session', '-t', '=devdock-svc-a'])
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

    it('build and kill pass them to devspace', async () => {
      const runner = vi.fn(async () => ok())
      const sup = new Supervisor(runner)
      await sup.build(prompty)
      expect(runner).toHaveBeenCalledWith(
        'devspace',
        ['deploy', '--var', 'WORKLOAD_TYPE=api', '--var', 'TARGET_REGION=us', '-n', 'panels'],
        { cwd: prompty.path },
      )
      await sup.kill(prompty)
      expect(runner).toHaveBeenCalledWith(
        'devspace',
        ['purge', '--var', 'WORKLOAD_TYPE=api', '--var', 'TARGET_REGION=us', '-n', 'panels'],
        { cwd: prompty.path },
      )
    })

    it('start embeds them in the tmux command, with values quoted', async () => {
      const runner = vi.fn(async () => ok())
      await new Supervisor(runner).start(prompty)
      expect(runner).toHaveBeenCalledWith('tmux', [
        'new-session',
        '-d',
        '-s',
        'devdock-svc-a',
        "cd '/home/me/Code/svc a' && devspace dev --var 'WORKLOAD_TYPE=api' --var 'TARGET_REGION=us' -n 'panels'",
      ])
    })
  })
})

describe('shellQuote', () => {
  it('escapes single quotes', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'")
  })
})
