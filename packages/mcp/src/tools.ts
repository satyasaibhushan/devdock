// devdock MCP tools (spec §3, §14). Read tools are always exposed; write tools
// (verbs, exec, namespace/auth mutation, terminals) only when the server runs
// with rw scope — this is the "ro/rw via token scope" gate. Each tool is a
// thin call into the daemon client.
import type { RepoState } from '@devdock/core'
import { z } from 'zod'
import type { DaemonClient, RepoVerb, VerbResult } from './client.js'

export type Scope = 'ro' | 'rw'

export interface ToolDef {
  name: string
  description: string
  scope: Scope
  inputSchema: z.ZodRawShape
  handler: (args: Record<string, unknown>) => Promise<string>
}

const repoArg = { repo: z.string().describe('repo id (its directory name)') }
const workloadArg = {
  workload: z
    .string()
    .optional()
    .describe('workload type (api/cron/worker) for multi-workload repos; omit for the default'),
}
const tidArg = { terminal: z.string().describe('terminal id (from devdock_term_open)') }

function verbText(verb: string, repo: string, r: VerbResult): string {
  return r.ok ? `${verb} ${repo}: ok` : `${verb} ${repo}: exit ${r.code}\n${r.stderr}`.trim()
}

/** One line per repo; multi-workload repos get an indented per-workload breakdown. */
export function renderList(states: RepoState[]): string {
  return states
    .flatMap((s) => {
      const head = `${s.repo.id}\t${s.status}\t${s.pods.length} pod(s)`
      if (s.workloads.length <= 1 && !s.workloads[0]?.type) return [head]
      return [
        head,
        ...s.workloads.map((w) => `  - ${w.type}: ${w.status} (${w.pods.length} pod(s))`),
      ]
    })
    .join('\n')
}

const VERBS: Array<{ verb: RepoVerb; description: string }> = [
  { verb: 'start', description: 'Start dev mode for a workload (devspace dev in a tmux session).' },
  {
    verb: 'build',
    description: 'Build & deploy a workload without entering dev mode (devspace deploy).',
  },
  { verb: 'stop', description: 'Tear down a workload (devspace purge + kill its tmux session).' },
  {
    verb: 'restart',
    description: 'Recycle a workload from any state: stop, then build, then start.',
  },
  {
    verb: 'adopt',
    description:
      'Take over an externally-run dev session: release its holder, reconnect the dev pod here.',
  },
  {
    verb: 'clear',
    description: 'Reset a crashed dev pod without purge or rebuild (image stays as deployed).',
  },
]

/** All tool definitions, regardless of scope. */
export function allTools(client: DaemonClient): ToolDef[] {
  return [
    {
      name: 'devdock_list',
      description:
        'List all known repos with their reconciled status, including per-workload breakdowns.',
      scope: 'ro',
      inputSchema: {},
      handler: async () => {
        const states = await client.list()
        return states.length ? renderList(states) : 'No repos found.'
      },
    },
    {
      name: 'devdock_status',
      description: 'Get the full reconciled state of one repo (status, workloads, pods, session).',
      scope: 'ro',
      inputSchema: repoArg,
      handler: async (a) => JSON.stringify(await client.status(a.repo as string), null, 2),
    },
    {
      name: 'devdock_logs',
      description: "Return the most recent log lines for a repo's workload.",
      scope: 'ro',
      inputSchema: {
        ...repoArg,
        ...workloadArg,
        tail: z.number().int().positive().max(2000).optional(),
      },
      handler: async (a) => {
        const lines = await client.logs(
          a.repo as string,
          a.tail as number | undefined,
          a.workload as string | undefined,
        )
        return lines.length ? lines.join('\n') : '(no logs)'
      },
    },
    {
      name: 'devdock_namespace',
      description: 'Show the kube context’s current namespace and the selectable known list.',
      scope: 'ro',
      inputSchema: {},
      handler: async () => JSON.stringify(await client.namespace(), null, 2),
    },
    {
      name: 'devdock_auth_status',
      description:
        'Kubernetes OIDC auth state (phase, token expiry). Poll this after devdock_auth_login.',
      scope: 'ro',
      inputSchema: {},
      handler: async () => JSON.stringify(await client.auth(), null, 2),
    },
    {
      name: 'devdock_term_list',
      description: 'List open registered terminals (id, repo, kind, liveness).',
      scope: 'ro',
      inputSchema: {},
      handler: async () => {
        const terms = await client.termList()
        if (!terms.length) return 'No open terminals.'
        return terms
          .map(
            (t) =>
              `${t.id}\t${t.kind}${t.repo ? `\t${t.repo}${t.workload ? `/${t.workload}` : ''}` : ''}\t${
                t.alive ? 'alive' : 'exited'
              }`,
          )
          .join('\n')
      },
    },
    {
      name: 'devdock_term_read',
      description:
        'Read the recent scrollback of a registered terminal — use after a devdock_term_run that timed out, or to watch a long-running command.',
      scope: 'ro',
      inputSchema: { ...tidArg, tail: z.number().int().positive().max(2000).optional() },
      handler: async (a) =>
        (await client.termRead(a.terminal as string, a.tail as number | undefined)) ||
        '(no output)',
    },
    ...VERBS.map(
      ({ verb, description }): ToolDef => ({
        name: `devdock_${verb}`,
        description,
        scope: 'rw',
        inputSchema: { ...repoArg, ...workloadArg },
        handler: async (a) =>
          verbText(
            verb,
            a.repo as string,
            await client.verb(verb, a.repo as string, a.workload as string | undefined),
          ),
      }),
    ),
    {
      name: 'devdock_exec',
      description:
        "Type a one-off command into a workload's dev session (tmux send-keys — fire-and-forget, output stays in the session). To capture output, open a terminal and use devdock_term_run instead.",
      scope: 'rw',
      inputSchema: {
        ...repoArg,
        ...workloadArg,
        command: z.string().min(1).describe('shell command to run'),
      },
      handler: async (a) =>
        verbText(
          'exec',
          a.repo as string,
          await client.exec(
            a.repo as string,
            a.command as string,
            a.workload as string | undefined,
          ),
        ),
    },
    {
      name: 'devdock_set_startup',
      description:
        "Save the command auto-run in a repo's dev session once its pod is up (empty string clears it).",
      scope: 'rw',
      inputSchema: { ...repoArg, command: z.string().describe('startup command; "" to clear') },
      handler: async (a) => {
        await client.setStartup(a.repo as string, a.command as string)
        return (a.command as string).trim()
          ? `startup command saved for ${a.repo}`
          : `startup command cleared for ${a.repo}`
      },
    },
    {
      name: 'devdock_set_namespace',
      description:
        'Switch the kube context’s namespace (the `kn` alias). Running sessions keep their pinned namespace.',
      scope: 'rw',
      inputSchema: { namespace: z.string().min(1).describe('kubernetes namespace to switch to') },
      handler: async (a) => JSON.stringify(await client.setNamespace(a.namespace as string)),
    },
    {
      name: 'devdock_auth_login',
      description:
        'Kick off the interactive kubernetes OIDC login (opens a browser on the host). Returns immediately; poll devdock_auth_status for the outcome.',
      scope: 'rw',
      inputSchema: {},
      handler: async () => JSON.stringify(await client.authLogin()),
    },
    {
      name: 'devdock_term_open',
      description:
        'Open a registered terminal and return its id. kind=local: a login shell on the host (default when no repo given). kind=auto: the workload’s dev session, falling back to a pod shell. kind=shell: always a fresh pod shell.',
      scope: 'rw',
      inputSchema: {
        repo: z.string().optional().describe('repo id; omit for a local host shell'),
        ...workloadArg,
        kind: z.enum(['auto', 'shell', 'local']).optional(),
        cwd: z.string().optional().describe('working directory for a local shell'),
      },
      handler: async (a) => {
        const t = await client.termOpen({
          repo: a.repo as string | undefined,
          workload: a.workload as string | undefined,
          kind: a.kind as 'auto' | 'shell' | 'local' | undefined,
          cwd: a.cwd as string | undefined,
        })
        return `opened ${t.id} (${t.kind}${t.repo ? ` on ${t.repo}` : ''})`
      },
    },
    {
      name: 'devdock_term_run',
      description:
        'Type a command into a registered terminal and return the output once it goes quiet. If it reports timedOut, the command is still running — poll devdock_term_read.',
      scope: 'rw',
      inputSchema: {
        ...tidArg,
        command: z.string().min(1).describe('shell command to run'),
        timeoutMs: z.number().int().positive().max(120_000).optional(),
      },
      handler: async (a) => {
        const r = await client.termRun(
          a.terminal as string,
          a.command as string,
          a.timeoutMs as number | undefined,
        )
        const body = r.output || '(no output)'
        return r.timedOut
          ? `${body}\n\n[still running after timeout — poll devdock_term_read for more]`
          : body
      },
    },
    {
      name: 'devdock_term_close',
      description: 'Close a registered terminal and discard its scrollback.',
      scope: 'rw',
      inputSchema: tidArg,
      handler: async (a) => {
        await client.termClose(a.terminal as string)
        return `closed ${a.terminal}`
      },
    },
  ]
}

/** Tools visible at the given scope: ro hides the write verbs. */
export function toolsForScope(client: DaemonClient, scope: Scope): ToolDef[] {
  return allTools(client).filter((t) => scope === 'rw' || t.scope === 'ro')
}
