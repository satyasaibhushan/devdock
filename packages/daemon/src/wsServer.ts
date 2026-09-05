// WebSocket streams (spec §13): /events, /repos/:id/logs, /terminals/:tid/attach.
import type { Server } from 'node:http'
import type { CrashEvent, RepoState, Service, TermMode } from '@devdock/core'
import { WebSocket, WebSocketServer } from 'ws'
import type { AccessGate } from './accessGate.js'
import type { Instances } from './instances.js'

/** Attach devdock's websocket endpoints to an existing HTTP server. */
export function attachWs(
  server: Server,
  service: Service,
  gate?: AccessGate,
  instances?: Instances,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    if (
      gate &&
      !gate.authorize({
        authorization: req.headers.authorization,
        host: req.headers.host,
        origin: req.headers.origin,
        remoteAddress: req.socket.remoteAddress,
      })
    ) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const peer = url.pathname.match(/^\/instances\/([a-f0-9-]+)\/api(\/.*)$/)
    if (peer && instances) {
      if (!peer[1] || !peer[2] || !matchRoute(peer[2])) {
        socket.destroy()
        return
      }
      void instances
        .stream(peer[1], `${peer[2]}${url.search}`)
        .then((remote) => {
          const fail = () => {
            remote.terminate()
            socket.destroy()
          }
          remote.once('error', fail)
          socket.once('close', () => remote.terminate())
          remote.once('open', () => {
            if (socket.destroyed) {
              remote.terminate()
              return
            }
            wss.handleUpgrade(req, socket, head, (local) => {
              const send = (
                target: WebSocket,
                data: Buffer | ArrayBuffer | Buffer[],
                binary: boolean,
              ) => {
                if (target.bufferedAmount > 1024 * 1024) {
                  local.terminate()
                  remote.terminate()
                  return
                }
                if (target.readyState === WebSocket.OPEN) target.send(data, { binary })
              }
              remote.on('message', (data, binary) => send(local, data, binary))
              local.on('message', (data, binary) => send(remote, data, binary))
              local.on('close', () => remote.close())
              remote.on('close', () => local.close())
              local.on('error', () => remote.terminate())
            })
          })
        })
        .catch(() => socket.destroy())
      return
    }
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

type Route = { kind: 'events' } | { kind: 'logs'; id: string } | { kind: 'attach'; tid: string }

function matchRoute(pathname: string): Route | undefined {
  if (pathname === '/events') return { kind: 'events' }
  const logs = pathname.match(/^\/repos\/([^/]+)\/logs$/)
  if (logs?.[1]) return { kind: 'logs', id: decodeURIComponent(logs[1]) }
  const att = pathname.match(/^\/terminals\/([^/]+)\/attach$/)
  if (att?.[1]) return { kind: 'attach', tid: decodeURIComponent(att[1]) }
  return undefined
}

function handle(ws: WebSocket, route: Route, url: URL, service: Service): void {
  if (route.kind === 'events') handleEvents(ws, service)
  else if (route.kind === 'logs') handleLogs(ws, service, route.id, url)
  else handleAttach(ws, service, route.tid, url)
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

/** Attach a live viewer to a registered terminal. The socket never owns the
 *  PTY: closing the tab detaches the viewer, the terminal keeps running for
 *  everyone else (other browser windows, agents driving it over HTTP). */
function handleAttach(ws: WebSocket, service: Service, tid: string, url: URL): void {
  const mode: TermMode = url.searchParams.get('mode') === 'rw' ? 'rw' : 'ro'
  let att: ReturnType<Service['attachTerminal']>
  try {
    att = service.attachTerminal(tid, mode, {
      onData: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data)
      },
      // PTY exited (shell exit, pod gone) — end the stream; the UI refreshes
      // its tab list off the close.
      onExit: () => ws.close(),
    })
  } catch (err) {
    send(ws, { type: 'error', error: err instanceof Error ? err.message : String(err) })
    ws.close()
    return
  }
  // Size the PTY to the viewer's fitted grid before replay so tmux redraws
  // full-pane immediately (registered terminals open headless at 200x50).
  const cols = dim(url, 'cols')
  const rows = dim(url, 'rows')
  if (cols && rows) att.resize(cols, rows)
  if (url.searchParams.get('replay') !== '0' && att.replay.length > 0) ws.send(att.replay)
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
          if (Number.isInteger(c) && Number.isInteger(r) && c > 0 && r > 0) att.resize(c, r)
        }
      } catch {
        /* malformed control frame — drop it */
      }
      return
    }
    att.write(text)
  })
  ws.on('error', () => ws.close())
  ws.on('close', () => att.detach())
}
