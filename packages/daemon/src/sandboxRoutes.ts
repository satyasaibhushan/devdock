import type { SandboxBuild, SandboxCreate, SandboxUpdate, Service } from '@devdock/core'
import type { FastifyInstance } from 'fastify'
import { sandboxPage } from './sandboxPage.js'

export function sandboxRoutes(app: FastifyInstance, service: Service): void {
  app.get('/sandboxes/controller', () => service.sandboxControllerStatus())
  app.get('/sandboxes', () => service.listSandboxes())
  app.get<{ Params: { key: string } }>('/sandboxes/:key', (req) =>
    service.sandboxStatus(req.params.key),
  )
  app.post<{ Body: SandboxCreate }>('/sandboxes', (req) => service.createSandbox(req.body))
  app.patch<{ Params: { key: string }; Body: SandboxUpdate }>('/sandboxes/:key', (req) =>
    service.updateSandbox(req.params.key, req.body),
  )
  app.post<{ Params: { key: string }; Body: SandboxBuild }>('/sandboxes/:key/build', (req) =>
    service.buildSandbox(req.params.key, req.body),
  )
  app.post<{ Params: { key: string }; Body: SandboxBuild }>('/sandboxes/:key/snapshot', (req) =>
    service.snapshotSandbox(req.params.key, req.body),
  )
  for (const action of ['wake', 'sleep', 'expire', 'delete'] as const) {
    app.route<{ Params: { key: string }; Body: { actor: string; evict?: boolean } }>({
      method: action === 'delete' ? 'DELETE' : 'POST',
      url: action === 'delete' ? '/sandboxes/:key' : `/sandboxes/:key/${action}`,
      handler: (req) =>
        action === 'wake'
          ? service.wakeSandbox(req.params.key, req.body.actor, { evict: req.body.evict })
          : service[`${action}Sandbox`](req.params.key, req.body.actor),
    })
  }
}

/** The stable per-ticket link: redirect when the sandbox is up, otherwise show the snapshot card.
 *  GET stays read-only: any page can make the browser load this URL without an Origin header, so
 *  the wake is a same-origin POST the served page sends itself. */
export function sandboxLinkRoute(app: FastifyInstance, service: Service): void {
  app.get<{ Params: { key: string } }>('/s/:key', async (req, reply) => {
    let view: Awaited<ReturnType<Service['sandboxStatus']>>
    try {
      view = await service.sandboxStatus(req.params.key)
    } catch {
      return reply.code(404).type('text/html').send(sandboxPage.missing(req.params.key))
    }
    if (view.power === 'awake' && view.healthy && view.urls[0])
      return reply.redirect(view.urls[0], 302)
    const status = view.ribbon === 'expired' ? 410 : 200
    return reply.code(status).type('text/html').send(sandboxPage.card(view))
  })
}
