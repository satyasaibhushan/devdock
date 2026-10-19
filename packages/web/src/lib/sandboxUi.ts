// Pure helpers behind the sandbox views: parsing member sources, deriving the
// small status words the sidebar and detail show, and folding WS events into
// the polled list between refreshes.

import type {
  SandboxEvent,
  SandboxMember,
  SandboxMemberInput,
  SandboxSnapshotMember,
  SandboxView,
} from './api'

/** The daemon's key rule; mirrored so the form can disable Create early. */
export const SANDBOX_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

/** A GitHub PR URL becomes a PR source; anything else is taken as a branch ref. */
export function memberSource(value: string): SandboxMemberInput['source'] {
  const ref = value.trim()
  if (!ref || ref.startsWith('-')) throw new Error('Enter a PR URL or branch')
  if (!/^https?:/i.test(ref)) return { kind: 'branch', ref }
  let url: URL
  try {
    url = new URL(ref)
  } catch {
    throw new Error('Enter a GitHub PR URL')
  }
  const match = url.pathname.match(/^\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !match?.[1] || !match[2])
    throw new Error('Enter a GitHub PR URL')
  return {
    kind: 'pr',
    repoSlug: match[1],
    number: Number(match[2]),
    url: `https://github.com/${match[1]}/pull/${match[2]}`,
  }
}

export const memberKey = (member: { repo: string; workload: string }) =>
  `${member.repo}:${member.workload}`

export function sourceLabel(source: SandboxMemberInput['source']): string {
  if (source.kind === 'pr') return `PR #${source.number}`
  if (source.kind === 'branch') return source.ref
  return `worktree ${source.path.split('/').filter(Boolean).pop() ?? source.path}`
}

export const shortSha = (sha: string | undefined) => (sha ? sha.slice(0, 7) : '')

/** Deployed code is behind the source head (mirrors core's staleMembers). */
export const memberStale = (member: SandboxMember) =>
  !member.merged && (!member.deployedSha || member.deployedSha !== member.headSha)

/** Build progress wins over freshness while a build is pending or failed. */
export function memberBuildState(member: SandboxMember): string {
  if (member.build.state !== 'idle') return member.build.state
  return memberStale(member) ? 'stale' : 'ready'
}

export function selectedMember(members: SandboxMember[], key: string | null): SandboxMember | null {
  return members.find((m) => memberKey(m) === key) ?? members[0] ?? null
}

/** Compact age or countdown: 45s, 22m, 3h, 2d. */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor(Math.abs(at - now) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

export function expiryLabel(sandbox: Pick<SandboxView, 'slot' | 'expiresAt'>, now: number): string {
  if (!sandbox.slot) return 'slot released'
  if (sandbox.expiresAt <= now) return 'expiry due'
  return `expires in ${relativeTime(sandbox.expiresAt, now)}`
}

/** What a snapshot row says next to its sha: dirty files beat head comparison,
 *  and a worktree has no remote head to compare with. */
export function showsCompare(
  saved: SandboxSnapshotMember,
  member: SandboxMember | undefined,
): { text: string; tone: 'ok' | 'warn' | 'dirty' | 'none' } {
  if (saved.dirtyFiles.length)
    return {
      text: `+${saved.dirtyFiles.length} file${saved.dirtyFiles.length === 1 ? '' : 's'}`,
      tone: 'dirty',
    }
  if (!member?.headSha || member.source.kind === 'worktree') return { text: '', tone: 'none' }
  const name = member.source.kind === 'pr' ? 'PR' : 'branch'
  return saved.sha === member.headSha
    ? { text: `= ${name} head`, tone: 'ok' }
    : { text: `behind ${name} head`, tone: 'warn' }
}

/** The card's primary action; the one thing a visitor can do from the grid. */
export type CardAction = 'open' | 'wake' | 'restore' | 'evict' | 'logs' | null
export function cardAction(sandbox: SandboxView): CardAction {
  if (sandbox.personal) return 'open'
  switch (sandbox.ribbon) {
    case 'awake':
      return sandbox.urls.length ? 'open' : 'logs'
    case 'asleep':
    case 'partial':
      return 'wake'
    case 'expired restorable':
      return sandbox.evictionCandidate ? 'evict' : 'restore'
    case 'building':
    case 'failed':
      return 'logs'
    default:
      return null
  }
}

/** The card's one sentence. */
export function cardSentence(sandbox: SandboxView, now: number): string {
  if (sandbox.personal) {
    const repos = new Set(sandbox.members.map((m) => m.repo)).size
    return `Personal namespace with ${repos} repo${repos === 1 ? '' : 's'}.`
  }
  if (sandbox.error) return sandbox.error
  switch (sandbox.ribbon) {
    case 'awake':
      return sandbox.healthy ? 'Up and ready.' : 'Awake; pods are still reporting ready.'
    case 'asleep':
      return `Asleep; ${expiryLabel(sandbox, now)}. Wake takes a minute.`
    case 'partial':
      return 'Some workloads are awake.'
    case 'building':
      return 'Building; the snapshot updates when every member is deployed.'
    case 'expired restorable':
      return sandbox.evictionCandidate
        ? `Pool full; restoring evicts ${sandbox.evictionCandidate}.`
        : 'Expired; the recorded images restore without a rebuild.'
    case 'expired':
      return 'Expired without a retained snapshot; rebuild from its page.'
    case 'failed':
      return 'The last operation failed.'
    default:
      return 'Cluster state unavailable.'
  }
}

/** The daemon's stable link for a key, on the same host as the links it already sent. */
function stableLink(list: SandboxView[], key: string): string {
  const origin = list.find((s) => s.link)?.link.replace(/\/s\/[^/]*$/, '')
  return origin ? `${origin}/s/${encodeURIComponent(key)}` : ''
}

/** Fold a WS `sandbox` event into the last polled list. The event carries the
 *  record, not the view, so cluster-derived fields (power, urls) are kept from
 *  the previous view and expiry slides with lastUsedAt until the next poll. */
export function applySandboxEvent(list: SandboxView[], event: SandboxEvent): SandboxView[] {
  if ('deleted' in event) return list.filter((s) => s.key !== event.key)
  const previous = list.find((s) => s.key === event.key)
  const allMerged = event.members.length > 0 && event.members.every((m) => m.merged === true)
  if (!previous) {
    const ribbon =
      event.state === 'expired' ? 'expired' : event.state === 'failed' ? 'failed' : 'unknown'
    return [
      ...list,
      {
        ...event,
        power: 'unknown',
        healthy: false,
        ribbon,
        urls: [],
        link: stableLink(list, event.key),
        markdown: '',
        pool: list[0]?.pool ?? [],
        expiresAt: 0,
        allMerged,
      },
    ]
  }
  const ttl = previous.expiresAt - previous.lastUsedAt
  const next: SandboxView = {
    ...previous,
    ...event,
    allMerged,
    expiresAt: previous.personal ? previous.expiresAt : event.lastUsedAt + ttl,
  }
  return list.map((s) => (s.key === event.key ? next : s))
}
