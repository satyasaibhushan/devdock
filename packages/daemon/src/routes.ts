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

  // AWS credential, owned by the daemon: minted silently via the OIDC refresh
  // token when possible, ONE shared browser sign-in when not. Serves the
  // credential_process JSON that the devdock-aws-cred shim (wired into
  // ~/.aws/config) relays to aws/devspace/docker. Deliberately blocking — the
  // caller is an `aws` process that cannot proceed without it.
  app.get('/aws/credential', async (_req, reply) => {
    const r = await service.awsCredential()
    if (!r.ok) return reply.code(503).send({ error: r.message })
    return r.cred
  })

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

  // One-shot command in the workload's pod with a REAL exit code (kubectl
  // exec) — the agent-loop counterpart to /exec's fire-and-forget send-keys.
  app.post<{
    Params: { id: string }
    Body: { command?: string; workload?: string; timeoutMs?: number }
  }>('/repos/:id/run', async (req, reply) => {
    const command = req.body?.command
    if (typeof command !== 'string' || !command.trim()) {
      return reply.code(400).send({ error: 'command required' })
    }
    try {
      return await service.runInWorkload(req.params.id, command, {
        workload: req.body?.workload,
        timeoutMs: req.body?.timeoutMs,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.code(message.includes('unknown repo') ? 404 : 500).send({ error: message })
    }
  })

  // Cursor-based log reads by source (application pipe file / container /
  // devdock hub). The old GET /repos/:id/logs stays as-is for the web UI.
  app.get<{
    Params: { id: string }
    Querystring: {
      source?: string
      cursor?: string
      tail?: string
      contains?: string
      workload?: string
    }
  }>('/repos/:id/logs/query', async (req, reply) => {
    const { source, cursor, contains, workload } = req.query
    if (source && !['auto', 'application', 'container', 'devdock'].includes(source)) {
      return reply.code(400).send({ error: `invalid source: ${source}` })
    }
    const tail = Number(req.query.tail ?? 200)
    try {
      return await service.queryLogs(req.params.id, {
        source: source as 'auto' | 'application' | 'container' | 'devdock' | undefined,
        cursor,
        contains,
        workload,
        tail: Number.isFinite(tail) ? tail : 200,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = message.includes('unknown repo')
        ? 404
        : message.includes('no running pod') || message.includes('login required')
          ? 409
          : 500
      return reply.code(code).send({ error: message })
    }
  })

  // Blocking wait — the daemon polls internally so the caller makes ONE call.
  app.post<{
    Params: { id: string }
    Body: {
      contains?: string
      status?: string
      ready?: boolean
      source?: string
      cursor?: string
      timeoutMs?: number
      workload?: string
    }
  }>('/repos/:id/wait', async (req, reply) => {
    const b = req.body ?? {}
    if (b.source && !['auto', 'application', 'container', 'devdock'].includes(b.source)) {
      return reply.code(400).send({ error: `invalid source: ${b.source}` })
    }
    try {
      return await service.wait(req.params.id, {
        contains: b.contains,
        status: b.status,
        ready: b.ready,
        source: b.source as 'auto' | 'application' | 'container' | 'devdock' | undefined,
        cursor: b.cursor,
        timeoutMs: b.timeoutMs,
        workload: b.workload,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = message.includes('unknown repo')
        ? 404
        : message.includes('at least one condition')
          ? 400
          : 500
      return reply.code(code).send({ error: message })
    }
  })

  app.post<{
    Params: { id: string }
    Querystring: { workload?: string }
    Body: { command?: string }
  }>('/repos/:id/exec', async (req, reply) => {
    const command = req.body?.command
    if (typeof command !== 'string' || !command.trim()) {
      return reply.code(400).send({ error: 'command required' })
    }
    try {
      const result = await service.exec(req.params.id, command, req.query.workload)
      return {
        ok: result.code === 0,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.code(message.includes('unknown repo') ? 404 : 500).send({ error: message })
    }
  })

  // Registered terminals — the MCP's stateful shell surface (open a terminal,
  // type into it, read what happened). Request/response over the same
  // PtyBroker sessions the WS terminal uses.
  app.get('/terminals', async () => service.listTerminals())

  app.post<{ Body: { repo?: string; workload?: string; kind?: string; cwd?: string } }>(
    '/terminals',
    async (req, reply) => {
      const { repo, workload, cwd } = req.body ?? {}
      const kind = req.body?.kind
      if (kind !== undefined && kind !== 'auto' && kind !== 'shell' && kind !== 'local') {
        return reply.code(400).send({ error: `invalid kind: ${kind}` })
      }
      try {
        return await service.openRegisteredTerminal({ repo, workload, kind, cwd })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const code = message.includes('repo required')
          ? 400
          : message.includes('unknown repo')
            ? 404
            : message.includes('write-lock') || message.includes('no running pod')
              ? 409
              : 500
        return reply.code(code).send({ error: message })
      }
    },
  )

  app.post<{ Params: { tid: string }; Body: { command?: string; timeoutMs?: number } }>(
    '/terminals/:tid/run',
    async (req, reply) => {
      const command = req.body?.command
      if (typeof command !== 'string' || !command.trim()) {
        return reply.code(400).send({ error: 'command required' })
      }
      try {
        return await service.runInTerminal(req.params.tid, command, req.body?.timeoutMs)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const code = message.includes('unknown terminal')
          ? 404
          : message.includes('busy') || message.includes('exited')
            ? 409
            : 500
        return reply.code(code).send({ error: message })
      }
    },
  )

  app.get<{ Params: { tid: string }; Querystring: { tail?: string } }>(
    '/terminals/:tid/output',
    async (req, reply) => {
      const tail = Number(req.query.tail ?? 200)
      try {
        return { output: service.readTerminal(req.params.tid, Number.isFinite(tail) ? tail : 200) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return reply.code(message.includes('unknown terminal') ? 404 : 500).send({ error: message })
      }
    },
  )

  app.delete<{ Params: { tid: string } }>('/terminals/:tid', async (req, reply) => {
    try {
      service.closeTerminal(req.params.tid)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.code(message.includes('unknown terminal') ? 404 : 500).send({ error: message })
    }
  })

  app.put<{ Params: { id: string }; Body: { command?: string; workload?: string } }>(
    '/repos/:id/startup',
    async (req, reply) => {
      const command = req.body?.command
      if (typeof command !== 'string') {
        return reply.code(400).send({ error: 'command must be a string' })
      }
      try {
        const workload = typeof req.body.workload === 'string' ? req.body.workload : undefined
        service.setStartupCommand(req.params.id, command, workload)
        return {
          ok: true,
          startupCommand: service.getStartupCommand(req.params.id, workload) ?? null,
          startupCommands: service.getStartupCommands(req.params.id),
        }
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
