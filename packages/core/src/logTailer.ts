// logTailer — kubectl logs -f → ring buffer → fan-out to subscribers (spec §12).
import type { ChildProcess } from 'node:child_process'
import { spawnStream } from './exec.js'
import type { PodInfo, Repo } from './types.js'

/** Fixed-capacity ring buffer of recent items. */
export class RingBuffer<T> {
  private buf: T[] = []
  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.buf.push(item)
    if (this.buf.length > this.capacity) this.buf.shift()
  }

  toArray(): T[] {
    return [...this.buf]
  }

  get size(): number {
    return this.buf.length
  }
}

export type LogSubscriber = (line: string) => void

/** Buffers recent log lines and fans them out; new subscribers get the backlog. */
export class LogHub {
  private readonly ring: RingBuffer<string>
  private readonly subs = new Set<LogSubscriber>()
  constructor(capacity = 1000) {
    this.ring = new RingBuffer<string>(capacity)
  }

  push(line: string): void {
    this.ring.push(line)
    for (const sub of this.subs) sub(line)
  }

  /** Subscribe; immediately replays the backlog, then streams live. Returns unsubscribe. */
  subscribe(sub: LogSubscriber): () => void {
    for (const line of this.ring.toArray()) sub(line)
    this.subs.add(sub)
    return () => this.subs.delete(sub)
  }

  recent(tail = 200): string[] {
    const all = this.ring.toArray()
    return all.slice(Math.max(0, all.length - tail))
  }

  get subscriberCount(): number {
    return this.subs.size
  }
}

type SpawnFn = (cmd: string, args: string[]) => ChildProcess

/** Tails `kubectl logs -f` for a repo's pod into a LogHub. */
export class LogTailer {
  readonly hub = new LogHub()
  private child?: ChildProcess
  private carry = ''
  constructor(private readonly spawnFn: SpawnFn = spawnStream) {}

  start(repo: Repo, pod: PodInfo, container?: string): void {
    if (this.child) return
    const args = ['logs', '-f', pod.name]
    if (repo.namespace) args.push('-n', repo.namespace)
    if (container) args.push('-c', container)
    const child = this.spawnFn('kubectl', args)
    child.stdout?.on('data', (d: Buffer) => this.ingest(d.toString()))
    child.stderr?.on('data', (d: Buffer) => this.ingest(d.toString()))
    this.child = child
  }

  /** Split incoming chunks on newlines, carrying partial lines across chunks. */
  private ingest(chunk: string): void {
    const text = this.carry + chunk
    const parts = text.split('\n')
    this.carry = parts.pop() ?? ''
    for (const line of parts) this.hub.push(line)
  }

  stop(): void {
    if (this.carry) {
      this.hub.push(this.carry)
      this.carry = ''
    }
    this.child?.kill('SIGTERM')
    this.child = undefined
  }
}
