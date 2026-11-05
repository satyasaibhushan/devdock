import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { cleanLine } from './logTailer.js'
import type { CheckResult, WorkflowAction } from './workflow.js'

export const OPERATION_PHASES = ['build', 'imagePull', 'helm', 'rollout', 'ready'] as const
export type OperationPhase = (typeof OPERATION_PHASES)[number]
type PhaseTiming = { durationMs: number; startedAt?: number }

export type OperationStage =
  | 'checking'
  | 'deploying'
  | 'starting'
  | 'stopping'
  | 'waiting'
  | 'verifying'
export interface Operation {
  id: string
  repo: string
  workload: string
  namespace: string
  action: WorkflowAction
  state: 'active' | 'succeeded' | 'failed' | 'interrupted'
  stage: OperationStage
  createdAt: number
  updatedAt: number
  checks: CheckResult[]
  logs: { at: number; message: string }[]
  release?: string
  phases?: Partial<Record<OperationPhase, PhaseTiming>>
}

/** Durable receipts, not a job replayer. Only verified dev sessions may be reattached after restart. */
export class Operations {
  private records: Operation[] = []
  constructor(
    private readonly file: string,
    private readonly release = process.env.DEVDOCK_RELEASE ??
      /\/releases\/([^/]+)\//.exec(process.argv[1] ?? '')?.[1] ??
      'development',
  ) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Operation[]
      if (!Array.isArray(parsed) || parsed.some((r) => !r.id || !Array.isArray(r.logs)))
        throw new Error('Invalid operation history')
      this.records = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Cannot read operation history; refusing to lose active work')
    }
  }
  list(repo?: string): Operation[] {
    return structuredClone(this.records.filter((r) => !repo || r.repo === repo))
  }
  get(id: string): Operation {
    const record = this.records.find((r) => r.id === id)
    if (!record) throw new Error('Unknown operation')
    return structuredClone(record)
  }
  active(repo: string, workload: string): Operation | undefined {
    return this.list(repo).find((r) => r.workload === workload && r.state === 'active')
  }
  create(repo: string, workload: string, namespace: string, action: WorkflowAction): Operation {
    const prior = this.active(repo, workload)
    if (prior) {
      if (prior.action !== action || prior.namespace !== namespace)
        throw new Error(`Workload already has active operation ${prior.id}`)
      return prior
    }
    const now = Date.now()
    const record: Operation = {
      id: randomUUID(),
      repo,
      workload,
      namespace,
      action,
      state: 'active',
      stage: 'checking',
      createdAt: now,
      updatedAt: now,
      checks: [],
      logs: [],
      release: this.release,
      phases: {},
    }
    this.records.push(record)
    try {
      this.flush()
    } catch (error) {
      this.records.pop()
      throw error
    }
    return structuredClone(record)
  }
  update(
    id: string,
    patch: Partial<Pick<Operation, 'stage' | 'state' | 'checks'>>,
    message?: string,
  ): Operation {
    const r = this.records.find((entry) => entry.id === id)
    if (!r) throw new Error('Unknown operation')
    const finished = r.state === 'active' && patch.state !== undefined && patch.state !== 'active'
    const previous = structuredClone(r)
    Object.assign(r, patch, { updatedAt: Date.now() })
    if (message)
      r.logs = [...r.logs, { at: Date.now(), message: message.slice(0, 2000) }].slice(-500)
    if (finished) {
      for (const phase of OPERATION_PHASES) this.closePhase(r, phase)
      mkdirSync(dirname(this.file), { recursive: true })
      try {
        // Independent of receipt retention. No commands, logs, or credentials.
        appendFileSync(
          `${this.file}.timings.jsonl`,
          `${JSON.stringify({
            schemaVersion: 1,
            id: r.id,
            kind: r.action,
            service: r.repo,
            workload: r.workload,
            namespace: r.namespace,
            release: r.release ?? 'unknown',
            state: r.state,
            createdAt: r.createdAt,
            finishedAt: r.updatedAt,
            totalMs: r.updatedAt - r.createdAt,
            phasesMs: Object.fromEntries(
              OPERATION_PHASES.map((phase) => [phase, r.phases?.[phase]?.durationMs ?? null]),
            ),
          })}\n`,
          { mode: 0o600 },
        )
      } catch (error) {
        Object.assign(r, previous)
        throw error
      }
    }
    this.flush()
    return structuredClone(r)
  }

  phase(id: string, phase: OperationPhase, event: 'start' | 'end'): void {
    const record = this.records.find((r) => r.id === id)
    if (!record || record.state !== 'active') return
    record.phases ??= {}
    const prior = record.phases[phase]
    if (event === 'start') {
      if (prior?.startedAt !== undefined) return
      record.phases[phase] = { durationMs: prior?.durationMs ?? 0, startedAt: Date.now() }
    } else {
      if (prior?.startedAt === undefined) return
      this.closePhase(record, phase)
    }
    this.flush()
  }

  /** DevSpace emits these boundaries on both deploy output and dev-pane logs. */
  observeLine(id: string, raw: string): void {
    const line = cleanLine(raw)
    if (/\bBuilding image\b/i.test(line)) this.phase(id, 'build', 'start')
    if (/\bSuccessfully built\b|\bSkipping build\b/i.test(line)) this.phase(id, 'build', 'end')
    if (/\bDeploying chart\b.*\bhelm\b/i.test(line)) {
      this.phase(id, 'build', 'end')
      this.phase(id, 'helm', 'start')
    }
    if (/\bDeployed helm chart\b|\bSuccessfully deployed\b.*\bhelm\b/i.test(line))
      this.phase(id, 'helm', 'end')
  }

  private closePhase(record: Operation, phase: OperationPhase): void {
    const timing = record.phases?.[phase]
    if (timing?.startedAt === undefined) return
    timing.durationMs += Math.max(0, Date.now() - timing.startedAt)
    timing.startedAt = undefined
  }
  private flush(): void {
    const active = this.records.filter((r) => r.state === 'active')
    const done = this.records.filter((r) => r.state !== 'active').slice(-100)
    this.records = [...done, ...active]
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(this.records), { mode: 0o600 })
    renameSync(temp, this.file)
  }
}
