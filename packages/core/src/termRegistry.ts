// termRegistry — daemon-owned terminal sessions with ids and scrollback. This
// is the ONLY kind of terminal devdock has: the MCP drives them
// request/response (run/read), and interactive viewers (the web UI) attach to
// the same sessions live via subscribe/write — so every terminal is visible
// to every client, none is private to one browser tab. The registry never
// spawns PTYs itself; callers hand it TermSessions from the PtyBroker.
import { type TermSession, isWheelReport } from './ptyBroker.js'
import type { TermMode } from './types.js'

/** How long a terminal may sit unused (no run/read) before the sweep reaps
 *  it — agent-opened terminals must not pile up forever. */
const IDLE_REAP_MS = 30 * 60 * 1000
/** Grace before a dead (PTY exited) terminal's scrollback is reaped. */
const DEAD_REAP_MS = 60 * 1000
/** Scrollback kept per terminal, in raw PTY bytes (~ a few thousand lines). */
const SCROLLBACK_BYTES = 256 * 1024
/** `run` resolves once the PTY has been silent this long — a raw PTY has no
 *  "command finished" signal (the foreground process may not even be a shell),
 *  so quiescence is the universal end-of-output heuristic. */
const RUN_QUIET_MS = 800
/** How often `run` checks the buffer for growth. */
const RUN_POLL_MS = 100
const RUN_DEFAULT_TIMEOUT_MS = 20_000
export const RUN_MAX_TIMEOUT_MS = 120_000

export type TermKind = 'auto' | 'shell' | 'local'
/** What the terminal's PTY is actually connected to: the repo's tmux dev
 *  session, a `devspace enter` pod shell, or a login shell on the host. */
export type TermAttachTarget = 'tmux' | 'pod' | 'host'

export interface TermInfo {
  id: string
  /** Repo the terminal is scoped to; absent for `local` host shells. */
  repo?: string
  workload?: string
  kind: TermKind
  attach: TermAttachTarget
  createdAt: number
  lastUsedAt: number
  /** False once the underlying PTY exited; scrollback stays readable until reaped. */
  alive: boolean
  /** Live viewers currently attached (web terminals streaming this session). */
  attached: number
}

/** A live viewer's handle on a terminal (what a web terminal socket holds). */
export interface TermAttachment {
  /** Raw scrollback at attach time — write it to the viewer before live data. */
  replay: string
  /** Forward viewer input. `ro` attachments let mouse-wheel reports through
   *  (scrolling) and drop everything else — same rule the broker applies. */
  write(data: string): void
  resize(cols: number, rows: number): void
  detach(): void
}

export interface RunOutcome {
  /** Cleaned output produced between the keystrokes and quiescence. */
  output: string
  /** True when timeoutMs elapsed while output was still flowing — the command
   *  is likely still running; poll with `read` for the rest. */
  timedOut: boolean
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes is the point
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC (title/hyperlink) sequences
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: two-byte escapes (keypad modes, charset)
const ESC2 = /\x1b[@-Z\\-_=><]/g

/** Render raw PTY bytes as plain text: drop styling/control sequences and
 *  collapse \r-overwritten frames (progress bars, spinners) to the last one. */
export function renderPtyText(raw: string): string {
  const plain = raw.replace(OSC, '').replace(CSI, '').replace(ESC2, '')
  return plain
    .split('\n')
    .map((line) => {
      const l = line.replace(/\r+$/, '')
      return l.includes('\r') ? (l.split('\r').pop() ?? '') : l
    })
    .join('\n')
}

interface Watcher {
  onData: (data: string) => void
  onExit?: () => void
}

interface Entry {
  info: TermInfo
  session: TermSession
  buffer: string
  /** True while a `run` is collecting output — one at a time per terminal. */
  running: boolean
  /** Live viewers streaming this session (web terminal sockets). */
  watchers: Set<Watcher>
}

export class TermRegistry {
  private readonly entries = new Map<string, Entry>()
  /** Per-scope counters: each repo/workload (and the host) numbers its own
   *  terminals t1, t2, … so ids read naturally inside one workload's panel. */
  private readonly seq = new Map<string, number>()

  /** Track a freshly opened session under a new id. Ids are scope-qualified
   *  (`jobs-ui:t1`, `repo.workload:t1`, `host:t1`) — globally unique for
   *  agents, while the short `tN` tail numbers within the workload. The
   *  registry owns the onData subscription; scrollback, run-capture and
   *  attached viewers all feed off that one stream. */
  add(
    meta: { repo?: string; workload?: string; kind: TermKind; attach: TermAttachTarget },
    session: TermSession,
  ): TermInfo {
    const scope = meta.repo ? (meta.workload ? `${meta.repo}.${meta.workload}` : meta.repo) : 'host'
    const n = (this.seq.get(scope) ?? 0) + 1
    this.seq.set(scope, n)
    const id = `${scope}:t${n}`
    const now = Date.now()
    const entry: Entry = {
      info: { id, ...meta, createdAt: now, lastUsedAt: now, alive: true, attached: 0 },
      session,
      buffer: '',
      running: false,
      watchers: new Set(),
    }
    session.onData((data) => {
      entry.buffer = (entry.buffer + data).slice(-SCROLLBACK_BYTES)
      for (const w of entry.watchers) w.onData(data)
    })
    session.onExit?.(() => {
      entry.info.alive = false
      for (const w of entry.watchers) w.onExit?.()
    })
    this.entries.set(id, entry)
    return this.snapshot(entry)
  }

  list(): TermInfo[] {
    return [...this.entries.values()].map((e) => this.snapshot(e))
  }

  /** The first live terminal matching (kind, repo, workload) — how `auto`
   *  terminals are deduped so the UI and agents share one dev-session view. */
  findLive(kind: TermKind, repo?: string, workload?: string): TermInfo | undefined {
    for (const e of this.entries.values()) {
      if (!e.info.alive) continue
      if (e.info.kind === kind && e.info.repo === repo && e.info.workload === workload) {
        return this.snapshot(e)
      }
    }
    return undefined
  }

  /**
   * Attach a live viewer: replay the scrollback, then stream every subsequent
   * byte to `onData`. Attaching doesn't lock anything — any number of viewers
   * (ro or rw) can watch one terminal; detaching never kills the session.
   */
  attach(id: string, mode: TermMode, watcher: Watcher): TermAttachment {
    const e = this.entryOrThrow(id)
    if (!e.info.alive) throw new Error(`terminal ${id} has exited`)
    e.watchers.add(watcher)
    e.info.lastUsedAt = Date.now()
    return {
      replay: e.buffer,
      write: (data) => {
        if (mode === 'rw' || isWheelReport(data)) {
          e.session.write(data)
          e.info.lastUsedAt = Date.now()
        }
      },
      resize: (cols, rows) => e.session.resize(cols, rows),
      detach: () => {
        e.watchers.delete(watcher)
        // idle clock restarts at detach, so the sweep counts from the moment
        // the last viewer left, not from the last keystroke hours ago
        e.info.lastUsedAt = Date.now()
      },
    }
  }

  /** The last `tail` lines of cleaned scrollback. */
  read(id: string, tail = 200): string {
    const e = this.entryOrThrow(id)
    e.info.lastUsedAt = Date.now()
    const lines = renderPtyText(e.buffer).split('\n')
    return lines.slice(Math.max(0, lines.length - tail)).join('\n')
  }

  /**
   * Type `command` into the terminal and collect output until the PTY goes
   * quiet (RUN_QUIET_MS without buffer growth) or `timeoutMs` elapses. Polls
   * the scrollback buffer rather than subscribing a second data listener —
   * TermSession has no unsubscribe, so per-run listeners would accumulate.
   * One run at a time per terminal: interleaved keystrokes would corrupt both
   * captures.
   */
  async run(id: string, command: string, timeoutMs = RUN_DEFAULT_TIMEOUT_MS): Promise<RunOutcome> {
    const e = this.entryOrThrow(id)
    if (!e.info.alive) throw new Error(`terminal ${id} has exited`)
    if (e.running) throw new Error(`terminal ${id} is busy running another command`)
    e.running = true
    const capped = Math.min(Math.max(1, timeoutMs), RUN_MAX_TIMEOUT_MS)
    const from = e.buffer.length
    const startedAt = Date.now()

    try {
      e.session.write(`${command}\r`)
      const timedOut = await new Promise<boolean>((resolve) => {
        let lastLen = e.buffer.length
        let lastGrowth = Date.now()
        const poll = setInterval(() => {
          const now = Date.now()
          if (e.buffer.length !== lastLen) {
            lastLen = e.buffer.length
            lastGrowth = now
          }
          if (!e.info.alive || now - lastGrowth >= RUN_QUIET_MS) {
            clearInterval(poll)
            resolve(false)
          } else if (now - startedAt >= capped) {
            clearInterval(poll)
            resolve(true)
          }
        }, RUN_POLL_MS)
        poll.unref?.()
      })
      return { output: renderPtyText(e.buffer.slice(from)).trim(), timedOut }
    } finally {
      e.running = false
      e.info.lastUsedAt = Date.now()
    }
  }

  close(id: string): void {
    const e = this.entryOrThrow(id)
    e.session.close()
    this.entries.delete(id)
  }

  closeAll(): void {
    for (const e of this.entries.values()) e.session.close()
    this.entries.clear()
  }

  /** Reap terminals idle past `idleMs`, and dead ones past a short grace.
   *  A terminal with live viewers attached is in use — never reaped. */
  sweep(idleMs = IDLE_REAP_MS, now = Date.now()): void {
    for (const [id, e] of this.entries) {
      if (e.running || (e.watchers.size > 0 && e.info.alive)) continue
      const idle = now - e.info.lastUsedAt
      if (idle >= idleMs || (!e.info.alive && idle >= DEAD_REAP_MS)) {
        e.session.close()
        this.entries.delete(id)
      }
    }
  }

  private snapshot(e: Entry): TermInfo {
    return { ...e.info, attached: e.watchers.size }
  }

  private entryOrThrow(id: string): Entry {
    const e = this.entries.get(id)
    if (!e) throw new Error(`unknown terminal: ${id}`)
    return e
  }
}
