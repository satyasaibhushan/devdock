// HTTP control + queries (spec §13). Thin Fastify routes over the core Service.
import type { Service } from '@devdock/core'
import Fastify, { type FastifyInstance } from 'fastify'

export function buildApp(service: Service): FastifyInstance {
  const app = Fastify({ logger: false })

  app.get('/health', async () => ({ ok: true }))

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

  const verbs = ['start', 'build', 'stop', 'restart'] as const
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
