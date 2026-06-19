// WebSocket streams (spec §13): /events, /repos/:id/logs, /repos/:id/terminal.
import type { Server } from 'node:http'
import type { CrashEvent, RepoState, Service, TermMode } from '@devdock/core'
import { WebSocket, WebSocketServer } from 'ws'

/** Attach devdock's websocket endpoints to an existing HTTP server. */
export function attachWs(server: Server, service: Service): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = matchRoute(url.pathname)
    if (!route) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handle(ws, route, url, service)
    })
  })

  return wss
}

type Route = { kind: 'events' } | { kind: 'logs'; id: string } | { kind: 'terminal'; id: string }

function matchRoute(pathname: string): Route | undefined {
  if (pathname === '/events') return { kind: 'events' }
  const logs = pathname.match(/^\/repos\/([^/]+)\/logs$/)
  if (logs?.[1]) return { kind: 'logs', id: decodeURIComponent(logs[1]) }
  const term = pathname.match(/^\/repos\/([^/]+)\/terminal$/)
  if (term?.[1]) return { kind: 'terminal', id: decodeURIComponent(term[1]) }
  return undefined
}

function handle(ws: WebSocket, route: Route, url: URL, service: Service): void {
  if (route.kind === 'events') handleEvents(ws, service)
  else if (route.kind === 'logs') handleLogs(ws, service, route.id, url)
  else handleTerminal(ws, service, route.id, url)
}

function send(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
}

function handleEvents(ws: WebSocket, service: Service): void {
  const onStatus = (s: RepoState) => send(ws, { type: 'status', state: s })
  const onCrash = (e: CrashEvent) => send(ws, { type: 'crash', event: e })
  service.events.on('status', onStatus)
  service.events.on('crash', onCrash)
  ws.on('close', () => {
    service.events.off('status', onStatus)
    service.events.off('crash', onCrash)
  })
}

function handleLogs(ws: WebSocket, service: Service, id: string, url: URL): void {
  const workload = url.searchParams.get('workload') ?? undefined
  const unsubscribe = service.subscribeLogs(
    id,
    (line) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(line)
    },
    workload,
  )
  ws.on('close', unsubscribe)
}

/** Control-frame prefix on the terminal socket — everything else is raw keystrokes. */
const TERM_CTL = '\x01'

function dim(url: URL, key: string): number | undefined {
  const n = Number(url.searchParams.get(key))
  return Number.isInteger(n) && n > 0 && n <= 1000 ? n : undefined
}

function handleTerminal(ws: WebSocket, service: Service, id: string, url: URL): void {
  const mode: TermMode = url.searchParams.get('mode') === 'rw' ? 'rw' : 'ro'
  // Open at the client's fitted size so tmux renders the full pane immediately
  // instead of starting at the 80x24 default and redrawing.
  const cols = dim(url, 'cols')
  const rows = dim(url, 'rows')
  const workload = url.searchParams.get('workload') ?? undefined
  // The socket can close (or error) before openTerminal() resolves. Track that so
  // the PTY spawned by the pending promise is torn down immediately rather than
  // orphaned — orphaned attaches leak /dev/ptmx slots until the pool is exhausted.
  let socketClosed = false
  ws.on('close', () => {
    socketClosed = true
  })
  ws.on('error', () => ws.close())
  service
    .openTerminal(id, mode, cols, rows, workload)
    .then((term) => {
      if (socketClosed) {
        term.close()
        return
      }
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data)
      })
      ws.on('message', (raw) => {
        const text = raw.toString()
        if (text.startsWith(TERM_CTL)) {
          // Resize applies in any mode — a read-only viewer still needs the
          // PTY sized to its grid for tmux to redraw correctly.
          try {
            const msg = JSON.parse(text.slice(1))
            if (msg.type === 'resize') {
              const c = Number(msg.cols)
              const r = Number(msg.rows)
              if (Number.isInteger(c) && Number.isInteger(r) && c > 0 && r > 0) term.resize(c, r)
            }
          } catch {
            /* malformed control frame — drop it */
          }
          return
        }
        term.write(text)
      })
      ws.on('close', () => term.close())
    })
    .catch((err: unknown) => {
      send(ws, { type: 'error', error: err instanceof Error ? err.message : String(err) })
      ws.close()
    })
}
