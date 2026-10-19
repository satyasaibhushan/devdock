import type { SandboxView } from '@devdock/core'

// Self-contained page behind /s/:key. Mirrors the web UI's snapshot card so
// someone opening a ticket link later sees the same thing the agent left, and
// is moved to the live URL as soon as the sandbox answers.

function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function ago(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`
  return `${Math.round(minutes / 60 / 24)}d ago`
}

const STYLE = `
:root{color-scheme:dark;--bg-0:#0b0f14;--bg-1:#11161d;--bg-2:#171d26;--line:#232b36;--line-strong:#2d3745;
--ink:#e6edf3;--ink-2:#b4bfcc;--muted:#7d8896;--accent:#5aa9ff;--ok:#43c38a;--warn:#e0a84b;--danger:#ef6a6a;--deployed:#8f7bff;--stopped:#67727f;
--mono:ui-monospace,SFMono-Regular,Menlo,monospace;--sans:-apple-system,Inter,Segoe UI,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg-0);color:var(--ink);font:14px/1.45 var(--sans);display:grid;place-items:center;min-height:100vh;padding:24px}
.card{width:min(520px,100%);border:1px solid var(--line-strong);border-radius:10px;background:var(--bg-1);display:flex;flex-direction:column;overflow:hidden}
.card.expired{border-style:dashed}
.rib{height:30px;display:flex;align-items:center;gap:8px;padding:0 12px;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.rib .r{margin-left:auto;font:11.5px var(--mono);color:var(--muted);text-transform:none;letter-spacing:0}
.rib.awake{background:rgba(67,195,138,.14);color:var(--ok)}.rib.asleep,.rib.partial,.rib.unknown{background:var(--bg-2);color:var(--ink-2)}
.rib.building{background:rgba(90,169,255,.14);color:var(--accent)}.rib.expired{color:var(--deployed)}.rib.failed{background:rgba(239,106,106,.14);color:var(--danger)}
.hd{padding:12px 12px 4px}.hd .k{font:600 17px var(--mono)}.hd .n{color:var(--ink-2);font-size:13px}
.one{padding:0 12px 10px;font-size:12.5px;color:var(--ink-2)}.one.err{color:var(--danger)}
.shows{margin:0 12px;background:var(--bg-0);border:1px solid var(--line);border-radius:6px;font:12px var(--mono);padding:8px 10px}
.sh{display:flex;font-size:11px;text-transform:uppercase;color:var(--muted);margin-bottom:6px}.sh .ago{margin-left:auto}
.ln{display:flex;gap:10px;padding:2px 0;white-space:nowrap}.ln .repo{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.ln .h{min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--ink-2)}.ln .pr{color:var(--accent);text-decoration:none}.ln .dirty{color:var(--deployed)}
.ft{display:flex;align-items:center;gap:10px;padding:12px;margin-top:auto}
.lk{font:12px var(--mono);color:var(--accent);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btn{margin-left:auto;border:1px solid var(--line-strong);background:var(--bg-2);color:var(--ink);border-radius:6px;padding:6px 12px;font:600 12.5px var(--sans);cursor:pointer;white-space:nowrap}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#06101c}.btn:disabled{opacity:.6;cursor:default}
`

// One line per member: what was built (branch @ sha), its PR and uncommitted files. Display only;
// nothing here is compared against a remote head.
function shows(view: SandboxView): string {
  const snap = view.snapshot
  if (!snap) return ''
  const rows = snap.members
    .map((m) => {
      const branch = m.branch ? `${esc(m.branch)} @ ` : ''
      const pr =
        m.pr && /^https?:\/\//.test(m.pr.url)
          ? `<a class="pr" href="${esc(m.pr.url)}">PR #${m.pr.number}</a>`
          : ''
      const dirty = m.dirtyFiles.length
        ? `<span class="dirty" title="${esc(m.dirtyFiles.join('\n'))}">+${m.dirtyFiles.length} files</span>`
        : ''
      return `<div class="ln"><span class="repo">${esc(m.repo)} ${esc(m.workload)}</span><span class="h" title="${esc(m.sha)}">${branch}${esc(m.sha.slice(0, 7))}</span>${pr}${dirty}</div>`
    })
    .join('')
  return `<div class="shows"><div class="sh"><span>shows</span><span class="ago">${esc(ago(snap.at))} by ${esc(snap.actor)}</span></div>${rows}</div>`
}

function sentence(view: SandboxView): string {
  switch (view.ribbon) {
    case 'awake':
      return view.healthy ? 'Up; sending you over.' : 'Awake; waiting for pods to report ready.'
    case 'asleep':
      return 'Waking the sandbox; this page moves to it when the pods are ready.'
    case 'partial':
      return 'Some workloads are still scaling up.'
    case 'building':
      return 'Build in progress; this page refreshes until it is deployed.'
    case 'expired restorable':
      return 'Expired. The recorded images can be restored into a free slot without a rebuild.'
    case 'expired':
      return 'Expired and its snapshot has aged out; rebuild from the dashboard.'
    case 'failed':
      return view.error ?? 'The last operation failed.'
    default:
      return 'Cluster state is unavailable right now.'
  }
}

function shell(title: string, body: string, script = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}${script}</body></html>`
}

// Poll the sandbox until it is awake and healthy, then leave for its URL. An
// asleep sandbox is woken on load, and the Restore button posts the same wake call
// the dashboard uses; the daemon's same-origin rules admit both because this page
// is served from the daemon.
const SCRIPT = `<script>
(() => {
  const data = JSON.parse(document.getElementById('d').textContent)
  const status = document.getElementById('one')
  const poll = async () => {
    try {
      const res = await fetch('/sandboxes/' + encodeURIComponent(data.key))
      if (!res.ok) return
      const v = await res.json()
      if (v.power === 'awake' && v.healthy && v.urls[0]) { location.replace(v.urls[0]); return }
      if (v.ribbon === 'failed' && v.error) status.textContent = v.error
    } catch {}
  }
  const wake = (evict) => fetch('/sandboxes/' + encodeURIComponent(data.key) + '/wake', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actor: 'link', evict }),
  })
  const fail = async (res) => {
    const body = await res.json().catch(() => ({}))
    status.textContent = body.error ?? 'Wake failed.'
    status.classList.add('err')
    return String(body.error ?? '')
  }
  const act = async (evict) => {
    const btn = document.getElementById('act')
    btn.disabled = true
    const res = await wake(evict)
    if (!res.ok) { await fail(res); btn.disabled = false; return }
    status.textContent = 'Restoring; this page moves to the sandbox when it is ready.'
    setInterval(poll, 3000)
  }
  // A wake already in flight (another tab, the dashboard) is not an error for this page.
  if (data.wake) wake(false).then(async (res) => {
    if (res.ok) return
    if ((await fail(res)).includes('operation already active')) {
      status.textContent = 'Waking; this page moves to the sandbox when it is ready.'
      status.classList.remove('err')
    }
  }).catch(() => {})
  if (data.poll) setInterval(poll, 3000)
  const btn = document.getElementById('act')
  if (btn) btn.addEventListener('click', () => act(data.evict))
})()
</script>`

export const sandboxPage = {
  missing(key: string): string {
    return shell(
      `${key}: no sandbox`,
      `<div class="card expired"><div class="rib expired">not found</div><div class="hd"><div class="k">${esc(key)}</div></div><div class="one">No sandbox is recorded for this key.</div></div>`,
    )
  },
  card(view: SandboxView): string {
    const ribbonClass = view.ribbon.split(' ')[0]
    const wake = Boolean(view.slot) && view.power === 'asleep' && view.ribbon === 'asleep'
    const poll =
      view.ribbon === 'asleep' ||
      view.ribbon === 'awake' ||
      view.ribbon === 'partial' ||
      view.ribbon === 'building'
    const restorable = view.ribbon === 'expired restorable'
    const evict = restorable && Boolean(view.evictionCandidate)
    const button = restorable
      ? `<button id="act" class="btn primary">${evict ? `Evict ${esc(view.evictionCandidate ?? '')} and restore` : 'Restore'}</button>`
      : view.ribbon === 'failed'
        ? `<a class="btn" href="/?sandbox=${encodeURIComponent(view.key)}">Build logs</a>`
        : ''
    const data = JSON.stringify({ key: view.key, poll, evict, wake }).replaceAll('</', '<\\/')
    const body = `<div class="card ${restorable || view.ribbon === 'expired' ? 'expired' : ''}">
<div class="rib ${ribbonClass}"><span>${esc(view.ribbon)}</span><span class="r">${esc(view.slot ?? 'no slot')}</span></div>
<div class="hd"><div class="k">${esc(view.key)}</div>${view.title ? `<div class="n">${esc(view.title)}</div>` : ''}</div>
<div id="one" class="one">${esc(sentence(view))}</div>
${shows(view)}
<div class="ft"><a class="lk" href="${esc(view.link)}">${esc(view.link)}</a>${button}</div>
</div><script id="d" type="application/json">${data}</script>`
    return shell(`${view.key}: ${view.ribbon}`, body, SCRIPT)
  },
}
