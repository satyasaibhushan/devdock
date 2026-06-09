import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunResult } from './exec.js'
import { Service } from './service.js'

let root: string
let stateFile: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devdock-svc-'))
  stateFile = join(root, 'state.json')
  mkdirSync(join(root, 'svc-a'), { recursive: true })
  writeFileSync(
    join(root, 'svc-a', 'devspace.yaml'),
    'name: svc-a\nnamespace: ns\ndeployments:\n  app: {}\n',
  )
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A runner that returns canned results based on the command. */
function cannedRunner(podsJson: string, sessionExists: boolean) {
  return vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
    if (cmd === 'tmux' && args[0] === 'has-session')
      return { code: sessionExists ? 0 : 1, stdout: '', stderr: '' }
    if (cmd === 'kubectl' && args[0] === 'get') return { code: 0, stdout: podsJson, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  })
}

describe('Service', () => {
  it('scans repos and reconciles to a status', async () => {
    const podsJson = JSON.stringify({
      items: [
        {
          metadata: { name: 'svc-a-app-1' },
          status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] },
        },
      ],
    })
    const svc = new Service({ roots: [root], stateFile }, { runner: cannedRunner(podsJson, true) })
    svc.rescan()
    expect(svc.listRepos().map((r) => r.id)).toEqual(['svc-a'])

    const states = await svc.reconcileAll()
    expect(states[0]?.status).toBe('RUNNING_MANAGED')
    expect(svc.get('svc-a')?.status).toBe('RUNNING_MANAGED')
  })

  it('emits a status event on change', async () => {
    const svc = new Service(
      { roots: [root], stateFile },
      { runner: cannedRunner('{"items":[]}', false) },
    )
    svc.rescan()
    const events: string[] = []
    svc.events.on('status', (s) => events.push(s.status))
    await svc.reconcileAll()
    expect(events).toEqual(['STOPPED'])
  })

  it('throws on unknown repo', async () => {
    const svc = new Service({ roots: [root], stateFile })
    svc.rescan()
    await expect(svc.start('nope')).rejects.toThrow(/unknown repo/)
  })

  it('restart rolls the workload deployment', async () => {
    const runner = cannedRunner('{"items":[]}', false)
    const svc = new Service({ roots: [root], stateFile }, { runner })
    svc.rescan()
    await svc.restart('svc-a')
    expect(runner).toHaveBeenCalledWith('kubectl', [
      'rollout',
      'restart',
      'deployment/app',
      '-n',
      'ns',
    ])
  })
})
