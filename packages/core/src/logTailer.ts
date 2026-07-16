// logTailer — kubectl logs -f → ring buffer → fan-out to subscribers (spec §12).
import type { ChildProcess } from 'node:child_process'
import { LineSplitter, spawnStream } from './exec.js'
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

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI CSI escapes is the point
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

/** Normalize a raw process line for display: drop ANSI styling and keep only
 *  the final \r-overwritten frame (spinner/progress redraws). */
export function cleanLine(line: string): string {
  const plain = line.replace(ANSI_CSI, '').replace(/\r+$/, '')
  return plain.includes('\r') ? (plain.split('\r').pop() ?? '') : plain
}

/** Buffers recent log lines and fans them out; new subscribers get the backlog. */
export class LogHub {
  private readonly ring: RingBuffer<string>
  private readonly subs = new Set<LogSubscriber>()
  /** Total lines ever pushed — the ring holds seqs [seq - size, seq). Lets a
   *  caller resume exactly where it left off via since(). */
  private seq = 0
  constructor(capacity = 1000) {
    this.ring = new RingBuffer<string>(capacity)
  }

  push(line: string): void {
    const clean = cleanLine(line)
    this.ring.push(clean)
    this.seq++
    for (const sub of this.subs) sub(clean)
  }

  /** Lines pushed at or after seq `from` (exclusive of already-seen ones).
   *  `dropped` is true when lines between `from` and the ring's oldest entry
   *  have already been evicted — the caller missed some output. */
  since(from: number): { lines: string[]; nextSeq: number; dropped: boolean } {
    const all = this.ring.toArray()
    const oldest = this.seq - all.length
    const start = Math.max(from, oldest)
    return {
      lines: all.slice(start - oldest),
      nextSeq: this.seq,
      dropped: from < oldest,
    }
  }

  /** Cursor for "everything from now on" — pass to since() later. */
  get currentSeq(): number {
    return this.seq
  }

  /** Subscribe; immediately replays the backlog, then streams live. Returns unsubscribe.
   *  Pass `replay: false` for consumers that must only see new lines (crash detection). */
  subscribe(sub: LogSubscriber, opts: { replay?: boolean } = {}): () => void {
    if (opts.replay !== false) for (const line of this.ring.toArray()) sub(line)
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

export type SpawnFn = (cmd: string, args: string[]) => ChildProcess

/** Tails `kubectl logs -f` for a repo's pod into a LogHub. The hub can be
 *  shared (the repo's single stream of pod logs + verb activity) or owned. */
export class LogTailer {
  readonly hub: LogHub
  private child?: ChildProcess
  private readonly lines: LineSplitter
  constructor(
    private readonly spawnFn: SpawnFn = spawnStream,
    hub?: LogHub,
  ) {
    this.hub = hub ?? new LogHub()
    this.lines = new LineSplitter((line) => this.hub.push(line))
  }

  start(repo: Repo, pod: PodInfo, container?: string): void {
    if (this.child) return
    const args = ['logs', '-f', pod.name]
    if (repo.namespace) args.push('-n', repo.namespace)
    if (container) args.push('-c', container)
    const child = this.spawnFn('kubectl', args)
    child.stdout?.on('data', (d: Buffer) => this.lines.ingest(d.toString()))
    child.stderr?.on('data', (d: Buffer) => this.lines.ingest(d.toString()))
    this.child = child
  }

  stop(): void {
    this.lines.flush()
    this.child?.kill('SIGTERM')
    this.child = undefined
  }
}
