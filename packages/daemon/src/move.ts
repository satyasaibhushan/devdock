// Moving a deployment between linked machines. The initiating daemon drives it
// so the UI and MCP share one sequence: the owner releases (or, when it cannot
// be reached, the target takes over), then the target optionally starts.

import { type CopiedStartup, copyStartupCommands } from './startup.js'

export interface CallResult {
  status: number
  body: unknown
}
/** A request to an instance's API: this daemon or a linked peer. */
export type InstanceCall = (
  instance: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
) => Promise<CallResult>

export interface CheckoutSummary {
  branch: string | null
  commit: string | null
  dirty: boolean | null
}

export type MoveFollowUp = 'start' | 'build_start' | 'none'

export interface MovePlan {
  repo: string
  workload?: string
  to: string
  owner?: string
  /** The owner answered; otherwise the target takes the claim over. */
  ownerOnline: boolean
  /** The owner has a dev session, which the move should carry over. */
  live: boolean
  from?: CheckoutSummary
  target: CheckoutSummary
  /** Both checkouts are at the same known commit. Uncommitted edits sync either way. */
  sameRevision: boolean
  /** What to run on the target after the move: keep a live session live, and
   *  rebuild the image when the target's code is at a different commit. */
  followUp: MoveFollowUp
}

interface WorkloadView {
  type: string
  hasSession: boolean
  ownerInstanceId?: string
  ownershipKnown?: boolean
}
interface RepoView {
  repo: { id: string; defaultWorkload?: string }
  workloads: WorkloadView[]
}

const query = (workload?: string) => (workload ? `?workload=${encodeURIComponent(workload)}` : '')

function errorOf(result: CallResult, fallback: string): Error {
  const body = result.body as { error?: string; stderr?: string } | undefined
  return new Error(body?.error || body?.stderr || fallback)
}

async function workloadOn(
  call: InstanceCall,
  instance: string,
  repo: string,
  workload?: string,
): Promise<WorkloadView | undefined> {
  const result = await call(instance, 'GET', '/repos').catch(() => undefined)
  if (!result || result.status !== 200 || !Array.isArray(result.body)) return undefined
  const state = (result.body as RepoView[]).find((r) => r.repo.id === repo)
  if (!state) return undefined
  return (
    state.workloads.find((w) => w.type === (workload ?? state.repo.defaultWorkload)) ??
    state.workloads[0]
  )
}

async function checkoutOn(
  call: InstanceCall,
  instance: string,
  repo: string,
  workload?: string,
): Promise<CheckoutSummary | undefined> {
  const result = await call(
    instance,
    'GET',
    `/repos/${encodeURIComponent(repo)}/checkout${query(workload)}`,
  ).catch(() => undefined)
  if (!result || result.status !== 200) return undefined
  const { branch, commit, dirty } = result.body as CheckoutSummary
  return { branch, commit, dirty }
}

export async function planMove(
  call: InstanceCall,
  repo: string,
  workload: string | undefined,
  to: string,
): Promise<MovePlan> {
  const onTarget = await workloadOn(call, to, repo, workload)
  if (!onTarget) throw new Error(`${repo} has no checkout on the target machine`)
  // The target reads the claim itself; a guess here could delete the wrong claim.
  if (onTarget.ownershipKnown === false)
    throw new Error('Ownership unavailable on the target machine. Check its Kubernetes access.')
  const owner = onTarget.ownerInstanceId
  if (owner === to) throw new Error(`${repo} is already on that machine`)
  const onOwner = owner ? await workloadOn(call, owner, repo, workload) : undefined
  const target = await checkoutOn(call, to, repo, workload)
  if (!target) throw new Error('Cannot read the target checkout')
  const from = onOwner && owner ? await checkoutOn(call, owner, repo, workload) : undefined
  const sameRevision = !!from?.commit && from.commit === target.commit
  const live = onOwner?.hasSession === true
  return {
    repo,
    workload,
    to,
    owner,
    ownerOnline: !!onOwner,
    live,
    from,
    target,
    sameRevision,
    followUp: live ? (sameRevision ? 'start' : 'build_start') : 'none',
  }
}

export interface MoveResult {
  plan: MovePlan
  /** How the claim moved; 'unclaimed' when there was nothing to move. */
  claim: 'released' | 'taken_over' | 'unclaimed'
  /** Startup commands the target lacked, copied from the owner. */
  startupCopied: CopiedStartup[]
  operation?: unknown
}

export async function moveDeployment(
  call: InstanceCall,
  repo: string,
  workload: string | undefined,
  to: string,
  requested?: MoveFollowUp,
): Promise<MoveResult> {
  const plan = await planMove(call, repo, workload, to)
  const path = `/repos/${encodeURIComponent(repo)}`
  let claim: MoveResult['claim'] = 'unclaimed'
  if (plan.owner && plan.ownerOnline) {
    const result = await call(plan.owner, 'POST', `${path}/release${query(workload)}`)
    if (result.status !== 200) throw errorOf(result, 'The owner could not release the deployment')
    claim = 'released'
  } else if (plan.owner) {
    const result = await call(to, 'POST', `${path}/take-over${query(workload)}`, {
      from: plan.owner,
    })
    if (result.status !== 200)
      throw errorOf(result, 'The target could not take the deployment over')
    claim = 'taken_over'
  }
  // Before the follow-up, so its start queues the owner's startup command. A
  // failed copy leaves the target's own commands and does not undo the move.
  const startupCopied =
    plan.owner && plan.ownerOnline
      ? await copyStartupCommands(call, plan.owner, to, repo).catch(() => [])
      : []
  const followUp = requested ?? plan.followUp
  if (followUp === 'none') return { plan, claim, startupCopied }
  const started = await call(to, 'POST', `${path}/operations`, { action: followUp, workload })
  if (started.status !== 202 && started.status !== 200)
    throw errorOf(started, `Moved, but ${followUp.replace('_', ' + ')} did not start on the target`)
  return { plan, claim, startupCopied, operation: started.body }
}
