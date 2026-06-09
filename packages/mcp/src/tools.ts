// devdock MCP tools (spec §3, §14). Read tools are always exposed; write tools
// (start/build/stop/exec) only when the server runs with rw scope — this is the
// "ro/rw via token scope" gate. Each tool is a thin call into the daemon client.
import { z } from 'zod'
import type { DaemonClient, VerbResult } from './client.js'

export type Scope = 'ro' | 'rw'

export interface ToolDef {
  name: string
  description: string
  scope: Scope
  inputSchema: z.ZodRawShape
  handler: (args: Record<string, unknown>) => Promise<string>
}

const repoArg = { repo: z.string().describe('repo id (its directory name)') }

function verbText(verb: string, repo: string, r: VerbResult): string {
  return r.ok ? `${verb} ${repo}: ok` : `${verb} ${repo}: exit ${r.code}\n${r.stderr}`.trim()
}

/** All tool definitions, regardless of scope. */
export function allTools(client: DaemonClient): ToolDef[] {
  return [
    {
      name: 'devdock_list',
      description: 'List all known repos with their reconciled status.',
      scope: 'ro',
      inputSchema: {},
      handler: async () => {
        const states = await client.list()
        if (!states.length) return 'No repos found.'
        return states.map((s) => `${s.repo.id}\t${s.status}\t${s.pods.length} pod(s)`).join('\n')
      },
    },
    {
      name: 'devdock_status',
      description: 'Get the full reconciled state of one repo (status, pods, session).',
      scope: 'ro',
      inputSchema: repoArg,
      handler: async (a) => JSON.stringify(await client.status(a.repo as string), null, 2),
    },
    {
      name: 'devdock_logs',
      description: 'Return the most recent log lines for a repo.',
      scope: 'ro',
      inputSchema: { ...repoArg, tail: z.number().int().positive().max(2000).optional() },
      handler: async (a) => {
        const lines = await client.logs(a.repo as string, a.tail as number | undefined)
        return lines.length ? lines.join('\n') : '(no logs)'
      },
    },
    {
      name: 'devdock_start',
      description: 'Start dev mode for a repo (devspace dev in a tmux session).',
      scope: 'rw',
      inputSchema: repoArg,
      handler: async (a) =>
        verbText('start', a.repo as string, await client.start(a.repo as string)),
    },
    {
      name: 'devdock_build',
      description: 'Build & deploy a repo without entering dev mode (devspace deploy).',
      scope: 'rw',
      inputSchema: repoArg,
      handler: async (a) =>
        verbText('build', a.repo as string, await client.build(a.repo as string)),
    },
    {
      name: 'devdock_stop',
      description: 'Tear down a repo (devspace purge + kill its tmux session).',
      scope: 'rw',
      inputSchema: repoArg,
      handler: async (a) => verbText('stop', a.repo as string, await client.stop(a.repo as string)),
    },
    {
      name: 'devdock_exec',
      description: "Run a one-off command inside a repo's dev session.",
      scope: 'rw',
      inputSchema: { ...repoArg, command: z.string().min(1).describe('shell command to run') },
      handler: async (a) =>
        verbText(
          'exec',
          a.repo as string,
          await client.exec(a.repo as string, a.command as string),
        ),
    },
  ]
}

/** Tools visible at the given scope: ro hides the write verbs. */
export function toolsForScope(client: DaemonClient, scope: Scope): ToolDef[] {
  return allTools(client).filter((t) => scope === 'rw' || t.scope === 'ro')
}
