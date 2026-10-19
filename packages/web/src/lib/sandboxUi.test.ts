import { describe, expect, it } from 'vitest'
import type { SandboxMember, SandboxView } from './api'
import {
  applySandboxEvent,
  builtLabel,
  cardAction,
  cardSentence,
  checkoutLabel,
  expiryLabel,
  memberBuildState,
  memberKey,
  memberPath,
  relativeTime,
  selectedMember,
} from './sandboxUi'

const member = (over: Partial<SandboxMember> = {}): SandboxMember => ({
  repo: 'acs-org',
  workload: 'api',
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
  memberUrls: { 'acs-org:api': 'https://a.example' },
  link: 'http://127.0.0.1:7717/s/SULF-1',
  markdown: '',
  pool: [{ slot: 'sandbox-a', key: 'SULF-1' }],
  expiresAt: 1_000 + 3_600_000,
  ...over,
})

describe('memberPath', () => {
  it('treats an empty field as the repo checkout and trims a path', () => {
    expect(memberPath('  ')).toBeUndefined()
    expect(memberPath(' /w/app ')).toBe('/w/app')
  })
  it('rejects a relative path', () => {
    expect(() => memberPath('w/app')).toThrow('absolute')
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
    const { power: _p, urls: _u, memberUrls: _mu, expiresAt: _e, ...record } = view()
    const [next] = applySandboxEvent([view()], { ...record, lastUsedAt: 2_000 })
    expect(next?.power).toBe('awake')
    expect(next?.urls).toEqual(['https://a.example'])
    expect(next?.memberUrls).toEqual({ 'acs-org:api': 'https://a.example' })
    expect(next?.expiresAt).toBe(2_000 + 3_600_000)
  })
  it('appends an unknown sandbox with placeholder view fields', () => {
    const { power: _p, urls: _u, memberUrls: _mu, expiresAt: _e, ...record } = view({ key: 'NEW' })
    const list = applySandboxEvent([view()], record)
    expect(list.map((s) => s.key)).toEqual(['SULF-1', 'NEW'])
    expect(list[1]).toMatchObject({
      power: 'unknown',
      ribbon: 'unknown',
      link: 'http://127.0.0.1:7717/s/NEW',
      urls: [],
      memberUrls: {},
      expiresAt: 0,
      pool: [{ slot: 'sandbox-a', key: 'SULF-1' }],
    })
  })
})

describe('snapshot cards', () => {
  it('labels what a member builds from and what it baked', () => {
    expect(checkoutLabel({})).toBe('repo checkout')
    expect(checkoutLabel({ path: '/w/app/' })).toBe('app')
    expect(builtLabel('SULF-1-fix', 'a'.repeat(40))).toBe('SULF-1-fix @ aaaaaaa')
    expect(builtLabel(undefined, 'a'.repeat(40))).toBe('aaaaaaa')
    expect(builtLabel('SULF-1-fix', undefined)).toBe('')
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
  it('prioritizes build progress and failure', () => {
    for (const state of ['queued', 'building', 'failed'] as const)
      expect(memberBuildState(member({ build: { state }, deployedSha: 'a' }))).toBe(state)
  })
  it('distinguishes undeployed and deployed members', () => {
    expect(memberBuildState(member())).toBe('not built')
    expect(memberBuildState(member({ deployedSha: 'a' }))).toBe('ready')
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

it('shows failed immediately when a creating sandbox fails before leasing', () => {
  const creating = view({ state: 'creating', ribbon: 'asleep', slot: undefined })
  const [next] = applySandboxEvent([creating], {
    ...creating,
    state: 'failed',
    error: 'All 5 sandbox slots are in use',
  })
  expect(next?.state).toBe('failed')
  expect(next?.ribbon).toBe('failed')
})
