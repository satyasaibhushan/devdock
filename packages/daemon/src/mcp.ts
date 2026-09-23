// MCP over HTTP from the daemon itself: one warm endpoint shared by every agent
// session instead of a stdio process per session. Tools call this app's own
// routes in-process, so the MCP stays a thin client of the HTTP API (spec §19.1)
// and every call still passes the ingress gate first.
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { type DaemonTransport, daemonClient } from '@devdock/mcp/client'
import { mcpHttpHandler } from '@devdock/mcp/server'
import type { FastifyInstance } from 'fastify'

// Same ceiling the stdio client puts on one daemon request.
const DAEMON_REQUEST_TIMEOUT_MS = 180_000

/** Daemon API requests served by `app.inject` rather than a socket round trip. */
export function injectTransport(app: FastifyInstance): DaemonTransport {
  return async (path, init) => {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Daemon request timed out; check status before retrying')),
        DAEMON_REQUEST_TIMEOUT_MS,
      )
    })
    try {
      const res = await Promise.race([
        app.inject({
          method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE',
          url: path,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          payload: typeof init?.body === 'string' ? init.body : undefined,
        }),
        timeout,
      ])
      const nullBody = res.statusCode === 204 || res.statusCode === 304
      return new Response(nullBody ? null : res.body, { status: res.statusCode })
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Mounts `/mcp` (read-only, the stdio default) and `/mcp/rw` (write verbs).
 *  Returns a closer for shutdown. */
export function mountMcp(app: FastifyInstance): () => Promise<void> {
  const client = daemonClient(injectTransport(app))
  const endpoints = [
    { url: '/mcp', handler: mcpHttpHandler(client, 'ro') },
    { url: '/mcp/rw', handler: mcpHttpHandler(client, 'rw') },
  ]

  app.register(async (scope) => {
    // The SDK reads and validates the JSON-RPC body itself; hand it raw bytes.
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

    for (const { url, handler } of endpoints) {
      scope.route({
        method: ['GET', 'POST', 'DELETE'],
        url,
        exposeHeadRoute: false,
        handler: async (req, reply) => {
          // Client disconnect cancels the exchange; a finished response must not.
          const abort = new AbortController()
          reply.raw.on('close', () => {
            if (!reply.raw.writableFinished) abort.abort()
          })
          const headers = new Headers()
          for (const [name, value] of Object.entries(req.headers)) {
            if (value === undefined) continue
            headers.set(name, Array.isArray(value) ? value.join(', ') : value)
          }
          const body = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined
          const res = await handler.fetch(
            new Request(new URL(req.url, 'http://127.0.0.1'), {
              method: req.method,
              headers,
              body,
              signal: abort.signal,
            }),
          )
          reply.code(res.status)
          res.headers.forEach((value, name) => {
            reply.header(name, value)
          })
          return reply.send(
            res.body ? Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>) : null,
          )
        },
      })
    }
  })

  return async () => {
    await Promise.all(endpoints.map(({ handler }) => handler.close()))
  }
}
