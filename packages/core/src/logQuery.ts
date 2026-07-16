// Cursors for incremental log reads (spec: devdock_logs source/cursor).
// Modeled on the Kubernetes watch resourceVersion pattern: the cursor is an
// opaque string minted by the daemon; passing it back returns only what
// happened since, plus a fresh cursor. A stale/invalid cursor never errors —
// it resyncs from the tail and says so via `resync`.
import { closeSync, openSync, readSync, statSync } from 'node:fs'

/** Where a cursor points. `file` = the tmux pipe-pane file (byte offset +
 *  generation, bumped whenever start() truncates the file). `hub` = a LogHub
 *  seq. `container` = a kubectl --since-time timestamp. */
export type Cursor =
  | { kind: 'file'; gen: number; offset: number }
  | { kind: 'hub'; seq: number }
  | { kind: 'container'; sinceTime: string }

export function encodeCursor(c: Cursor): string {
  switch (c.kind) {
    case 'file':
      return `f:${c.gen}:${c.offset}`
    case 'hub':
      return `h:${c.seq}`
    case 'container':
      return `c:${c.sinceTime}`
  }
}

/** Returns undefined for anything unparseable — callers treat that as
 *  "no cursor" and resync rather than failing the read. */
export function decodeCursor(s: string | undefined): Cursor | undefined {
  if (!s) return undefined
  const fm = /^f:(\d+):(\d+)$/.exec(s)
  if (fm) return { kind: 'file', gen: Number(fm[1]), offset: Number(fm[2]) }
  const hm = /^h:(\d+)$/.exec(s)
  if (hm) return { kind: 'hub', seq: Number(hm[1]) }
  if (s.startsWith('c:')) {
    const t = s.slice(2)
    return Number.isNaN(Date.parse(t)) ? undefined : { kind: 'container', sinceTime: t }
  }
  return undefined
}

export interface FileSlice {
  lines: string[]
  /** Byte offset to resume from (end of the last complete line consumed). */
  nextOffset: number
  /** True when the slice was capped and older bytes were skipped. */
  truncated: boolean
}

/** Read complete lines from `offset` to EOF, capped at `maxBytes` (keeping the
 *  TAIL when over — recent output is the informative part). A trailing partial
 *  line is left for the next read, so nextOffset always lands on a line
 *  boundary. Returns undefined when the file is missing. */
export function readFileSlice(
  path: string,
  offset: number,
  maxBytes = 512 * 1024,
): FileSlice | undefined {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return undefined
  }
  // File shrank under us (truncation the generation counter didn't catch,
  // e.g. daemon restart lost the gen map) — resync from the start.
  let from = offset > size ? 0 : offset
  let truncated = false
  if (size - from > maxBytes) {
    from = size - maxBytes
    truncated = true
  }
  if (from >= size) return { lines: [], nextOffset: size, truncated: false }

  const fd = openSync(path, 'r')
  let text: string
  try {
    const buf = Buffer.alloc(size - from)
    const n = readSync(fd, buf, 0, buf.length, from)
    text = buf.toString('utf8', 0, n)
  } finally {
    closeSync(fd)
  }

  const parts = text.split('\n')
  const partial = parts.pop() ?? '' // trailing partial (or '' if text ends in \n)
  if (truncated && parts.length) parts.shift() // first "line" is a mid-line fragment
  return {
    lines: parts,
    nextOffset: from + Buffer.byteLength(text) - Buffer.byteLength(partial),
    truncated,
  }
}
