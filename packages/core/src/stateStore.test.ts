import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StateStore } from './stateStore.js'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devdock-'))
  file = join(dir, 'state.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('StateStore', () => {
  it('persists status across instances', () => {
    new StateStore(file).setStatus('repo-a', 'RUNNING_MANAGED')
    expect(new StateStore(file).getStatus('repo-a')).toBe('RUNNING_MANAGED')
  })

  it('keeps one grant per repo and can revoke', () => {
    const s = new StateStore(file)
    s.setGrant('repo-a', 'ro', 1)
    s.setGrant('repo-a', 'rw', 2)
    expect(s.getGrant('repo-a')).toEqual({ repo: 'repo-a', mode: 'rw', issuedAt: 2 })
    s.revokeGrant('repo-a')
    expect(s.getGrant('repo-a')).toBeUndefined()
  })

  it('tolerates a missing/corrupt file', () => {
    writeFileSync(file, '{broken')
    expect(new StateStore(file).getStatus('nope')).toBeUndefined()
    expect(readdirSync(dir).some((name) => name.startsWith('state.json.corrupt-'))).toBe(true)
  })

  it('writes atomically and skips unchanged state', () => {
    const s = new StateStore(file)
    s.setStatus('repo-a', 'STOPPED')
    const first = readFileSync(file, 'utf8')
    const inode = statSync(file).ino
    s.setStatus('repo-a', 'STOPPED')
    expect(readFileSync(file, 'utf8')).toBe(first)
    expect(statSync(file).ino).toBe(inode)
    expect(readdirSync(dir).some((name) => name.includes('.tmp-'))).toBe(false)
    expect(s.health()).toEqual({ ok: true })
  })

  it('keeps operating and reports degraded health when persistence fails', () => {
    const blocker = join(dir, 'not-a-directory')
    writeFileSync(blocker, 'x')
    const s = new StateStore(join(blocker, 'state.json'))
    expect(() => s.setStatus('repo-a', 'STOPPED')).not.toThrow()
    expect(s.getStatus('repo-a')).toBe('STOPPED')
    expect(s.health()).toMatchObject({ ok: false })
    expect(existsSync(join(blocker, 'state.json'))).toBe(false)
  })

  it('remembers namespaces once each, preserving order', () => {
    const s = new StateStore(file)
    s.rememberNamespace('saibhushan')
    s.rememberNamespace('saibhushan')
    s.rememberNamespace('panels')
    s.rememberNamespace('  ') // junk is ignored
    expect(new StateStore(file).getNamespaces()).toEqual(['saibhushan', 'panels'])
  })

  it('round-trips pending startup commands and clears them with undefined', () => {
    const s = new StateStore(file)
    s.setPendingStartup('repo-a::api', 'pnpm run dev')
    expect(new StateStore(file).getPendingStartup('repo-a::api')).toBe('pnpm run dev')
    s.setPendingStartup('repo-a::api', undefined)
    expect(new StateStore(file).getPendingStartup('repo-a::api')).toBeUndefined()
  })

  it('stores distinct startup commands by pod type', () => {
    const s = new StateStore(file)
    const types = ['api', 'worker']
    s.setStartup('repo-a', 'api', 'pnpm api', types)
    s.setStartup('repo-a', 'worker', 'pnpm worker', types)
    expect(new StateStore(file).getStartupCommands('repo-a', types)).toEqual({
      api: 'pnpm api',
      worker: 'pnpm worker',
    })
  })

  it('expands a legacy repo command before a type-specific edit', () => {
    writeFileSync(file, JSON.stringify({ startup: { 'repo-a': 'pnpm legacy' } }))
    const s = new StateStore(file)
    s.setStartup('repo-a', 'worker', 'pnpm worker', ['api', 'worker'])
    expect(new StateStore(file).getStartupCommands('repo-a', ['api', 'worker'])).toEqual({
      api: 'pnpm legacy',
      worker: 'pnpm worker',
    })
  })

  it('round-trips session-namespace pins and clears them with undefined', () => {
    const s = new StateStore(file)
    s.setSessionNamespace('repo-a::api', 'panels')
    expect(new StateStore(file).getSessionNamespace('repo-a::api')).toBe('panels')
    s.setSessionNamespace('repo-a::api', undefined)
    expect(new StateStore(file).getSessionNamespace('repo-a::api')).toBeUndefined()
  })

  it('persists replica records across instances, updates and removes them', () => {
    const record = {
      id: 'svc-r1',
      parentId: 'svc',
      branch: 'feature-x',
      path: '/repos/svc/.agents/replicas/svc-r1',
      createdAt: 123,
      configPaths: ['/repos/svc/.agents/replicas/svc-r1/.devspace/svc-r1-api/devspace.yaml'],
    }
    new StateStore(file).addReplica(record)
    const s = new StateStore(file)
    expect(s.listReplicas()).toEqual([record])
    expect(s.getReplica('svc-r1')).toEqual(record)
    s.updateReplica('svc-r1', { ingressApplied: true, ingressName: 'svc-r1-alias' })
    expect(new StateStore(file).getReplica('svc-r1')?.ingressApplied).toBe(true)
    s.updateReplica('unknown', { ingressApplied: true }) // no-op, no throw
    s.removeReplica('svc-r1')
    expect(new StateStore(file).listReplicas()).toEqual([])
  })

  it('loads a pre-replica state file with an empty replica set', () => {
    writeFileSync(file, JSON.stringify({ status: { 'repo-a': 'STOPPED' } }))
    expect(new StateStore(file).listReplicas()).toEqual([])
  })

  it('copies startup commands to a replica id and can clear them', () => {
    const s = new StateStore(file)
    s.setStartup('svc', 'api', 'python main.py', ['api'])
    s.copyStartup('svc', 'svc-r1')
    expect(new StateStore(file).getStartup('svc-r1', 'api')).toBe('python main.py')
    s.clearStartup('svc-r1')
    expect(new StateStore(file).getStartup('svc-r1', 'api')).toBeUndefined()
    expect(s.getStartup('svc', 'api')).toBe('python main.py') // parent untouched
  })
})
