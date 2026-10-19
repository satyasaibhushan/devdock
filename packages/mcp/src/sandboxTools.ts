import type { SandboxBuild, SandboxCreate, SandboxUpdate } from '@devdock/core'
import { z } from 'zod'
import type { DaemonClient } from './client.js'
import type { ToolDef } from './tools.js'

const member = z.object({
  repo: z.string().min(1),
  workload: z.string().min(1),
  source: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('pr'),
      repoSlug: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      number: z.number().int().positive(),
      url: z.string().url(),
    }),
    z.object({ kind: z.literal('branch'), ref: z.string().min(1) }),
    z.object({ kind: z.literal('worktree'), path: z.string().min(1) }),
  ]),
})
const key = { key: z.string().min(1) }
const actor = { actor: z.string().trim().min(1) }

/** Mapping is checked against the service prototype so new public methods need a tool. */
export const sandboxMethods = {
  listSandboxes: 'list',
  sandboxControllerStatus: 'controller',
  sandboxStatus: 'status',
  discoverSandbox: 'discover',
  createSandbox: 'create',
  updateSandbox: 'update',
  buildSandbox: 'build',
  snapshotSandbox: 'snapshot',
  wakeSandbox: 'wake',
  sleepSandbox: 'sleep',
  expireSandbox: 'expire',
  deleteSandbox: 'delete',
  recordHead: 'head',
} as const

export function sandboxTools(client: DaemonClient): ToolDef[] {
  const definitions: {
    name: string
    scope: 'ro' | 'rw'
    schema: z.ZodRawShape
    call: (a: Record<string, unknown>) => Promise<unknown> | undefined
  }[] = [
    { name: 'controller', scope: 'ro', schema: {}, call: () => client.sandboxController?.() },
    { name: 'list', scope: 'ro', schema: {}, call: () => client.sandboxList?.() },
    {
      name: 'status',
      scope: 'ro',
      schema: key,
      call: (a) => client.sandboxStatus?.(a.key as string),
    },
    {
      name: 'discover',
      scope: 'ro',
      schema: key,
      call: (a) => client.sandboxDiscover?.(a.key as string),
    },
    {
      name: 'create',
      scope: 'rw',
      schema: {
        ...key,
        ...actor,
        title: z.string().optional(),
        members: z.array(member).optional(),
        discover: z.boolean().optional(),
        wake: z.boolean().optional(),
      },
      call: (a) => client.sandboxCreate?.(a as unknown as SandboxCreate),
    },
    {
      name: 'update',
      scope: 'rw',
      schema: {
        ...key,
        ...actor,
        add: z.array(member).optional(),
        remove: z.array(z.object({ repo: z.string(), workload: z.string() })).optional(),
      },
      call: (a) => client.sandboxUpdate?.(a.key as string, a as unknown as SandboxUpdate),
    },
    {
      name: 'build',
      scope: 'rw',
      schema: { ...key, ...actor, repo: z.string().optional(), force: z.boolean().optional() },
      call: (a) => client.sandboxBuild?.(a.key as string, a as unknown as SandboxBuild),
    },
    {
      name: 'snapshot',
      scope: 'rw',
      schema: { ...key, ...actor, repo: z.string().optional() },
      call: (a) => client.sandboxSnapshot?.(a.key as string, a as unknown as SandboxBuild),
    },
    ...(['wake', 'sleep', 'expire', 'delete'] as const).map((action) => ({
      name: action,
      scope: 'rw' as const,
      schema: { ...key, ...actor, ...(action === 'wake' ? { evict: z.boolean().optional() } : {}) },
      call: (a: Record<string, unknown>) =>
        client.sandboxAction?.(
          a.key as string,
          action,
          a.actor as string,
          action === 'wake' ? { evict: a.evict as boolean | undefined } : undefined,
        ),
    })),
    {
      name: 'head',
      scope: 'rw',
      schema: {
        ...key,
        ...actor,
        repo: z.string(),
        workload: z.string(),
        sha: z.string(),
        merged: z.boolean().optional(),
      },
      call: (a) =>
        client.sandboxHead?.(
          a.key as string,
          a as unknown as {
            repo: string
            workload: string
            sha: string
            actor: string
            merged?: boolean
          },
        ),
    },
  ]
  return definitions.map((d) => ({
    name: `devdock_sandbox_${d.name}`,
    description: `${d.name} a ticket sandbox. Mutations record their actor; long work returns operationId.`,
    scope: d.scope,
    inputSchema: d.schema,
    handler: async (args) => {
      const parsed = z.object(d.schema).parse(args)
      const result = d.call(parsed)
      if (!result) throw new Error('Sandbox API unsupported')
      return JSON.stringify((await result) ?? { ok: true })
    },
  }))
}
