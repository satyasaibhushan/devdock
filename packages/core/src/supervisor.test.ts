import { describe, expect, it, vi } from 'vitest'
import type { RunResult } from './exec.js'
import { sessionName } from './registry.js'
import { Supervisor, shellQuote } from './supervisor.js'
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

  it('kill purges then kills the session', async () => {
    const calls: string[][] = []
    const runner = vi.fn(async (_c: string, args: string[]) => {
      calls.push(args)
      return ok()
    })
    await new Supervisor(runner).kill(repo)
    expect(calls[0]).toEqual(['purge'])
    expect(calls[1]).toEqual(['kill-session', '-t', 'devdock-svc-a'])
  })

  it('exec sends a command into the dev session', async () => {
    const runner = vi.fn(async () => ok())
    await new Supervisor(runner).exec(repo, 'pnpm test')
    expect(runner).toHaveBeenCalledWith('tmux', [
      'send-keys',
      '-t',
      'devdock-svc-a',
      'pnpm test',
      'Enter',
    ])
  })

  it('lists only devdock- sessions', async () => {
    const runner = vi.fn(async () => ok('devdock-svc-a\nother\ndevdock-svc-b\n'))
    expect(await new Supervisor(runner).listSessions()).toEqual(['devdock-svc-a', 'devdock-svc-b'])
  })
})

describe('shellQuote', () => {
  it('escapes single quotes', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'")
  })
})
