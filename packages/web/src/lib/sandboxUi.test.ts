import { describe, expect, it } from 'vitest'
import type { SandboxMember, SandboxView } from './api'
import {
  applySandboxEvent,
  cardAction,
  cardSentence,
  expiryLabel,
  memberBuildState,
  memberKey,
  memberSource,
  memberStale,
  relativeTime,
  selectedMember,
  showsCompare,
  sourceLabel,
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
  healthy: true,
  ribbon: 'awake',
  urls: ['https://a.example'],
  link: 'http://127.0.0.1:7717/s/SULF-1',
  markdown: '',
  pool: [{ slot: 'sandbox-a', key: 'SULF-1' }],
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
    expect(list[1]).toMatchObject({
      power: 'unknown',
      ribbon: 'unknown',
      link: 'http://127.0.0.1:7717/s/NEW',
      urls: [],
      expiresAt: 0,
      pool: [{ slot: 'sandbox-a', key: 'SULF-1' }],
    })
  })
})

describe('snapshot cards', () => {
  const saved = {
    repo: 'acs-org',
    workload: 'api',
    sha: 'a'.repeat(40),
    dirtyFiles: [],
    image: 'i',
  }
  it('compares a snapshot row with its source head, dirty files first', () => {
    expect(showsCompare(saved, member({ headSha: saved.sha }))).toEqual({
      text: '= branch head',
      tone: 'ok',
    })
    expect(showsCompare(saved, member({ headSha: 'b'.repeat(40) }))).toEqual({
      text: 'behind branch head',
      tone: 'warn',
    })
    expect(showsCompare({ ...saved, dirtyFiles: ['x'] }, member({ headSha: saved.sha }))).toEqual({
      text: '+1 file',
      tone: 'dirty',
    })
    expect(
      showsCompare(
        saved,
        member({ headSha: saved.sha, source: { kind: 'worktree', path: '/w/app' } }),
      ),
    ).toEqual({ text: '', tone: 'none' })
    expect(sourceLabel({ kind: 'worktree', path: '/w/app/' })).toBe('worktree app')
  })
  it('picks one primary action per ribbon', () => {
    expect(cardAction(view())).toBe('open')
    expect(cardAction(view({ urls: [] }))).toBe('logs')
    expect(cardAction(view({ ribbon: 'asleep' }))).toBe('wake')
    expect(cardAction(view({ ribbon: 'expired restorable' }))).toBe('restore')
    expect(cardAction(view({ ribbon: 'expired restorable', evictionCandidate: 'X' }))).toBe('evict')
    expect(cardAction(view({ ribbon: 'expired' }))).toBe(null)
    expect(cardAction(view({ ribbon: 'failed' }))).toBe('logs')
    expect(cardAction(view({ ribbon: 'building' }))).toBe('logs')
  })
  it('leads the sentence with the recorded error', () => {
    expect(cardSentence(view({ ribbon: 'failed', error: 'Build failed' }), 0)).toBe('Build failed')
    expect(
      cardSentence(view({ ribbon: 'expired restorable', evictionCandidate: 'X' }), 0),
    ).toContain('evicts X')
    expect(cardSentence(view({ personal: true }), 0)).toBe('Personal namespace with 1 repo.')
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
