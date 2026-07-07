import { mkdtempSync, rmSync } from 'node:fs'
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
    expect(new StateStore(file).getStatus('nope')).toBeUndefined()
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

  it('round-trips session-namespace pins and clears them with undefined', () => {
    const s = new StateStore(file)
    s.setSessionNamespace('repo-a::api', 'panels')
    expect(new StateStore(file).getSessionNamespace('repo-a::api')).toBe('panels')
    s.setSessionNamespace('repo-a::api', undefined)
    expect(new StateStore(file).getSessionNamespace('repo-a::api')).toBeUndefined()
  })
})
