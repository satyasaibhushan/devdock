// devdock MCP tools (spec §3, §14). Read tools are always exposed; write tools
// (verbs, exec, namespace/auth mutation, terminals) only when the server runs
// with rw scope — this is the "ro/rw via token scope" gate. Each tool is a
// thin call into the daemon client.
import type { LogSource, RepoState } from '@devdock/core'
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
      description:
        "Read a workload's logs by source with cursor-based resume. source=application is the app's real stdout (the devspace dev pane); container is kubectl logs; devdock is devdock's own verb activity; auto (default) prefers application. Pass the returned cursor back to get only NEW lines since the last read.",
      scope: 'ro',
      inputSchema: {
        ...repoArg,
        ...workloadArg,
        source: z.enum(['auto', 'application', 'container', 'devdock']).optional(),
        cursor: z.string().optional().describe('cursor from a previous devdock_logs/devdock_wait'),
        tail: z.number().int().positive().max(2000).optional(),
        contains: z.string().optional().describe('only lines containing this substring'),
      },
      handler: async (a) => {
        const r = await client.queryLogs(a.repo as string, {
          workload: a.workload as string | undefined,
          source: a.source as LogSource | undefined,
          cursor: a.cursor as string | undefined,
          tail: a.tail as number | undefined,
          contains: a.contains as string | undefined,
        })
        const flags = [
          r.resync ? 'resync=true (cursor was stale; restarted from the tail)' : '',
          r.dropped ? 'dropped=true (some lines were lost before this read)' : '',
        ].filter(Boolean)
        const head = `[source=${r.source}${r.pod ? ` pod=${r.pod}` : ''} nextCursor=${r.cursor}${
          flags.length ? ` ${flags.join(' ')}` : ''
        }]`
        return r.lines.length ? `${head}\n${r.lines.join('\n')}` : `${head}\n(no new lines)`
      },
    },
    {
      name: 'devdock_wait',
      description:
        'Block until a condition holds (or timeout): contains= a NEW log line with the substring appears (watching starts now unless a cursor is given), status= the workload reaches it (e.g. RUNNING_MANAGED), ready= a pod is ready. Conditions are OR’d. Use after devdock_run/restart to know when the app actually reloaded — no polling needed.',
      scope: 'ro',
      inputSchema: {
        ...repoArg,
        ...workloadArg,
        contains: z.string().optional().describe('log substring to wait for'),
        source: z.enum(['auto', 'application', 'container', 'devdock']).optional(),
        cursor: z.string().optional().describe('watch from this cursor instead of from now'),
        status: z.string().optional().describe('workload status to wait for'),
        ready: z.boolean().optional().describe('wait for a ready pod'),
        timeoutMs: z.number().int().positive().max(120_000).optional(),
      },
      handler: async (a) => {
        const r = await client.wait(a.repo as string, {
          workload: a.workload as string | undefined,
          contains: a.contains as string | undefined,
          source: a.source as LogSource | undefined,
          cursor: a.cursor as string | undefined,
          status: a.status as string | undefined,
          ready: a.ready as boolean | undefined,
          timeoutMs: a.timeoutMs as number | undefined,
        })
        const tail = `${r.status ? ` status=${r.status}` : ''} elapsedMs=${r.elapsedMs}${
          r.cursor ? ` nextCursor=${r.cursor}` : ''
        }`
        if (r.matched) {
          return `matched: ${r.reason}${r.line ? ` — ${r.line}` : ''}${tail}`
        }
        return `timeout: condition not met within the window${tail}`
      },
    },
    {
      name: 'devdock_branch_list',
      description:
        "List a repo's local branches, most recently committed first — the choices for devdock_replica_create.",
      scope: 'ro',
      inputSchema: repoArg,
      handler: async (a) => {
        const branches = await client.branches(a.repo as string)
        if (!branches.length) return 'No local branches.'
        return branches
          .map((b) => `${b.name}\t${new Date(b.lastCommitAt).toISOString().slice(0, 10)}`)
          .join('\n')
      },
    },
    {
      name: 'devdock_replica_list',
      description:
        'List replicas (ephemeral branch-pinned parallel deployments): id, parent repo, branch, age, URL path. Replicas older than 2 days are garbage-collected automatically.',
      scope: 'ro',
      inputSchema: {},
      handler: async () => {
        const replicas = await client.replicaList()
        if (!replicas.length) return 'No replicas.'
        return replicas
          .map((r) => {
            const ageH = Math.floor((Date.now() - r.createdAt) / 3_600_000)
            const age = ageH >= 24 ? `${Math.floor(ageH / 24)}d${ageH % 24}h` : `${ageH}h`
            return `${r.id}\tparent=${r.parentId}\tbranch=${r.branch}\tage=${age}\turl=/${r.id}/${
              r.ingressApplied ? '' : ' (url pending — appears once pods run)'
            }`
          })
          .join('\n')
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
      name: 'devdock_replica_create',
      description:
        "Deploy a second copy of a repo pinned to a branch, beside the original in the same namespace (own pods, own /<replica-id>/ URL path, primary checkout untouched). Returns immediately with the replica id; the deploy runs in the background — use devdock_wait with the id (e.g. status=running_managed) to know when it's up, then every devdock tool works on the id like a normal repo. By default the replica reuses the parent's deployed image with the branch's code synced in (fast, but changes needing a rebuilt image — new system deps, Dockerfile edits — won't take effect); set ownImage=true to build the replica's own image from the branch first (slower: a full image build runs before the deploy).",
      scope: 'rw',
      inputSchema: {
        ...repoArg,
        branch: z.string().min(1).describe('local branch to pin the replica to'),
        ownImage: z
          .boolean()
          .optional()
          .describe(
            "build the replica's own image from the branch instead of reusing the parent's (needed when the branch changes Dockerfiles or system deps)",
          ),
      },
      handler: async (a) => {
        const r = await client.replicaCreate(
          a.repo as string,
          a.branch as string,
          a.ownImage as boolean | undefined,
        )
        const how = r.ownImage ? 'building its own image, then deploying' : 'deploying'
        return `created ${r.id} from ${r.branch} — ${how} in the background; poll devdock_wait ${r.id}`
      },
    },
    {
      name: 'devdock_replica_delete',
      description:
        'Tear down a replica: its pods, URL alias, and worktree. The parent repo and the branch itself are untouched.',
      scope: 'rw',
      inputSchema: { replica: z.string().describe('replica id (from devdock_replica_list)') },
      handler: async (a) => {
        await client.replicaDelete(a.replica as string)
        return `deleted ${a.replica}`
      },
    },
    {
      name: 'devdock_run',
      description:
        "Run a one-shot command inside the workload's pod and get its REAL exit code, stdout, and stderr (kubectl exec). Use this for tests/lint/checks in an edit→verify loop. infraError set means devdock/cluster plumbing failed (no pod, auth, connectivity) — NOT the command; fix that first instead of treating it as a test failure.",
      scope: 'rw',
      inputSchema: {
        ...repoArg,
        ...workloadArg,
        command: z.string().min(1).describe('shell command to run in the pod (sh -c)'),
        timeoutMs: z.number().int().positive().max(600_000).optional(),
      },
      handler: async (a) => {
        const r = await client.runIn(a.repo as string, a.command as string, {
          workload: a.workload as string | undefined,
          timeoutMs: a.timeoutMs as number | undefined,
        })
        if (r.infraError) return `INFRA ERROR (command did not run to completion): ${r.infraError}`
        const head = `exit ${r.exitCode}${r.pod ? ` (pod ${r.pod})` : ''}${
          r.timedOut ? ' — TIMED OUT, output below is partial' : ''
        }${r.truncated ? ' — output truncated to the tail' : ''}`
        const body = [
          r.stdout.trimEnd(),
          r.stderr.trimEnd() ? `--- stderr ---\n${r.stderr.trimEnd()}` : '',
        ]
          .filter(Boolean)
          .join('\n')
        return body ? `${head}\n${body}` : `${head}\n(no output)`
      },
    },
    {
      name: 'devdock_exec',
      description:
        "Type a one-off command into a workload's dev session (tmux send-keys — fire-and-forget, output stays in the session). For a real exit code and captured output use devdock_run; for an interactive shell use devdock_term_run.",
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
        "Save the command auto-run once a pod type's dev session is up (empty string clears it). Use workload for distinct api/worker/cron/ui commands; omit it for the repo default.",
      scope: 'rw',
      inputSchema: {
        ...repoArg,
        ...workloadArg,
        command: z.string().describe('startup command; "" to clear'),
      },
      handler: async (a) => {
        const workload = a.workload as string | undefined
        await client.setStartup(a.repo as string, a.command as string, workload)
        const target = `${a.repo}${workload ? `/${workload}` : ''}`
        return (a.command as string).trim()
          ? `startup command saved for ${target}`
          : `startup command cleared for ${target}`
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
        'Open a registered terminal and return its id (scope-qualified, e.g. my-repo:t1 or host:t1). kind=local: a login shell on the host (default when no repo given). kind=auto: the workload’s ONE primary terminal (dev session, falling back to a pod shell) — reused if already open, shared live with the web UI. kind=shell: always a fresh pod shell.',
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
