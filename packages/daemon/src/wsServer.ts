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
  else if (route.kind === 'logs') handleLogs(ws, service, route.id)
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

function handleLogs(ws: WebSocket, service: Service, id: string): void {
  const unsubscribe = service.subscribeLogs(id, (line) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(line)
  })
  ws.on('close', unsubscribe)
}

function handleTerminal(ws: WebSocket, service: Service, id: string, url: URL): void {
  const mode: TermMode = url.searchParams.get('mode') === 'rw' ? 'rw' : 'ro'
  // The socket can close (or error) before openTerminal() resolves. Track that so
  // the PTY spawned by the pending promise is torn down immediately rather than
  // orphaned — orphaned attaches leak /dev/ptmx slots until the pool is exhausted.
  let socketClosed = false
  ws.on('close', () => {
    socketClosed = true
  })
  ws.on('error', () => ws.close())
  service
    .openTerminal(id, mode)
    .then((term) => {
      if (socketClosed) {
        term.close()
        return
      }
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data)
      })
      ws.on('message', (raw) => term.write(raw.toString()))
      ws.on('close', () => term.close())
    })
    .catch((err: unknown) => {
      send(ws, { type: 'error', error: err instanceof Error ? err.message : String(err) })
      ws.close()
    })
}
