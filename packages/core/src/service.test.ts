import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthManager } from './auth.js'
import type { AwsCreds } from './awsCreds.js'
import { type RunResult, loginShell } from './exec.js'
import type { SpawnFn } from './logTailer.js'
import { PtyBroker } from './ptyBroker.js'
import { Service } from './service.js'
import { StateStore } from './stateStore.js'

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
    if (cmd === 'tmux' && args[0] === 'list-sessions')
      return { code: 0, stdout: sessionExists ? 'devdock-svc-a\n' : '', stderr: '' }
    // reconcile reads session liveness/deadness via `list-panes -a`; "0" = a
    // healthy (alive) dev pane.
    if (cmd === 'tmux' && args[0] === 'list-panes')
      return { code: 0, stdout: sessionExists ? 'devdock-svc-a 0\n' : '', stderr: '' }
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

  it('retires an old no-pod dev session only after the condition persists', async () => {
    const deploymentsJson = JSON.stringify({
      items: [{ metadata: { name: 'svc-a' }, spec: { replicas: 0 }, status: {} }],
    })
    const runner = vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
      if (cmd === 'tmux' && args[0] === 'list-panes') {
        return { code: 0, stdout: 'devdock-svc-a 0 1\n', stderr: '' }
      }
      if (cmd === 'kubectl' && args[0] === 'get') {
        if (args[1] === 'deployments') return { code: 0, stdout: deploymentsJson, stderr: '' }
        if (args[1] === 'configmap') return { code: 0, stdout: '{"data":{}}', stderr: '' }
        return { code: 0, stdout: '{"items":[]}', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const svc = new Service(
      { roots: [root], stateFile },
      { runner, streamSpawner: fakeStreamSpawner().spawner },
    )
    svc.rescan()
    const t0 = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0)

    // First no-pod observation starts the stale timer — no retire yet, even
    // though the session itself is ancient (created at epoch).
    await svc.reconcileAll()
    expect(svc.get('svc-a')?.status).toBe('BUILDING')
    expect(runner).not.toHaveBeenCalledWith('tmux', ['kill-session', '-t', '=devdock-svc-a'])

    // The condition has now held continuously past the threshold → retire.
    nowSpy.mockReturnValue(t0 + 31 * 60 * 1000)
    await svc.reconcileAll()
    expect(svc.get('svc-a')?.status).toBe('DEPLOYED')
    expect(svc.get('svc-a')?.hasSession).toBe(false)
    expect(runner).toHaveBeenCalledWith('tmux', ['kill-session', '-t', '=devdock-svc-a'])
    nowSpy.mockRestore()
  })

  it('a transient kubectl failure never retires the session or drops the status', async () => {
    const podsJson = JSON.stringify({
      items: [
        {
          metadata: { name: 'svc-a-app-1' },
          status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] },
        },
      ],
    })
    let kubectlDown = false
    const runner = vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
      if (cmd === 'tmux' && args[0] === 'list-panes') {
        // an old, healthy session (created at epoch — well past any age gate)
        return { code: 0, stdout: 'devdock-svc-a 0 1\n', stderr: '' }
      }
      if (cmd === 'kubectl' && args[0] === 'get') {
        if (kubectlDown) return { code: 1, stdout: '', stderr: 'Unable to connect to the server' }
        return {
          code: 0,
          stdout: args[1] === 'deployments' ? '{"items":[]}' : podsJson,
          stderr: '',
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const svc = new Service(
      { roots: [root], stateFile },
      { runner, streamSpawner: fakeStreamSpawner().spawner },
    )
    svc.rescan()
    await svc.reconcileAll()
    expect(svc.get('svc-a')?.status).toBe('RUNNING_MANAGED')

    kubectlDown = true
    await svc.reconcileAll()
    // unknown ≠ gone: last known status holds, session untouched
    expect(svc.get('svc-a')?.status).toBe('RUNNING_MANAGED')
    expect(runner).not.toHaveBeenCalledWith('tmux', ['kill-session', '-t', '=devdock-svc-a'])

    kubectlDown = false
    await svc.reconcileAll()
    expect(svc.get('svc-a')?.status).toBe('RUNNING_MANAGED')
  })

  it('a momentary empty pod read on an old session does not retire it', async () => {
    const podsJson = JSON.stringify({
      items: [
        {
          metadata: { name: 'svc-a-app-1' },
          status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] },
        },
      ],
    })
    let podsGone = false
    const runner = vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
      if (cmd === 'tmux' && args[0] === 'list-panes') {
        return { code: 0, stdout: 'devdock-svc-a 0 1\n', stderr: '' }
      }
      if (cmd === 'kubectl' && args[0] === 'get') {
        const pods = podsGone ? '{"items":[]}' : podsJson
        return { code: 0, stdout: args[1] === 'deployments' ? '{"items":[]}' : pods, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const svc = new Service(
      { roots: [root], stateFile },
      { runner, streamSpawner: fakeStreamSpawner().spawner },
    )
    svc.rescan()
    await svc.reconcileAll()
    expect(svc.get('svc-a')?.status).toBe('RUNNING_MANAGED')

    podsGone = true
    await svc.reconcileAll() // pod recreating / blip — timer starts, nothing retired
    expect(runner).not.toHaveBeenCalledWith('tmux', ['kill-session', '-t', '=devdock-svc-a'])

    podsGone = false
    await svc.reconcileAll()
    expect(svc.get('svc-a')?.status).toBe('RUNNING_MANAGED')
  })

  it('auto-reconnects a dead dev session whose pod is still running', async () => {
    const podsJson = JSON.stringify({
      items: [
        {
          metadata: { name: 'svc-a-devspace-1' },
          status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] },
        },
      ],
    })
    const runner = vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
      if (cmd === 'tmux' && args[0] === 'list-panes') {
        // pane_dead=1: devspace dev exited (dropped connection) — pod remains
        return { code: 0, stdout: 'devdock-svc-a 1 1\n', stderr: '' }
      }
      if (cmd === 'kubectl' && args[0] === 'get') {
        if (args[1] === 'configmap') return { code: 0, stdout: '{"data":{}}', stderr: '' }
        return {
          code: 0,
          stdout: args[1] === 'deployments' ? '{"items":[]}' : podsJson,
          stderr: '',
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const svc = new Service(
      { roots: [root], stateFile },
      { runner, streamSpawner: fakeStreamSpawner().spawner },
    )
    svc.rescan()
    await svc.reconcileAll()
    // the dead shell is retired and `devspace dev` relaunched to reattach
    await vi.waitFor(() => {
      expect(runner).toHaveBeenCalledWith('tmux', ['kill-session', '-t', '=devdock-svc-a'])
      expect(runner).toHaveBeenCalledWith('tmux', expect.arrayContaining(['new-session']))
    })
    expect(svc.logs('svc-a').some((l) => l.includes('reconnecting'))).toBe(true)
  })

  it('keeps a fresh no-pod dev session in BUILDING', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const deploymentsJson = JSON.stringify({
      items: [{ metadata: { name: 'svc-a' }, spec: { replicas: 0 }, status: {} }],
    })
    const runner = vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
      if (cmd === 'tmux' && args[0] === 'list-panes') {
        return { code: 0, stdout: `devdock-svc-a 0 ${nowSeconds}\n`, stderr: '' }
      }
      if (cmd === 'kubectl' && args[0] === 'get') {
        return {
          code: 0,
          stdout: args[1] === 'deployments' ? deploymentsJson : '{"items":[]}',
          stderr: '',
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const svc = new Service({ roots: [root], stateFile }, { runner })
    svc.rescan()
    await svc.reconcileAll()
    expect(svc.get('svc-a')?.status).toBe('BUILDING')
    expect(runner).not.toHaveBeenCalledWith('tmux', ['kill-session', '-t', '=devdock-svc-a'])
  })

  it('keeps a fresh failed no-pod session as CRASHED when no deployment exists', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const runner = vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
      if (cmd === 'tmux' && args[0] === 'list-panes') {
        return { code: 0, stdout: `devdock-svc-a 1 ${nowSeconds}\n`, stderr: '' }
      }
      if (cmd === 'kubectl' && args[0] === 'get') {
        return { code: 0, stdout: '{"items":[]}', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const svc = new Service({ roots: [root], stateFile }, { runner })
    svc.rescan()
    await svc.reconcileAll()
    expect(svc.get('svc-a')?.status).toBe('CRASHED')
    expect(runner).not.toHaveBeenCalledWith('tmux', ['kill-session', '-t', '=devdock-svc-a'])
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
    // Pin the reconciled pod so the shell can't auto-pick a different service's
    // pod from the shared namespace; --wait covers a pod still coming up; -n
    // pins the namespace so a later global switch can't redirect the shell.
    expect(spawns[0]?.args).toEqual(['enter', '--pod', 'svc-a-devspace-1', '--wait', '-n', 'ns'])
    expect(spawns[0]?.cwd).toBe(join(root, 'svc-a'))
  })

  it('terminal refuses when nothing is running', async () => {
    const svc = new Service(
      { roots: [root], stateFile },
      { runner: cannedRunner('{"items":[]}', false) },
    )
    svc.rescan()
    await svc.reconcileAll()
    await expect(svc.openTerminal('svc-a', 'ro')).rejects.toThrow(/start it first/)
  })

  it("kind:'shell' opens an independent pod shell even when a tmux session exists", async () => {
    const podsJson = JSON.stringify({
      items: [
        {
          metadata: { name: 'svc-a-devspace-1' },
          status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] },
        },
      ],
    })
    const spawns: Array<{ file: string; args: string[] }> = []
    const broker = new PtyBroker((file, args) => {
      spawns.push({ file, args })
      return {
        onData: () => {},
        onExit: () => {},
        write: () => {},
        resize: () => {},
        kill: () => {},
      }
    })
    // A managed session IS present, so kind:'auto' would attach tmux…
    const svc = new Service(
      { roots: [root], stateFile },
      { runner: cannedRunner(podsJson, true), broker },
    )
    svc.rescan()
    await svc.reconcileAll()

    await svc.openTerminal('svc-a', 'rw', undefined, undefined, undefined, 'auto')
    expect(spawns[0]?.file).toBe('tmux')

    // …but kind:'shell' bypasses it for a fresh `devspace enter` into the pod,
    // pinned to the reconciled pod so it can't drift to another service's pod.
    await svc.openTerminal('svc-a', 'rw', undefined, undefined, undefined, 'shell')
    expect(spawns[1]?.file).toBe('devspace')
    expect(spawns[1]?.args).toEqual(['enter', '--pod', 'svc-a-devspace-1', '--wait', '-n', 'ns'])
  })

  it('reuses the one auto terminal across concurrent and repeated opens', async () => {
    const podsJson = JSON.stringify({
      items: [
        {
          metadata: { name: 'svc-a-devspace-1' },
          status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] },
        },
      ],
    })
    const spawns: string[] = []
    const broker = new PtyBroker((file) => {
      spawns.push(file)
      return {
        onData: () => {},
        onExit: () => {},
        write: () => {},
        resize: () => {},
        kill: () => {},
      }
    })
    const svc = new Service(
      { roots: [root], stateFile },
      { runner: cannedRunner(podsJson, true), broker },
    )
    svc.rescan()
    await svc.reconcileAll()

    // Concurrent opens (UI tab + agent racing) single-flight into one terminal…
    const [a, b] = await Promise.all([
      svc.openRegisteredTerminal({ repo: 'svc-a', kind: 'auto' }),
      svc.openRegisteredTerminal({ repo: 'svc-a', kind: 'auto' }),
    ])
    expect(a.id).toBe(b.id)
    expect(a.attach).toBe('tmux')
    // …and a later open finds the live one instead of spawning again.
    const c = await svc.openRegisteredTerminal({ repo: 'svc-a', kind: 'auto' })
    expect(c.id).toBe(a.id)
    expect(spawns).toEqual(['tmux'])
  })

  it('replaces a stale pod-shell auto terminal once a managed session appears', async () => {
    const podsJson = JSON.stringify({
      items: [
        {
          metadata: { name: 'svc-a-devspace-1' },
          status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] },
        },
      ],
    })
    let sessionExists = false
    const runner = vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
      if (cmd === 'tmux' && args[0] === 'has-session')
        return { code: sessionExists ? 0 : 1, stdout: '', stderr: '' }
      if (cmd === 'tmux' && args[0] === 'list-panes')
        return { code: 0, stdout: sessionExists ? 'devdock-svc-a 0\n' : '', stderr: '' }
      if (cmd === 'kubectl' && args[0] === 'get')
        return {
          code: 0,
          stdout: args[1] === 'deployments' ? '{"items":[]}' : podsJson,
          stderr: '',
        }
      return { code: 0, stdout: '', stderr: '' }
    })
    const spawns: string[] = []
    const broker = new PtyBroker((file) => {
      spawns.push(file)
      return {
        onData: () => {},
        onExit: () => {},
        write: () => {},
        resize: () => {},
        kill: () => {},
      }
    })
    const svc = new Service({ roots: [root], stateFile }, { runner, broker })
    svc.rescan()
    await svc.reconcileAll()

    // No managed session yet → the primary falls back to a pod shell.
    const first = await svc.openRegisteredTerminal({ repo: 'svc-a', kind: 'auto' })
    expect(first.attach).toBe('pod')
    expect(spawns).toEqual(['devspace'])

    // A dev session appears (workload started): the pod-shell primary is stale —
    // the next open closes it and attaches the tmux session instead.
    sessionExists = true
    const second = await svc.openRegisteredTerminal({ repo: 'svc-a', kind: 'auto' })
    expect(second.id).not.toBe(first.id)
    expect(second.attach).toBe('tmux')
    expect(spawns).toEqual(['devspace', 'tmux'])
    expect(
      svc
        .listTerminals()
        .filter((t) => t.alive)
        .map((t) => t.id),
    ).toEqual([second.id])
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

  it('start mirrors the dev pane to the on-disk dev log only — never into Logs', async () => {
    const runner = cannedRunner('{"items":[]}', true)
    const { spawner, spawns } = fakeStreamSpawner()
    const svc = new Service({ roots: [root], stateFile }, { runner, streamSpawner: spawner })
    svc.rescan()
    await svc.start('svc-a')

    expect(runner).toHaveBeenCalledWith('tmux', [
      'pipe-pane',
      '-t',
      '=devdock-svc-a:',
      expect.stringContaining('svc-a.dev.log'),
    ])
    // The pane is the Terminal panel's content; tailing it into the log hub
    // would make Logs a duplicate of the Terminal. Only the verb marker lands.
    expect(spawns.map((s) => s.cmd)).not.toContain('tail')
    expect(svc.logs('svc-a')[0]).toBe('$ devspace dev -n ns')
  })

  it('re-pipes a live session found on reconcile (daemon restart) and backfills mouse mode', async () => {
    const runner = cannedRunner('{"items":[]}', true)
    const { spawner, spawns } = fakeStreamSpawner()
    const svc = new Service({ roots: [root], stateFile }, { runner, streamSpawner: spawner })
    svc.rescan()
    await svc.reconcileAll()

    expect(runner).toHaveBeenCalledWith('tmux', expect.arrayContaining(['pipe-pane']))
    expect(runner).toHaveBeenCalledWith('tmux', [
      'set-option',
      '-t',
      '=devdock-svc-a:',
      'mouse',
      'on',
    ])
    expect(spawns.map((s) => s.cmd)).not.toContain('tail')
  })

  it('fires a queued startup command even when the daemon restarts mid-deploy', async () => {
    // start() queues the configured command while the pod is still deploying…
    const before = new Service(
      { roots: [root], stateFile },
      { runner: cannedRunner('{"items":[]}', true), streamSpawner: fakeStreamSpawner().spawner },
    )
    before.rescan()
    before.setStartupCommand('svc-a', 'pnpm run dev')
    await before.start('svc-a')

    // …the daemon restarts inside the deploy window (fresh Service, same store),
    // and the pod only becomes ready on the new process's watch.
    const readyPod = JSON.stringify({
      items: [
        {
          metadata: { name: 'svc-a-app-1' },
          status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] },
        },
      ],
    })
    vi.useFakeTimers()
    try {
      const runner = cannedRunner(readyPod, true)
      const after = new Service(
        { roots: [root], stateFile },
        { runner, streamSpawner: fakeStreamSpawner().spawner },
      )
      after.rescan()
      await after.reconcileAll()
      expect(after.get('svc-a')?.status).toBe('RUNNING_MANAGED')
      await vi.advanceTimersByTimeAsync(3000) // past the startup grace
      expect(runner).toHaveBeenCalledWith('tmux', [
        'send-keys',
        '-t',
        '=devdock-svc-a:',
        'pnpm run dev',
        'Enter',
      ])

      // One shot per start: the queue entry was consumed with the send.
      runner.mockClear()
      await after.reconcileAll()
      await vi.advanceTimersByTimeAsync(3000)
      expect(runner).not.toHaveBeenCalledWith('tmux', expect.arrayContaining(['send-keys']))
    } finally {
      vi.useRealTimers()
    }
  })

  it('queues the startup command configured for the selected pod type', async () => {
    mkdirSync(join(root, 'svc-multi'), { recursive: true })
    writeFileSync(
      join(root, 'svc-multi', 'devspace.yaml'),
      [
        'name: svc-multi',
        'vars:',
        '  WORKLOAD_TYPE:',
        '    question: pod type',
        '    default: api',
        '    options: [api, worker]',
      ].join('\n'),
    )
    const svc = new Service(
      { roots: [root], stateFile },
      { runner: cannedRunner('{"items":[]}', false), streamSpawner: fakeStreamSpawner().spawner },
    )
    svc.rescan()
    svc.setStartupCommand('svc-multi', 'pnpm api', 'api')
    svc.setStartupCommand('svc-multi', 'pnpm worker', 'worker')

    expect(svc.getStartupCommands('svc-multi')).toEqual({
      api: 'pnpm api',
      worker: 'pnpm worker',
    })
    await svc.start('svc-multi', 'worker')
    expect(new StateStore(stateFile).getPendingStartup('svc-multi::worker')).toBe('pnpm worker')
  })

  it('stop clears a still-queued startup command — a canceled start must not fire later', async () => {
    const svc = new Service(
      { roots: [root], stateFile },
      { runner: cannedRunner('{"items":[]}', true), streamSpawner: fakeStreamSpawner().spawner },
    )
    svc.rescan()
    svc.setStartupCommand('svc-a', 'pnpm run dev')
    await svc.start('svc-a')
    await svc.stop('svc-a')
    expect(new StateStore(stateFile).getPendingStartup('svc-a')).toBeUndefined()
  })

  it('restart recycles the workload: kill → build → start', async () => {
    const runner = cannedRunner('{"items":[]}', false)
    const { spawner } = fakeStreamSpawner()
    const svc = new Service({ roots: [root], stateFile }, { runner, streamSpawner: spawner })
    svc.rescan()
    await svc.restart('svc-a')
    // purge then deploy run through the login shell; dev starts a tmux session.
    const shellCmds = runner.mock.calls
      .filter((c) => c[0] === loginShell)
      .map((c) => (c[1] as string[])[1] ?? '')
    expect(shellCmds.some((c) => c.includes('devspace purge'))).toBe(true)
    expect(shellCmds.some((c) => c.includes('devspace deploy'))).toBe(true)
    expect(runner).toHaveBeenCalledWith('tmux', expect.arrayContaining(['new-session']))
  })

  it('namespaceInfo unions the context namespace, remembered ones, and repo-declared ones', async () => {
    const runner = vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
      if (cmd === 'kubectl' && args[0] === 'config' && args[1] === 'view')
        return { code: 0, stdout: 'saibhushan\n', stderr: '' }
      if (cmd === 'kubectl') return { code: 0, stdout: '{"items":[]}', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const svc = new Service({ roots: [root], stateFile }, { runner })
    svc.rescan()
    const info = await svc.namespaceInfo()
    expect(info.current).toBe('saibhushan')
    // svc-a's config declares `namespace: ns` — offered alongside the current
    expect(info.known).toEqual(expect.arrayContaining(['ns', 'saibhushan']))
  })

  it('setNamespace switches the kube context (the kn alias) and remembers the namespace', async () => {
    const runner = vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
      if (cmd === 'kubectl' && args[0] === 'config' && args[1] === 'view')
        return { code: 0, stdout: 'saibhushan', stderr: '' }
      if (cmd === 'kubectl') return { code: 0, stdout: '{"items":[]}', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const svc = new Service({ roots: [root], stateFile }, { runner })
    svc.rescan()
    const info = await svc.setNamespace('panels')
    expect(runner).toHaveBeenCalledWith('kubectl', [
      'config',
      'set-context',
      '--current',
      '--namespace=panels',
    ])
    expect(info.known).toContain('panels')
    await expect(svc.setNamespace('Not A Namespace!')).rejects.toThrow(/invalid namespace/)
    // let the switch-triggered background reconcile settle before teardown
    await new Promise((r) => setTimeout(r, 0))
  })

  it('pins a session to the namespace it started in and releases the pin on stop', async () => {
    mkdirSync(join(root, 'svc-b'), { recursive: true })
    writeFileSync(join(root, 'svc-b', 'devspace.yaml'), 'name: svc-b\ndeployments:\n  app: {}\n')
    let contextNs = 'saibhushan'
    const runner = vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
      if (cmd === 'kubectl' && args[0] === 'config' && args[1] === 'view')
        return { code: 0, stdout: contextNs, stderr: '' }
      if (cmd === 'kubectl') return { code: 0, stdout: '{"items":[]}', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const svc = new Service(
      { roots: [root], stateFile },
      { runner, streamSpawner: fakeStreamSpawner().spawner },
    )
    svc.rescan()
    await svc.start('svc-b')

    // `devspace dev` ran pinned to the start-time context namespace
    // (the inner command is login-shell wrapped, so quotes are nested/escaped)
    const dev = runner.mock.calls.find(
      (c) => c[0] === 'tmux' && (c[1] as string[])[0] === 'new-session',
    )
    expect(String((dev?.[1] as string[]).at(-1))).toMatch(/devspace dev -n \S*saibhushan/)

    // the user switches the global namespace — svc-b's cluster queries still
    // target its own namespace, so its pods can't "disappear" and get retired
    contextNs = 'panels'
    runner.mockClear()
    await svc.reconcileAll()
    expect(runner).toHaveBeenCalledWith('kubectl', [
      'get',
      'pods',
      '-o',
      'json',
      '-n',
      'saibhushan',
    ])

    // stop purges in the pinned namespace, then releases the pin…
    runner.mockClear()
    await svc.stop('svc-b')
    const purge = runner.mock.calls.find(
      (c) => c[0] === loginShell && String((c[1] as string[])[1]).includes('devspace purge'),
    )
    expect(String((purge?.[1] as string[])[1])).toContain("-n 'saibhushan'")

    // …so the next start pins to wherever the context points now
    runner.mockClear()
    await svc.start('svc-b')
    const dev2 = runner.mock.calls.find(
      (c) => c[0] === 'tmux' && (c[1] as string[])[0] === 'new-session',
    )
    expect(String((dev2?.[1] as string[]).at(-1))).toMatch(/devspace dev -n \S*panels/)
  })

  it('restart holds one RESTARTING status, never flickering through STOPPED/DEPLOYED', async () => {
    const runner = cannedRunner('{"items":[]}', false)
    const { spawner } = fakeStreamSpawner()
    const svc = new Service({ roots: [root], stateFile }, { runner, streamSpawner: spawner })
    svc.rescan()
    await svc.reconcileAll() // settle initial STOPPED
    const seen: string[] = []
    svc.events.on('status', (s) => seen.push(s.status))
    await svc.restart('svc-a')
    // RESTARTING is surfaced once up front and held across purge→deploy→dev; the
    // intermediate STOPPED/DEPLOYED the steps pass through are never emitted.
    expect(seen[0]).toBe('RESTARTING')
    expect(seen).not.toContain('DEPLOYED')
    expect(seen.at(-1)).not.toBe('RESTARTING') // settles to the real status at the end
  })

  it('refuses verbs while kubernetes login is required, without spawning devspace', async () => {
    const runner = cannedRunner('{"items":[]}', false)
    const auth = {
      snapshot: () => ({ oidc: true, phase: 'login_required', checkedAt: Date.now() }),
      ensure: async () => ({
        oidc: true,
        phase: 'login_required',
        message: 'kubernetes login required — sign in from the office network',
        checkedAt: Date.now(),
      }),
      kubectlAllowed: () => true,
      init: async () => ({ oidc: true, phase: 'login_required', checkedAt: Date.now() }),
    } as unknown as AuthManager
    const svc = new Service({ roots: [root], stateFile }, { runner, auth })
    svc.rescan()
    const r = await svc.start('svc-a')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('kubernetes auth')
    // the verb never reached tmux/devspace
    expect(runner.mock.calls.some((c) => c[0] === 'tmux' && c[1][0] === 'new-session')).toBe(false)
    // …and the failure is narrated into the workload's log hub
    expect(svc.logs('svc-a').some((l) => l.includes('office network'))).toBe(true)
  })

  it('returns start promptly while Kubernetes login is still in progress', async () => {
    const runner = cannedRunner('{"items":[]}', false)
    const auth = {
      snapshot: () => ({
        oidc: true,
        phase: 'login_required' as const,
        message: 'Kubernetes login required',
        checkedAt: Date.now(),
      }),
      ensure: vi.fn(() => new Promise(() => undefined)),
      kubectlAllowed: () => true,
      init: async () => ({ oidc: true, phase: 'login_required', checkedAt: Date.now() }),
    } as unknown as AuthManager
    const svc = new Service({ roots: [root], stateFile }, { runner, auth })
    svc.rescan()

    const result = await Promise.race([
      svc.start('svc-a'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('start hung on login')), 50),
      ),
    ])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Kubernetes login required')
    expect(runner.mock.calls.some((c) => c[0] === 'tmux' && c[1][0] === 'new-session')).toBe(false)
  })

  it('refuses start/build while the AWS credential cannot be warmed', async () => {
    const runner = cannedRunner('{"items":[]}', false)
    const awsCreds = {
      configured: () => true,
      fresh: () => false,
      warm: async () => ({ ok: false, message: 'AWS sign-in did not complete in time' }),
    } as unknown as AwsCreds
    const svc = new Service({ roots: [root], stateFile }, { runner, awsCreds })
    svc.rescan()
    for (const r of [await svc.start('svc-a'), await svc.build('svc-a')]) {
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('aws auth')
    }
    // the verb never reached tmux/devspace — no racing aws-cli-oidc logins
    expect(runner.mock.calls.some((c) => c[0] === 'tmux' && c[1][0] === 'new-session')).toBe(false)
    expect(svc.logs('svc-a').some((l) => l.includes('did not complete in time'))).toBe(true)
  })

  it('starts normally once the AWS credential warms', async () => {
    const runner = cannedRunner('{"items":[]}', false)
    const warm = vi.fn(async () => ({ ok: true }))
    const awsCreds = {
      configured: () => true,
      fresh: () => false,
      warm,
    } as unknown as AwsCreds
    const svc = new Service(
      { roots: [root], stateFile },
      { runner, awsCreds, streamSpawner: fakeStreamSpawner().spawner },
    )
    svc.rescan()
    const r = await svc.start('svc-a')
    expect(r.code).toBe(0)
    expect(warm).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls.some((c) => c[0] === 'tmux' && c[1][0] === 'new-session')).toBe(true)
  })

  it('gates reconcile kubectl calls through the auth manager', async () => {
    const runner = cannedRunner('{"items":[]}', false)
    const auth = {
      snapshot: () => ({ oidc: true, phase: 'login_required', checkedAt: Date.now() }),
      kubectlAllowed: (args: string[]) => args[0] === 'config',
      init: async () => ({ oidc: true, phase: 'login_required', checkedAt: Date.now() }),
    } as unknown as AuthManager
    const svc = new Service({ roots: [root], stateFile }, { runner, auth })
    svc.rescan()
    await svc.reconcileAll()
    // no kubectl API call leaked past the gate (each would spawn a kubelogin)
    expect(runner.mock.calls.some((c) => c[0] === 'kubectl' && c[1][0] !== 'config')).toBe(false)
  })
})

const READY_PODS = JSON.stringify({
  items: [
    {
      metadata: { name: 'svc-a-app-devspace-1' },
      status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] },
    },
  ],
})

/** cannedRunner plus a hook for kubectl exec / kubectl logs calls. */
function execRunner(
  onExec: (args: string[]) => RunResult,
  podsJson = READY_PODS,
  onLogs?: (args: string[]) => RunResult,
) {
  const base = cannedRunner(podsJson, true)
  return vi.fn(async (cmd: string, args: string[], opts?: object): Promise<RunResult> => {
    if (cmd === 'kubectl' && args[0] === 'exec') return onExec(args)
    if (cmd === 'kubectl' && args[0] === 'logs' && onLogs) return onLogs(args)
    return base(cmd, args, opts as never)
  })
}

async function reconciledService(runner: ReturnType<typeof execRunner>) {
  const svc = new Service(
    { roots: [root], stateFile },
    { runner, streamSpawner: fakeStreamSpawner().spawner },
  )
  svc.rescan()
  await svc.reconcileAll()
  return svc
}

describe('Service.runInWorkload', () => {
  it('execs into the ready dev pod and reports the real exit code', async () => {
    const runner = execRunner(() => ({ code: 0, stdout: '3 passed\n', stderr: '' }))
    const svc = await reconciledService(runner)
    const r = await svc.runInWorkload('svc-a', 'pytest -q')
    expect(r.ok).toBe(true)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('3 passed\n')
    expect(r.pod).toBe('svc-a-app-devspace-1')
    expect(r.infraError).toBeUndefined()
    expect(runner).toHaveBeenCalledWith(
      'kubectl',
      ['exec', 'svc-a-app-devspace-1', '-n', 'ns', '--', 'sh', '-c', 'pytest -q'],
      { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 },
    )
  })

  it('a failing command is NOT an infra error', async () => {
    const runner = execRunner(() => ({ code: 2, stdout: '', stderr: '1 test failed' }))
    const svc = await reconciledService(runner)
    const r = await svc.runInWorkload('svc-a', 'pytest -q')
    expect(r.ok).toBe(false)
    expect(r.exitCode).toBe(2)
    expect(r.infraError).toBeUndefined()
  })

  it('kubectl-side failures are flagged as infra errors', async () => {
    const runner = execRunner(() => ({
      code: 1,
      stdout: '',
      stderr: 'Error from server: error dialing backend: connect: connection refused',
    }))
    const svc = await reconciledService(runner)
    const r = await svc.runInWorkload('svc-a', 'pytest -q')
    expect(r.ok).toBe(false)
    expect(r.infraError).toContain('kubectl exec failed')
  })

  it('no running pod is an infra error, not a command failure', async () => {
    const runner = execRunner(() => ({ code: 0, stdout: '', stderr: '' }), '{"items":[]}')
    const svc = await reconciledService(runner)
    const r = await svc.runInWorkload('svc-a', 'pytest -q')
    expect(r.ok).toBe(false)
    expect(r.infraError).toContain('no running pod')
  })

  it('propagates timedOut and truncated from the runner', async () => {
    const runner = execRunner(() => ({
      code: -1,
      stdout: 'partial',
      stderr: '',
      timedOut: true,
      truncated: true,
    }))
    const svc = await reconciledService(runner)
    const r = await svc.runInWorkload('svc-a', 'sleep 999', { timeoutMs: 50 })
    expect(r.ok).toBe(false)
    expect(r.timedOut).toBe(true)
    expect(r.truncated).toBe(true)
  })
})

describe('Service.queryLogs', () => {
  const pipeFile = () => join(root, 'logs', 'svc-a.dev.log')
  const writePipe = (content: string) => {
    mkdirSync(join(root, 'logs'), { recursive: true })
    writeFileSync(pipeFile(), content)
  }

  it('application source reads the pipe file and resumes via cursor', async () => {
    const runner = execRunner(() => ({ code: 0, stdout: '', stderr: '' }))
    const svc = await reconciledService(runner)
    writePipe('boot ok\nlistening on :8000\n')
    const first = await svc.queryLogs('svc-a', { source: 'application' })
    expect(first.source).toBe('application')
    expect(first.lines).toEqual(['boot ok', 'listening on :8000'])
    expect(first.cursor).toMatch(/^f:\d+:\d+$/)

    appendFileSync(pipeFile(), 'request handled\n')
    const second = await svc.queryLogs('svc-a', { source: 'application', cursor: first.cursor })
    expect(second.lines).toEqual(['request handled'])
    expect(second.resync).toBeFalsy()
  })

  it('a stale-generation cursor resyncs from the tail instead of erroring', async () => {
    const runner = execRunner(() => ({ code: 0, stdout: '', stderr: '' }))
    const svc = await reconciledService(runner)
    writePipe('a\nb\nc\n')
    const r = await svc.queryLogs('svc-a', { source: 'application', cursor: 'f:99:4', tail: 2 })
    expect(r.resync).toBe(true)
    expect(r.lines).toEqual(['b', 'c'])
  })

  it('auto picks application when the pipe file exists, devdock when nothing runs', async () => {
    const runner = execRunner(() => ({ code: 0, stdout: '', stderr: '' }), '{"items":[]}')
    const svc = await reconciledService(runner)
    expect((await svc.queryLogs('svc-a')).source).toBe('devdock')
    writePipe('hello\n')
    expect((await svc.queryLogs('svc-a')).source).toBe('application')
  })

  it('devdock source resumes from a hub cursor', async () => {
    const runner = execRunner(() => ({ code: 0, stdout: '', stderr: '' }))
    const svc = await reconciledService(runner)
    await svc.stop('svc-a') // narrates into the hub
    const first = await svc.queryLogs('svc-a', { source: 'devdock' })
    expect(first.lines.length).toBeGreaterThan(0)
    expect(first.cursor).toMatch(/^h:\d+$/)
    const second = await svc.queryLogs('svc-a', { source: 'devdock', cursor: first.cursor })
    expect(second.lines).toEqual([])
  })

  it('container source uses kubectl logs with --since-time on a cursor', async () => {
    const logsCalls: string[][] = []
    const runner = execRunner(
      () => ({ code: 0, stdout: '', stderr: '' }),
      READY_PODS,
      (args) => {
        logsCalls.push(args)
        return { code: 0, stdout: 'line1\nline2\n', stderr: '' }
      },
    )
    const svc = await reconciledService(runner)
    const first = await svc.queryLogs('svc-a', { source: 'container', tail: 50 })
    expect(first.lines).toEqual(['line1', 'line2'])
    expect(first.pod).toBe('svc-a-app-devspace-1')
    expect(first.cursor).toMatch(/^c:/)
    expect(logsCalls[0]).toContain('--tail')

    await svc.queryLogs('svc-a', { source: 'container', cursor: first.cursor })
    expect(logsCalls[1]?.some((a) => a.startsWith('--since-time='))).toBe(true)
  })

  it('contains filters the returned lines', async () => {
    const runner = execRunner(() => ({ code: 0, stdout: '', stderr: '' }))
    const svc = await reconciledService(runner)
    writePipe('ok start\nERROR boom\nok end\n')
    const r = await svc.queryLogs('svc-a', { source: 'application', contains: 'ERROR' })
    expect(r.lines).toEqual(['ERROR boom'])
  })
})

describe('Service.wait', () => {
  const writePipe = (content: string, append = false) => {
    mkdirSync(join(root, 'logs'), { recursive: true })
    const f = join(root, 'logs', 'svc-a.dev.log')
    append ? appendFileSync(f, content) : writeFileSync(f, content)
  }

  it('matches a log line that appears AFTER the wait started', async () => {
    const runner = execRunner(() => ({ code: 0, stdout: '', stderr: '' }))
    const svc = await reconciledService(runner)
    writePipe('old Uvicorn running line must not match\n')
    setTimeout(() => writePipe('INFO: Uvicorn running on :8000\n', true), 60)
    const r = await svc.wait('svc-a', {
      contains: 'Uvicorn running',
      timeoutMs: 3000,
      pollMs: 20,
    })
    expect(r.matched).toBe(true)
    expect(r.reason).toBe('contains')
    expect(r.line).toContain('Uvicorn running on :8000')
    expect(r.cursor).toBeTruthy()
  })

  it('pre-existing lines never match without a cursor — times out instead', async () => {
    const runner = execRunner(() => ({ code: 0, stdout: '', stderr: '' }))
    const svc = await reconciledService(runner)
    writePipe('INFO: Uvicorn running on :8000\n')
    const r = await svc.wait('svc-a', { contains: 'Uvicorn running', timeoutMs: 100, pollMs: 20 })
    expect(r.matched).toBe(false)
    expect(r.reason).toBe('timeout')
  })

  it('matches on status and ready from the reconciled state', async () => {
    const runner = execRunner(() => ({ code: 0, stdout: '', stderr: '' }))
    const svc = await reconciledService(runner)
    const byStatus = await svc.wait('svc-a', { status: 'running_managed', timeoutMs: 1000 })
    expect(byStatus.matched).toBe(true)
    expect(byStatus.reason).toBe('status')
    expect(byStatus.status).toBe('RUNNING_MANAGED')

    const byReady = await svc.wait('svc-a', { ready: true, timeoutMs: 1000 })
    expect(byReady.matched).toBe(true)
    expect(byReady.reason).toBe('ready')
  })

  it('rejects a wait with no condition', async () => {
    const runner = execRunner(() => ({ code: 0, stdout: '', stderr: '' }))
    const svc = await reconciledService(runner)
    await expect(svc.wait('svc-a', {})).rejects.toThrow('at least one condition')
  })
})
