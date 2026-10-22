// A demo daemon for screenshots and recordings: it serves the real web UI from
// packages/web/dist and answers its API with fictional seeded state, so no
// cluster, kube credentials or real repositories are involved. Sandbox ribbons
// and lifecycle buttons come from the same core functions the daemon uses.
//
//   pnpm --filter @devdock/web build
//   pnpm --filter @devdock/daemon exec tsx demo/fixtureDaemon.ts   # http://127.0.0.1:7799
import { createReadStream, existsSync, statSync } from 'node:fs'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type WebSocket, WebSocketServer } from 'ws'
import { lifecycleActions } from '../../core/src/lifecycle.js'
import { type Sandbox, sandboxMarkdown, sandboxRibbon } from '../../core/src/sandboxes.js'
import type { RepoStatus } from '../../core/src/types.js'

const PORT = Number(process.env.DEMO_PORT ?? 7799)
const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url))
const NAMESPACE = 'alex'
const LOCAL = 'studio'
const REMOTE = 'buildbox'
const now = Date.now()
const min = 60_000
const hour = 60 * min
const TTL = 8 * hour

// ---- repos ----

type Workload = { type: string; status: RepoStatus; owner?: string; pods?: number }
type RepoSeed = {
  id: string
  area: 'backend' | 'frontend'
  workloads: Workload[]
  branch: string
  commit: string
  dirty?: boolean
}

const REPOS: RepoSeed[] = [
  {
    id: 'orders-api',
    area: 'backend',
    branch: 'split-refunds',
    commit: '4e1c09a7b2',
    dirty: true,
    workloads: [
      { type: 'api', status: 'RUNNING_MANAGED', owner: LOCAL },
      { type: 'worker', status: 'RUNNING_MANAGED', owner: LOCAL },
    ],
  },
  {
    id: 'storefront-ui',
    area: 'frontend',
    branch: 'main',
    commit: 'b7d2f310c4',
    workloads: [{ type: 'ui', status: 'RUNNING_MANAGED', owner: LOCAL }],
  },
  {
    id: 'search-indexer',
    area: 'backend',
    branch: 'synonyms',
    commit: '91aa0c5e3d',
    workloads: [{ type: 'worker', status: 'RUNNING_EXTERNAL', owner: REMOTE }],
  },
  {
    id: 'catalog-api',
    area: 'backend',
    branch: 'main',
    commit: '0c93e1f7aa',
    workloads: [{ type: 'api', status: 'DEPLOYED', owner: LOCAL }],
  },
  {
    id: 'payments-api',
    area: 'backend',
    branch: 'main',
    commit: '7f20b6d1e9',
    workloads: [{ type: 'api', status: 'DEPLOYED', owner: REMOTE }],
  },
  {
    id: 'admin-ui',
    area: 'frontend',
    branch: 'main',
    commit: 'c41d8e2b07',
    workloads: [{ type: 'ui', status: 'DEPLOYED', owner: LOCAL }],
  },
  ...['accounts-api', 'inventory-api', 'mailer-worker', 'reports-ui', 'shipping-api'].map(
    (id): RepoSeed => ({
      id,
      area: id.endsWith('-ui') ? 'frontend' : 'backend',
      branch: 'main',
      commit: 'a0b1c2d3e4',
      workloads: [
        {
          type: id.endsWith('-ui') ? 'ui' : id.endsWith('worker') ? 'worker' : 'api',
          status: 'STOPPED',
        },
      ],
    }),
  ),
]

const url = (repo: string, type: string) =>
  `https://${type === 'ui' ? '' : `${type}-`}${NAMESPACE}.demo.devdock.test/${repo}`

function repoState(seed: RepoSeed, instance: string) {
  const workloads = seed.workloads.map((w) => {
    const live = w.status !== 'STOPPED'
    const pods = live
      ? Array.from({ length: w.pods ?? 1 }, (_, i) => ({
          name: `${seed.id}-${w.type}-7c9f${i}d-x${i}k2p`,
          phase: 'Running',
          ready: true,
          restartCount: 0,
        }))
      : []
    return {
      type: seed.workloads.length > 1 ? w.type : '',
      status: w.status,
      pods,
      deployments: live ? [{ name: `${seed.id}-${w.type}`, replicas: 1, readyReplicas: 1 }] : [],
      hasSession: w.status === 'RUNNING_MANAGED' && w.owner === instance,
      actions: lifecycleActions(w.status),
      url: live ? url(seed.id, w.type) : undefined,
      ownerInstanceId: w.owner,
      ownershipKnown: true,
    }
  })
  const multi = seed.workloads.length > 1
  return {
    repo: {
      id: seed.id,
      name: seed.id,
      path: `/home/alex/code/${seed.id}`,
      codeArea: seed.area,
      namespace: NAMESPACE,
      ports: seed.area === 'frontend' ? [5173] : [8080],
      ...(multi
        ? { workloads: seed.workloads.map((w) => w.type), defaultWorkload: seed.workloads[0]?.type }
        : { workloadType: seed.workloads[0]?.type }),
      session: `devdock-${seed.id}`,
    },
    status: workloads[0]?.status ?? 'STOPPED',
    workloads,
    pods: workloads.flatMap((w) => w.pods),
    hasSession: workloads.some((w) => w.hasSession),
    actions: workloads[0]?.actions ?? [],
    updatedAt: Date.now(),
  }
}

function instances() {
  const auth = { oidc: false, phase: 'ok', checkedAt: Date.now() }
  return [
    { id: LOCAL, name: 'studio.local', local: true, online: true, terminals: true, auth },
    { id: REMOTE, name: 'buildbox', local: false, online: true, terminals: true, auth },
  ].map((i) => ({ ...i, repos: REPOS.map((r) => repoState(r, i.id)) }))
}

// ---- sandboxes ----

const SLOTS = ['sb1', 'sb2', 'sb3', 'sb4']
type Power = 'awake' | 'asleep' | 'partial' | 'unknown'
type DemoSandbox = Sandbox & { power: Power; ops: Operation[] }
type Operation = {
  id: string
  repo: string
  workload: string
  namespace: string
  action: string
  state: 'active' | 'succeeded' | 'failed'
  stage: string
  createdAt: number
  updatedAt: number
  checks: never[]
  logs: { at: number; message: string }[]
}

function member(
  repo: string,
  workload: string,
  branch: string,
  sha: string,
  pr: number,
  dirtyFiles: string[] = [],
) {
  return {
    repo,
    workload,
    mode: 'built' as const,
    branch,
    pr: { number: pr, url: `https://github.com/example/${repo}/pull/${pr}` },
    deployedSha: sha,
    dirtyFiles,
    image: `registry.demo.test/${repo}:${sha.slice(0, 7)}`,
    build: { state: 'idle' as const },
  }
}
const snapshotOf = (s: Pick<Sandbox, 'members' | 'slot'>, at: number) => ({
  slot: s.slot,
  at,
  actor: 'ui',
  members: s.members.map((m) => ({
    repo: m.repo,
    workload: m.workload,
    sha: m.deployedSha ?? '',
    dirtyFiles: m.dirtyFiles ?? [],
    image: m.image ?? '',
    branch: m.branch,
    pr: m.pr,
  })),
})
function seedSandbox(
  key: string,
  title: string,
  slot: string | undefined,
  power: Power,
  members: DemoSandbox['members'],
  lastUsedAt: number,
): DemoSandbox {
  const s: DemoSandbox = {
    key,
    title,
    slot,
    state: slot ? 'active' : 'expired',
    createdAt: lastUsedAt - 26 * hour,
    lastUsedAt,
    members,
    activity: [
      {
        at: lastUsedAt - 26 * hour,
        actor: 'agent',
        action: 'create',
        detail: `${members.length} members`,
      },
      { at: lastUsedAt - 25 * hour, actor: 'agent', action: 'build', detail: 'snapshot recorded' },
      { at: lastUsedAt, actor: 'ui', action: power === 'asleep' ? 'sleep' : 'wake' },
    ],
    power,
    ops: [],
  }
  s.snapshot = snapshotOf(s, lastUsedAt - 25 * hour)
  if (!slot) s.expiredAt = lastUsedAt + TTL
  return s
}

const SANDBOXES: DemoSandbox[] = [
  seedSandbox(
    'SHOP-142',
    'Split refunds across payment methods',
    'sb1',
    'awake',
    [
      member('orders-api', 'api', 'split-refunds', '4e1c09a7b2c1', 318, [
        'app/Refunds/Splitter.php',
      ]),
      member('storefront-ui', 'ui', 'split-refunds', 'e02b7d41a9f3', 902),
    ],
    now - 12 * min,
  ),
  seedSandbox(
    'SHOP-157',
    'Synonym-aware product search',
    'sb2',
    'asleep',
    [
      member('search-indexer', 'worker', 'synonyms', '91aa0c5e3d77', 64),
      member('catalog-api', 'api', 'synonyms', '5d3f0b9c12e8', 211),
    ],
    now - 3 * hour,
  ),
  seedSandbox(
    'SHOP-131',
    'Gift card checkout',
    undefined,
    'unknown',
    [
      member('payments-api', 'api', 'gift-cards', 'f7c2e90d4b11', 145),
      member('storefront-ui', 'ui', 'gift-cards', '1b9e4a7c0d52', 887),
    ],
    now - 2 * 24 * hour,
  ),
]

function view(s: DemoSandbox) {
  const t = Date.now()
  const ribbon = sandboxRibbon(s, s.power, t)
  const link = `http://127.0.0.1:${PORT}/s/${encodeURIComponent(s.key)}`
  const awake = s.power === 'awake'
  const memberUrls = Object.fromEntries(
    s.members.map((m) => [
      `${m.repo}:${m.workload}`,
      `https://${s.slot ?? 'sb'}-${NAMESPACE}.demo.devdock.test/${m.repo}`,
    ]),
  )
  const urls = awake
    ? s.members
        .filter((m) => m.workload === 'ui')
        .map((m) => memberUrls[`${m.repo}:${m.workload}`] ?? '')
    : []
  const { ops: _ops, power: _power, ...record } = s
  return {
    ...structuredClone(record),
    activity: structuredClone(s.activity.slice(-50)),
    power: s.power,
    healthy: awake,
    ribbon,
    urls,
    memberUrls,
    link,
    markdown: sandboxMarkdown(s, ribbon, link, urls),
    expiresAt: s.lastUsedAt + TTL,
    pool: SLOTS.map((slot) => ({ slot, key: SANDBOXES.find((x) => x.slot === slot)?.key })),
  }
}

function personalView() {
  const members = REPOS.filter((r) => r.workloads.some((w) => w.status !== 'STOPPED')).flatMap(
    (r) =>
      r.workloads.map((w) => ({
        ...member(r.id, w.type, r.branch, r.commit, 1),
        pr: undefined,
        mode: 'dev' as const,
      })),
  )
  const personal: DemoSandbox = {
    key: NAMESPACE,
    state: 'active',
    createdAt: now - 90 * 24 * hour,
    lastUsedAt: Date.now(),
    members,
    activity: [],
    power: 'awake',
    ops: [],
  }
  return { ...view(personal), personal: true, slot: NAMESPACE, snapshot: undefined }
}

const sandboxes = () => [personalView(), ...SANDBOXES.map(view)]

// Every transition is a short scripted operation: progress lines first, then
// the new power state, so the UI shows the same building → awake sequence.
function operate(s: DemoSandbox, action: string, steps: string[], finish: () => void) {
  const op: Operation = {
    id: `op-${Math.random().toString(36).slice(2, 10)}`,
    repo: `sandbox:${s.key}`,
    workload: '',
    namespace: NAMESPACE,
    action,
    state: 'active',
    stage: 'deploying',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    checks: [],
    logs: [],
  }
  s.ops.push(op)
  s.error = undefined
  s.activity.push({ at: Date.now(), actor: 'ui', action })
  steps.forEach((message, i) =>
    setTimeout(
      () => {
        op.logs.push({ at: Date.now(), message })
        op.updatedAt = Date.now()
        if (i === steps.length - 1) {
          op.state = 'succeeded'
          finish()
          s.lastUsedAt = Date.now()
        }
        notify()
      },
      (i + 1) * 900,
    ),
  )
  notify()
  return { operationId: op.id }
}

function sandboxAction(s: DemoSandbox, action: string) {
  if (action === 'sleep') {
    s.power = 'partial'
    return operate(
      s,
      'sleep',
      s.members.map((m) => `scaled ${m.repo}-${m.workload} to 0`),
      () => {
        s.power = 'asleep'
      },
    )
  }
  if (action === 'wake' && s.state === 'expired') {
    const slot = SLOTS.find((x) => !SANDBOXES.some((y) => y.slot === x)) ?? 'sb4'
    s.slot = slot
    s.state = 'active'
    s.expiredAt = undefined
    s.power = 'partial'
    return operate(
      s,
      'restore',
      [
        `leased ${slot}`,
        ...s.members.map((m) => `installed ${m.repo}-${m.workload} from ${m.image}`),
        'all members ready',
      ],
      () => {
        s.power = 'awake'
      },
    )
  }
  if (action === 'wake') {
    s.power = 'partial'
    return operate(
      s,
      'wake',
      [...s.members.map((m) => `scaled ${m.repo}-${m.workload} to 1`), 'all members ready'],
      () => {
        s.power = 'awake'
      },
    )
  }
  if (action === 'expire') {
    s.power = 'unknown'
    return operate(s, 'expire', ['uninstalled releases'], () => {
      s.slot = undefined
      s.state = 'expired'
      s.expiredAt = Date.now()
    })
  }
  if (action === 'build') {
    for (const m of s.members) m.build = { state: 'building', startedAt: Date.now() }
    return operate(
      s,
      'build',
      s.members.map((m) => `built ${m.repo}-${m.workload}`),
      () => {
        for (const m of s.members) m.build = { state: 'idle' }
        s.power = 'awake'
      },
    )
  }
  throw new Error(`Unsupported demo action ${action}`)
}

// ---- logs and terminals ----

const LOG_LINES: Record<string, string[]> = {
  'payments-api': [
    'GET /health 200 2ms',
    'POST /v1/gift-cards/redeem 200 63ms',
    'gift card gc_81f2 balance 25.00 -> 0.00',
    'POST /v1/charges 201 112ms',
    'GET /v1/charges/ch_4410 200 9ms',
  ],
  'catalog-api': [
    'GET /health 200 2ms',
    'GET /v1/products?q=sneakers 200 38ms',
    'synonym hit: sneakers -> trainers, runners',
    'GET /v1/products/2291 200 11ms',
  ],
  api: [
    'GET /health 200 2ms',
    'GET /v1/orders?status=open 200 41ms',
    'POST /v1/orders/7731/refunds 201 88ms',
    'refund split: card=42.00 wallet=18.50 order=7731',
    'GET /v1/orders/7731 200 17ms',
    'queue publish refunds.settled id=rf_2c81',
  ],
  worker: [
    'job refunds.settle picked up attempt=1',
    'ledger entry written refund=rf_2c81',
    'job refunds.settle done 214ms',
    'reindexed 1,204 products in 3.1s',
    'synonyms loaded: 318 groups',
  ],
  ui: [
    'VITE v6.2.0  ready in 612 ms',
    '➜  Local:   http://localhost:5173/',
    'hmr update /src/checkout/RefundSummary.tsx',
    'page reload src/routes/orders/[id].tsx',
    'hmr update /src/checkout/PaymentSplit.tsx',
  ],
}
const stamp = () => new Date().toISOString().slice(11, 19)
const logsFor = (workload: string, repo = '') =>
  LOG_LINES[repo] ?? LOG_LINES[workload] ?? LOG_LINES.api ?? []

let cursor = 0
function logPage(repo: string, workload: string, after?: string) {
  const lines = logsFor(workload, repo)
  if (!after) {
    cursor += 6
    return {
      lines: Array.from({ length: 12 }, (_, i) => `${stamp()} ${lines[i % lines.length]}`),
      cursor: String(cursor),
    }
  }
  cursor += 1
  return { lines: [`${stamp()} ${lines[cursor % lines.length]}`], cursor: String(cursor) }
}

type Term = {
  id: string
  repo?: string
  workload?: string
  kind: string
  attach: string
  createdAt: number
  lastUsedAt: number
  alive: boolean
  attached: number
}
const TERMS: Term[] = []
const sessionScreen = (repo: string) =>
  [
    `\x1b[32m✔\x1b[0m Deployed ${repo} (image registry.demo.test/${repo}:dev)`,
    '\x1b[32m✔\x1b[0m Port forwarding started on 8080 -> 8080',
    `\x1b[32m✔\x1b[0m Sync started on ./ <-> /app (pod ${repo}-api-7c9f0d)`,
    '',
    `\x1b[36m${repo}\x1b[0m:/app$ php artisan queue:work --tries=3`,
    '[INFO] Processing jobs from the [default] queue.',
    `[${stamp()}] App\\Jobs\\SettleRefund ....... RUNNING`,
    `[${stamp()}] App\\Jobs\\SettleRefund ....... 212ms DONE`,
    `[${stamp()}] App\\Jobs\\SendReceipt ........ RUNNING`,
    `[${stamp()}] App\\Jobs\\SendReceipt ........ 96ms DONE`,
    '',
  ].join('\r\n')

// ---- server ----

const repoFor = (id: string) => REPOS.find((r) => r.id === id)

const sockets = new Set<WebSocket>()
function notify() {
  for (const ws of sockets) ws.send(JSON.stringify({ type: 'status' }))
}

const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

async function api(req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams) {
  const method = req.method ?? 'GET'
  let m: RegExpMatchArray | null
  if (path === '/instances') return json(res, instances())
  if (path === '/auth') return json(res, { oidc: false, phase: 'ok', checkedAt: Date.now() })
  if (path === '/namespace') return json(res, { current: NAMESPACE, known: [NAMESPACE] })
  if (path === '/health') return json(res, { ok: true })
  if (path === '/sandboxes' && method === 'GET') return json(res, sandboxes())
  if (path === '/sandboxes/controller')
    return json(res, {
      holder: LOCAL,
      isLeader: true,
      lastPollAt: Date.now() - 20_000,
      lastError: null,
    })
  m = path.match(/^\/sandboxes\/([^/]+)(?:\/(wake|sleep|expire|build))?$/)
  if (m) {
    const s = SANDBOXES.find((x) => x.key === decodeURIComponent(m?.[1] ?? ''))
    if (!s) return json(res, { error: 'Sandbox not found' }, 404)
    if (method === 'GET') return json(res, view(s))
    await readBody(req)
    if (method === 'DELETE') return json(res, { error: 'Deleting is disabled in the demo' }, 409)
    return json(res, sandboxAction(s, m[2] ?? ''))
  }
  if (path === '/operations') {
    const key = q.get('repo') ?? ''
    const s = SANDBOXES.find((x) => `sandbox:${x.key}` === key)
    return json(res, s?.ops ?? [])
  }
  m = path.match(/^\/repos\/([^/]+)\/checkout$/)
  if (m) {
    const r = repoFor(decodeURIComponent(m[1] ?? ''))
    if (!r) return json(res, { error: 'Unknown repo' }, 404)
    return json(res, {
      machine: LOCAL,
      path: `/home/alex/code/${r.id}`,
      branch: r.branch,
      commit: r.commit,
      dirty: r.dirty ?? false,
      checkedAt: Date.now(),
    })
  }
  m = path.match(/^\/repos\/([^/]+)\/logs\/query$/)
  if (m)
    return json(
      res,
      logPage(
        decodeURIComponent(m[1] ?? ''),
        q.get('workload') ?? 'api',
        q.get('cursor') ?? undefined,
      ),
    )
  if (path === '/terminals' && method === 'GET') return json(res, TERMS)
  if (path === '/terminals' && method === 'POST') {
    const body = await readBody(req)
    const repo = typeof body.repo === 'string' ? body.repo : undefined
    const workload = typeof body.workload === 'string' ? body.workload : undefined
    const kind = typeof body.kind === 'string' ? body.kind : 'auto'
    const existing = TERMS.find(
      (t) => t.kind === 'auto' && t.repo === repo && t.workload === workload,
    )
    if (kind === 'auto' && existing) return json(res, existing)
    const term: Term = {
      id: `t${TERMS.length + 1}`,
      repo,
      workload,
      kind,
      attach: kind === 'local' ? 'host' : 'tmux',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      alive: true,
      attached: 0,
    }
    TERMS.push(term)
    return json(res, term)
  }
  m = path.match(/^\/repos\/([^/]+)\/(operations|build|build-start|start|restart|destroy)$/)
  if (m) return json(res, { error: 'Lifecycle verbs are disabled in the demo' }, 409)
  return json(res, { error: `Not in the demo: ${method} ${path}` }, 404)
}

const server = createServer(async (req, res) => {
  const parsed = new URL(req.url ?? '/', 'http://demo')
  // Remote instances answer under /instances/:id/api; the demo serves both from one state.
  const path = parsed.pathname.replace(/^\/instances\/[^/]+\/api(?=\/)/, '')
  const isApi =
    /^\/(instances|auth|namespace|health|sandboxes|operations|repos|terminals|replicas)(\/|$)/
  if (isApi.test(path)) return api(req, res, path, parsed.searchParams)
  const file = normalize(join(WEB_DIST, path === '/' ? 'index.html' : path))
  const target =
    file.startsWith(WEB_DIST) && existsSync(file) && statSync(file).isFile()
      ? file
      : join(WEB_DIST, 'index.html')
  res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' })
  createReadStream(target).pipe(res)
})

const wss = new WebSocketServer({ server })
wss.on('connection', (ws, req) => {
  const path = new URL(req.url ?? '/', 'http://demo').pathname.replace(
    /^\/instances\/[^/]+\/api(?=\/)/,
    '',
  )
  let m: RegExpMatchArray | null
  if (path === '/events') {
    sockets.add(ws)
    ws.on('close', () => sockets.delete(ws))
    return
  }
  m = path.match(/^\/repos\/([^/]+)\/logs$/)
  if (m) {
    const workload = new URL(req.url ?? '/', 'http://demo').searchParams.get('workload') ?? ''
    const repo = repoFor(decodeURIComponent(m[1] ?? ''))
    const lines = logsFor(workload || (repo?.area === 'frontend' ? 'ui' : 'api'), repo?.id)
    for (const line of lines) ws.send(`${stamp()} ${line}`)
    let i = 0
    const timer = setInterval(() => ws.send(`${stamp()} ${lines[i++ % lines.length]}`), 1100)
    ws.on('close', () => clearInterval(timer))
    return
  }
  m = path.match(/^\/terminals\/([^/]+)\/attach$/)
  if (m) {
    const term = TERMS.find((t) => t.id === m?.[1])
    ws.send(term?.attach === 'host' ? 'alex@studio ~ % ' : sessionScreen(term?.repo ?? 'repo'))
    // Keystrokes are ignored: the demo terminal is a recording, not a shell.
    return
  }
  ws.close()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`devdock demo daemon on http://127.0.0.1:${PORT}`)
})
