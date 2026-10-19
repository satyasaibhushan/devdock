import type { SandboxBuild, SandboxCreate, SandboxUpdate } from '@devdock/core'
import { z } from 'zod'
import type { DaemonClient } from './client.js'
import type { ToolDef } from './tools.js'

const member = z.object({
  repo: z.string().min(1),
  workload: z.string().min(1),
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Absolute path of your agent worktree for this repo; omit to build the repo's registered checkout",
    ),
})
const memberHelp =
  "Each member is {repo, workload, path}: pass path as the absolute path of your agent worktree so the build bakes your current files, uncommitted edits included; without path it builds the repo's registered checkout."
const key = { key: z.string().min(1) }
const actor = { actor: z.string().trim().min(1) }

/** Mapping is checked against the service prototype so new public methods need a tool. */
export const sandboxMethods = {
  listSandboxes: 'list',
  sandboxControllerStatus: 'controller',
  sandboxStatus: 'status',
  createSandbox: 'create',
  updateSandbox: 'update',
  buildSandbox: 'build',
  snapshotSandbox: 'snapshot',
  wakeSandbox: 'wake',
  sleepSandbox: 'sleep',
  expireSandbox: 'expire',
  deleteSandbox: 'delete',
} as const

export function sandboxTools(client: DaemonClient): ToolDef[] {
  const definitions: {
    name: string
    scope: 'ro' | 'rw'
    description?: string
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
      name: 'create',
      scope: 'rw',
      description: `Create a ticket sandbox and build its members. ${memberHelp} Records actor; returns operationId.`,
      schema: {
        ...key,
        ...actor,
        title: z.string().optional(),
        members: z.array(member).optional(),
        wake: z.boolean().optional(),
      },
      call: (a) => client.sandboxCreate?.(a as unknown as SandboxCreate),
    },
    {
      name: 'update',
      scope: 'rw',
      description: `Add or remove ticket sandbox members. ${memberHelp} Records actor; returns operationId.`,
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
      schema: { ...key, ...actor, repo: z.string().optional() },
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
  ]
  return definitions.map((d) => ({
    name: `devdock_sandbox_${d.name}`,
    description:
      d.description ??
      `${d.name} a ticket sandbox. Mutations record their actor; long work returns operationId.`,
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
