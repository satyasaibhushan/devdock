// HTTP control + queries (spec §13). Thin Fastify routes over the core Service.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Service } from '@devdock/core'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'

/** The built web UI (`packages/web/dist`), relative to this module at
 *  `packages/daemon/dist/routes.js`. Bundled into the daemon so port 7717
 *  serves the UI too — there's no separate dev server to keep alive. */
const WEB_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist')

export function buildApp(service: Service): FastifyInstance {
  const app = Fastify({ logger: false })

  // Serve the web UI off the same origin as the API, so its relative fetches and
  // ws:// connections (api.ts uses location.host) just work with no proxy. The
  // wildcard `/*` is the lowest-priority match — every API route below is more
  // specific, so this only catches `/`, `/assets/*`, favicon, etc. Skipped when
  // unbuilt (tests, `pnpm build` not yet run) so it's a no-op there.
  if (existsSync(WEB_DIST)) {
    app.register(fastifyStatic, { root: WEB_DIST })
  }

  app.get('/health', async () => ({ ok: true }))

  // The global namespace selector: reads/moves the kube context's namespace
  // (what the user's `kn` alias does), so the UI and terminal always agree.
  app.get('/namespace', async () => service.namespaceInfo())

  app.put<{ Body: { namespace?: string } }>('/namespace', async (req, reply) => {
    const namespace = req.body?.namespace
    if (typeof namespace !== 'string' || !namespace.trim()) {
      return reply.code(400).send({ error: 'namespace required' })
    }
    try {
      return await service.setNamespace(namespace)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.code(message.includes('invalid namespace') ? 400 : 500).send({ error: message })
    }
  })

  // Kubernetes OIDC auth, owned by the daemon (one login for all verbs). GET
  // is the UI's poll; login/clear return the immediate snapshot — the browser
  // flow finishes in the background and later polls pick up the outcome.
  app.get('/auth', async () => service.authState())
  app.post('/auth/login', async () => service.authLogin())
  app.post('/auth/clear', async () => service.authClearCache())

  app.get('/repos', async () => service.list())

  app.get<{ Params: { id: string } }>('/repos/:id', async (req, reply) => {
    const state = service.get(req.params.id)
    if (!state) return reply.code(404).send({ error: 'unknown repo' })
    return state
  })

  app.get<{ Params: { id: string } }>('/repos/:id/pods', async (req, reply) => {
    const state = service.get(req.params.id)
    if (!state) return reply.code(404).send({ error: 'unknown repo' })
    return state.pods
  })

  app.get<{ Params: { id: string }; Querystring: { tail?: string; workload?: string } }>(
    '/repos/:id/logs',
    async (req, reply) => {
      if (!service.get(req.params.id)) return reply.code(404).send({ error: 'unknown repo' })
      const tail = Number(req.query.tail ?? 200)
      return service.logs(req.params.id, Number.isFinite(tail) ? tail : 200, req.query.workload)
    },
  )

  app.post<{ Params: { id: string }; Body: { command?: string } }>(
    '/repos/:id/exec',
    async (req, reply) => {
      const command = req.body?.command
      if (typeof command !== 'string' || !command.trim()) {
        return reply.code(400).send({ error: 'command required' })
      }
      try {
        const result = await service.exec(req.params.id, command)
        return { ok: result.code === 0, code: result.code, stderr: result.stderr }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return reply.code(message.includes('unknown repo') ? 404 : 500).send({ error: message })
      }
    },
  )

  app.put<{ Params: { id: string }; Body: { command?: string } }>(
    '/repos/:id/startup',
    async (req, reply) => {
      const command = req.body?.command
      if (typeof command !== 'string') {
        return reply.code(400).send({ error: 'command must be a string' })
      }
      try {
        service.setStartupCommand(req.params.id, command)
        return { ok: true, startupCommand: service.getStartupCommand(req.params.id) ?? null }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return reply.code(message.includes('unknown repo') ? 404 : 500).send({ error: message })
      }
    },
  )

  const verbs = ['start', 'build', 'stop', 'restart', 'adopt', 'clear'] as const
  for (const verb of verbs) {
    app.post<{ Params: { id: string }; Querystring: { workload?: string } }>(
      `/repos/:id/${verb}`,
      async (req, reply) => {
        try {
          const result = await service[verb](req.params.id, req.query.workload)
          return { ok: result.code === 0, code: result.code, stderr: result.stderr }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const code = message.includes('unknown repo') ? 404 : 500
          return reply.code(code).send({ error: message })
        }
      },
    )
  }

  return app
}
