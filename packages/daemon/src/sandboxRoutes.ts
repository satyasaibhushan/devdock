import type { SandboxBuild, SandboxCreate, SandboxUpdate, Service } from '@devdock/core'
import type { FastifyInstance } from 'fastify'

export function sandboxRoutes(app: FastifyInstance, service: Service): void {
  app.get('/sandboxes', () => service.listSandboxes())
  app.get<{ Params: { key: string } }>('/sandboxes/:key', (req) =>
    service.sandboxStatus(req.params.key),
  )
  app.get<{ Params: { key: string } }>('/sandboxes/:key/discover', (req) =>
    service.discoverSandbox(req.params.key),
  )
  app.post<{ Body: SandboxCreate }>('/sandboxes', (req) => service.createSandbox(req.body))
  app.patch<{ Params: { key: string }; Body: SandboxUpdate }>('/sandboxes/:key', (req) =>
    service.updateSandbox(req.params.key, req.body),
  )
  app.post<{ Params: { key: string }; Body: SandboxBuild }>('/sandboxes/:key/build', (req) =>
    service.buildSandbox(req.params.key, req.body),
  )
  for (const action of ['wake', 'sleep', 'expire', 'delete'] as const) {
    app.route<{ Params: { key: string }; Body: { actor: string } }>({
      method: action === 'delete' ? 'DELETE' : 'POST',
      url: action === 'delete' ? '/sandboxes/:key' : `/sandboxes/:key/${action}`,
      handler: (req) => service[`${action}Sandbox`](req.params.key, req.body.actor),
    })
  }
  app.post<{
    Params: { key: string }
    Body: { repo: string; workload: string; sha: string; actor: string; merged?: boolean }
  }>('/sandboxes/:key/head', async (req) => {
    await service.recordHead(
      req.params.key,
      req.body,
      req.body.sha,
      req.body.actor,
      req.body.merged,
    )
    return { ok: true }
  })
}
