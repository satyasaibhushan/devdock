import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunResult } from './exec.js'
import type { SpawnFn } from './logTailer.js'
import { PtyBroker } from './ptyBroker.js'
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
function cannedRunner(podsJson: string, sessionExists: boolean, deploymentsJson = '{"items":[]}') {
  return vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
    if (cmd === 'tmux' && args[0] === 'has-session')
      return { code: sessionExists ? 0 : 1, stdout: '', stderr: '' }
    if (cmd === 'kubectl' && args[0] === 'get')
      return { code: 0, stdout: args[1] === 'deployments' ? deploymentsJson : podsJson, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  })
}

/** Records streaming spawns (tail -F, kubectl logs -f) without real children. */
function fakeStreamSpawner() {
  const spawns: Array<{ cmd: string; args: string[] }> = []
  const spawner = ((cmd: string, args: string[]) => {
    spawns.push({ cmd, args })
    return { stdout: { on() {} }, stderr: { on() {} }, kill() {} } as never
  }) as SpawnFn
  return { spawner, spawns }
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
    const svc = new Service(
      { roots: [root], stateFile },
      { runner: cannedRunner(podsJson, true), streamSpawner: fakeStreamSpawner().spawner },
    )
    svc.rescan()
    expect(svc.listRepos().map((r) => r.id)).toEqual(['svc-a'])

    const states = await svc.reconcileAll()
    expect(states[0]?.status).toBe('RUNNING_MANAGED')
    expect(svc.get('svc-a')?.status).toBe('RUNNING_MANAGED')
  })

  it('reports DEPLOYED when deployment objects exist but nothing runs', async () => {
    const deploymentsJson = JSON.stringify({
      items: [{ metadata: { name: 'svc-a' }, spec: { replicas: 0 }, status: {} }],
    })
    const svc = new Service(
      { roots: [root], stateFile },
      { runner: cannedRunner('{"items":[]}', false, deploymentsJson) },
    )
    svc.rescan()
    await svc.reconcileAll()
    expect(svc.get('svc-a')?.status).toBe('DEPLOYED')
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

  it('terminal falls back to a devspace-enter pod shell for external deployments', async () => {
    const podsJson = JSON.stringify({
      items: [
        {
          metadata: { name: 'svc-a-devspace-1' },
          status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] },
        },
      ],
    })
    const spawns: Array<{ file: string; args: string[]; cwd?: string }> = []
    const broker = new PtyBroker((file, args, opts) => {
      spawns.push({ file, args, cwd: opts.cwd })
      return {
        onData: () => {},
        onExit: () => {},
        write: () => {},
        resize: () => {},
        kill: () => {},
      }
    })
    // no tmux session, but live pods → RUNNING_EXTERNAL
    const svc = new Service(
      { roots: [root], stateFile },
      { runner: cannedRunner(podsJson, false), broker },
    )
    svc.rescan()
    await svc.reconcileAll()
    expect(svc.get('svc-a')?.status).toBe('RUNNING_EXTERNAL')

    await svc.openTerminal('svc-a', 'ro')
    expect(spawns[0]?.file).toBe('devspace')
    expect(spawns[0]?.args).toEqual(['enter', '--pod', 'svc-a-devspace-1'])
    expect(spawns[0]?.cwd).toBe(join(root, 'svc-a'))
  })

  it('terminal refuses when nothing is running', async () => {
    const svc = new Service(
      { roots: [root], stateFile },
      { runner: cannedRunner('{"items":[]}', false) },
    )
    svc.rescan()
    await svc.reconcileAll()
    await expect(svc.openTerminal('svc-a', 'ro')).rejects.toThrow(/not running/)
  })

  it('narrates verb activity into the repo logs, even with no pods', async () => {
    const svc = new Service(
      { roots: [root], stateFile },
      { runner: cannedRunner('{"items":[]}', false) },
    )
    svc.rescan()
    const seen: string[] = []
    const unsub = svc.subscribeLogs('svc-a', (l) => seen.push(l))
    await svc.build('svc-a')
    expect(seen[0]).toBe('$ devspace deploy -n ns')
    expect(seen.at(-1)).toBe('✓ devspace deploy -n ns')
    unsub()

    await svc.stop('svc-a')
    const lines = svc.logs('svc-a')
    expect(lines).toContain('$ devspace purge -n ns')
    expect(lines).toContain('✓ devspace purge -n ns')
  })

  it('start mirrors the dev pane into the logs (pipe-pane + tail -F)', async () => {
    const runner = cannedRunner('{"items":[]}', true)
    const { spawner, spawns } = fakeStreamSpawner()
    const svc = new Service({ roots: [root], stateFile }, { runner, streamSpawner: spawner })
    svc.rescan()
    await svc.start('svc-a')

    expect(runner).toHaveBeenCalledWith('tmux', [
      'pipe-pane',
      '-o',
      '-t',
      '=devdock-svc-a',
      expect.stringContaining('svc-a.dev.log'),
    ])
    expect(spawns[0]?.cmd).toBe('tail')
    expect(svc.logs('svc-a')[0]).toBe('$ devspace dev -n ns')
  })

  it('reattaches the dev-pane mirror when a live session has none (daemon restart)', async () => {
    const runner = cannedRunner('{"items":[]}', true)
    const { spawner, spawns } = fakeStreamSpawner()
    const svc = new Service({ roots: [root], stateFile }, { runner, streamSpawner: spawner })
    svc.rescan()
    await svc.reconcileAll()

    expect(runner).toHaveBeenCalledWith('tmux', expect.arrayContaining(['pipe-pane']))
    expect(spawns.map((s) => s.cmd)).toEqual(['tail'])
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
