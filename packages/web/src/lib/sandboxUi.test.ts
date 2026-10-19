import { describe, expect, it } from 'vitest'
import type { SandboxMember, SandboxView } from './api'
import {
  applySandboxEvent,
  expiryLabel,
  memberBuildState,
  memberKey,
  memberSource,
  memberStale,
  relativeTime,
  sandboxHint,
  selectedMember,
} from './sandboxUi'

const member = (over: Partial<SandboxMember> = {}): SandboxMember => ({
  repo: 'acs-org',
  workload: 'api',
  source: { kind: 'branch', ref: 'SULF-1' },
  mode: 'built',
  build: { state: 'idle' },
  ...over,
})
const view = (over: Partial<SandboxView> = {}): SandboxView => ({
  key: 'SULF-1',
  slot: 'sandbox-a',
  state: 'active',
  createdAt: 0,
  lastUsedAt: 1_000,
  members: [member()],
  activity: [],
  power: 'awake',
  urls: ['https://a.example'],
  expiresAt: 1_000 + 3_600_000,
  allMerged: false,
  ...over,
})

describe('memberSource', () => {
  it('parses a GitHub PR URL into a PR source', () => {
    expect(memberSource(' https://github.com/vmockinc/acs-org/pull/42/ ')).toEqual({
      kind: 'pr',
      repoSlug: 'vmockinc/acs-org',
      number: 42,
      url: 'https://github.com/vmockinc/acs-org/pull/42',
    })
  })
  it('treats anything that is not a URL as a branch ref', () => {
    expect(memberSource('feature/SULF-1')).toEqual({ kind: 'branch', ref: 'feature/SULF-1' })
  })
  it('rejects empty input, option-like refs and non-PR URLs', () => {
    expect(() => memberSource('  ')).toThrow('Enter a PR URL or branch')
    expect(() => memberSource('--force')).toThrow('Enter a PR URL or branch')
    expect(() => memberSource('https://github.com/vmockinc/acs-org')).toThrow('GitHub PR URL')
    expect(() => memberSource('http://github.com/v/r/pull/1')).toThrow('GitHub PR URL')
    expect(() => memberSource('https://gitlab.com/v/r/pull/1')).toThrow('GitHub PR URL')
  })
})

describe('memberStale', () => {
  it('is stale until the head is deployed, never once merged', () => {
    expect(memberStale(member({ headSha: 'a' }))).toBe(true)
    expect(memberStale(member({ headSha: 'a', deployedSha: 'b' }))).toBe(true)
    expect(memberStale(member({ headSha: 'a', deployedSha: 'a' }))).toBe(false)
    expect(memberStale(member({ headSha: 'a', deployedSha: 'b', merged: true }))).toBe(false)
  })
})

describe('time labels', () => {
  it('picks the largest whole unit', () => {
    expect(relativeTime(0, 30_000)).toBe('30s')
    expect(relativeTime(0, 22 * 60_000)).toBe('22m')
    expect(relativeTime(0, 3 * 3_600_000 + 1)).toBe('3h')
    expect(relativeTime(2 * 86_400_000, 0)).toBe('2d')
  })
  it('explains expiry from the slot and the deadline', () => {
    expect(expiryLabel({ slot: undefined, expiresAt: 5 }, 0)).toBe('slot released')
    expect(expiryLabel({ slot: 'a', expiresAt: 5 }, 5)).toBe('expiry due')
    expect(expiryLabel({ slot: 'a', expiresAt: 22 * 60_000 }, 0)).toBe('expires in 22m')
  })
})

describe('sandboxHint', () => {
  it('ranks building over failed over stale, and says nothing when current', () => {
    const stale = member({ headSha: 'a', deployedSha: 'b' })
    expect(
      sandboxHint({ slot: 'a', members: [stale, member({ build: { state: 'queued' } })] }),
    ).toBe('building')
    expect(
      sandboxHint({ slot: 'a', members: [stale, member({ build: { state: 'failed' } })] }),
    ).toBe('build failed')
    expect(sandboxHint({ slot: 'a', members: [stale] })).toBe('stale')
    expect(sandboxHint({ slot: undefined, members: [stale] })).toBeNull()
    expect(
      sandboxHint({ slot: 'a', members: [member({ headSha: 'a', deployedSha: 'a' })] }),
    ).toBeNull()
  })
})

describe('applySandboxEvent', () => {
  it('removes a deleted sandbox', () => {
    expect(applySandboxEvent([view(), view({ key: 'X' })], { key: 'X', deleted: true })).toEqual([
      view(),
    ])
  })
  it('keeps cluster-derived fields and slides expiry with lastUsedAt', () => {
    const { power: _p, urls: _u, expiresAt: _e, allMerged: _m, ...record } = view()
    const [next] = applySandboxEvent([view()], {
      ...record,
      lastUsedAt: 2_000,
      members: [member({ merged: true })],
    })
    expect(next?.power).toBe('awake')
    expect(next?.urls).toEqual(['https://a.example'])
    expect(next?.expiresAt).toBe(2_000 + 3_600_000)
    expect(next?.allMerged).toBe(true)
  })
  it('appends an unknown sandbox with placeholder view fields', () => {
    const { power: _p, urls: _u, expiresAt: _e, allMerged: _m, ...record } = view({ key: 'NEW' })
    const list = applySandboxEvent([view()], record)
    expect(list.map((s) => s.key)).toEqual(['SULF-1', 'NEW'])
    expect(list[1]).toMatchObject({ power: 'unknown', urls: [], expiresAt: 0 })
  })
})

describe('memberBuildState', () => {
  it('prioritizes build progress and failure over stale code', () => {
    for (const state of ['queued', 'building', 'failed'] as const) {
      expect(memberBuildState(member({ build: { state }, headSha: 'a' }))).toBe(state)
    }
  })
  it('distinguishes undeployed, stale, current and merged members', () => {
    expect(memberBuildState(member())).toBe('stale')
    expect(memberBuildState(member({ headSha: 'a', deployedSha: 'b' }))).toBe('stale')
    expect(memberBuildState(member({ headSha: 'a', deployedSha: 'a' }))).toBe('ready')
    expect(memberBuildState(member({ merged: true }))).toBe('ready')
  })
})

describe('selectedMember', () => {
  it('selects a workload independently within the same repo', () => {
    const api = member()
    const worker = member({ workload: 'worker' })
    expect(selectedMember([api, worker], memberKey(worker))).toBe(worker)
  })
  it('falls back after removal or an invalid URL selection and handles an empty sandbox', () => {
    const first = member({ workload: '' })
    expect(selectedMember([first], null)).toBe(first)
    expect(selectedMember([first], 'removed:api')).toBe(first)
    expect(selectedMember([first], memberKey(first))).toBe(first)
    expect(selectedMember([], 'removed:api')).toBeNull()
  })
})
