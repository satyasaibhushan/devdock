import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CheckResult, WorkflowAction } from './workflow.js'

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
}

/** Durable receipts, not a job replayer. Only verified dev sessions may be reattached after restart. */
export class Operations {
  private records: Operation[] = []
  constructor(private readonly file: string) {
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
    Object.assign(r, patch, { updatedAt: Date.now() })
    if (message)
      r.logs = [...r.logs, { at: Date.now(), message: message.slice(0, 2000) }].slice(-500)
    this.flush()
    return structuredClone(r)
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
