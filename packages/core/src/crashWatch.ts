// crashWatch — detect crashes two ways (spec §10):
//   pod-level   : climbing restartCount / Failed phase
//   process-level: tracebacks & non-zero exit markers in the log stream
import type { PodInfo } from './types.js'

export interface CrashEvent {
  repo: string
  pod: string
  /** What tripped the detector. */
  reason: 'restart' | 'failed' | 'traceback'
  detail: string
  at: number
}

/** Heuristic: does this log line look like a crash/traceback? */
export function looksLikeTraceback(line: string): boolean {
  return (
    /Traceback \(most recent call last\)/.test(line) ||
    /^\s*File ".+", line \d+/.test(line) ||
    /[A-Za-z_]*(?:Error|Exception):/.test(line) ||
    /panic:/.test(line) ||
    /\bsegmentation fault\b/i.test(line) ||
    /process exited with (?:code|status) [1-9]/i.test(line)
  )
}

/** Compare previous vs current pods; a climbing restartCount or Failed phase is a crash. */
export function detectPodCrashes(
  prev: Map<string, number>,
  curr: PodInfo[],
  at: number,
): CrashEvent[] {
  const events: CrashEvent[] = []
  for (const pod of curr) {
    const before = prev.get(pod.name) ?? 0
    if (pod.restartCount > before) {
      events.push({
        repo: '',
        pod: pod.name,
        reason: 'restart',
        detail: `restartCount ${before} → ${pod.restartCount}`,
        at,
      })
    } else if (pod.phase === 'Failed') {
      events.push({ repo: '', pod: pod.name, reason: 'failed', detail: 'pod phase Failed', at })
    }
  }
  return events
}

export type CrashListener = (e: CrashEvent) => void

/** Stateful per-repo crash watcher: feed it reconciled pods and log lines. */
export class CrashWatch {
  private lastRestarts = new Map<string, number>()
  private listeners = new Set<CrashListener>()
  constructor(private readonly repo: string) {}

  onCrash(cb: CrashListener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Feed the latest reconciled pods; emits a crash event on any climb/failure. */
  observePods(pods: PodInfo[], at: number = Date.now()): CrashEvent[] {
    const events = detectPodCrashes(this.lastRestarts, pods, at).map((e) => ({
      ...e,
      repo: this.repo,
    }))
    for (const pod of pods) this.lastRestarts.set(pod.name, pod.restartCount)
    for (const e of events) this.emit(e)
    return events
  }

  /** Feed a log line; emits a crash event if it looks like a traceback. */
  observeLog(pod: string, line: string, at: number = Date.now()): CrashEvent | undefined {
    if (!looksLikeTraceback(line)) return undefined
    const e: CrashEvent = { repo: this.repo, pod, reason: 'traceback', detail: line.trim(), at }
    this.emit(e)
    return e
  }

  private emit(e: CrashEvent): void {
    for (const l of this.listeners) l(e)
  }
}
