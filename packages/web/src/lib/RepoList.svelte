<script lang="ts">
  import { type RepoState, type RepoStatus, type Verb, STATUS_VERBS } from './api'

  let {
    repos,
    selectedId,
    busyId,
    busyVerb,
    onselect,
    onaction,
    oncustomize,
    onreplicate,
    onreplicadelete,
  }: {
    repos: RepoState[]
    selectedId: string | null
    busyId: string | null
    busyVerb: Verb | null
    onselect: (id: string) => void
    onaction: (id: string, verb: Verb) => void
    oncustomize: (id: string) => void
    onreplicate: (id: string) => void
    onreplicadelete: (id: string) => void
  } = $props()

  // `stop` is surfaced as "kill" — the rest read as-is.
  const VERB_LABEL: Record<Verb, string> = {
    start: 'start',
    build: 'build',
    stop: 'kill',
    restart: 'restart',
    clear: 'clear pod',
  }

  let query = $state('')
  const filtered = $derived(
    repos.filter((r) => r.repo.id.toLowerCase().includes(query.trim().toLowerCase())),
  )

  // Live things first, dormant last — each status group is its own section.
  const SECTIONS: { title: string; statuses: RepoStatus[] }[] = [
    { title: 'crashed', statuses: ['CRASHED'] },
    { title: 'running', statuses: ['RUNNING_MANAGED', 'RUNNING_EXTERNAL', 'RESTARTING'] },
    { title: 'building', statuses: ['BUILDING'] },
    { title: 'deployed', statuses: ['DEPLOYED'] },
    { title: 'stopped', statuses: ['STOPPED'] },
  ]
  // Within a section, keep a replica right after its parent (family key sorts
  // `parent` and `parent-rN` together; replica ids sort after the bare parent).
  const familySort = (rs: RepoState[]) =>
    [...rs].sort((a, b) => {
      const ka = a.repo.parentId ?? a.repo.id
      const kb = b.repo.parentId ?? b.repo.id
      return ka === kb ? a.repo.id.localeCompare(b.repo.id) : ka.localeCompare(kb)
    })
  const sections = $derived(
    SECTIONS.map((s) => ({
      ...s,
      repos: familySort(filtered.filter((r) => s.statuses.includes(r.status))),
    })).filter((s) => s.repos.length > 0),
  )

  const label = (s: string) => s.replace('RUNNING_', '').replace('_', ' ').toLowerCase()

  type WorkloadPill = { key: string; label: string; status: RepoStatus }

  // Workload types that currently have something in the cluster (anything but
  // STOPPED). Multi-workload repos show their real api/worker/etc. types; a
  // frontend repo's single workload is presented as `ui` so UI repos scan the
  // same way as backend workload rows.
  const workloadPills = (r: RepoState): WorkloadPill[] => {
    const active = r.workloads.filter((w) => w.status !== 'STOPPED')
    if ((r.repo.workloads?.length ?? 0) > 1) {
      return active.map((w) => ({ key: w.type, label: w.type, status: w.status }))
    }
    if (r.repo.codeArea === 'frontend') {
      return active.map((w) => ({ key: w.type || 'ui', label: 'ui', status: w.status }))
    }
    return []
  }

  const COLLAPSE_KEY = 'devdock.collapsedSections'
  function readCollapsed(): Record<string, boolean> {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}')
    } catch {
      return {}
    }
  }
  let collapsed = $state<Record<string, boolean>>(readCollapsed())
  function toggle(title: string) {
    collapsed[title] = !collapsed[title]
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed))
  }
  // A live filter overrides collapsing — matches must never hide inside a
  // collapsed section.
  const isOpen = (title: string) => query.trim() !== '' || !collapsed[title]
</script>

{#snippet icon(v: Verb)}
  {#if v === 'start'}
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
      <path d="M7 4.5v15l12-7.5z" />
    </svg>
  {:else if v === 'stop'}
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2.5" />
    </svg>
  {:else if v === 'restart'}
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.5" />
      <path d="M21 3v6h-6" />
    </svg>
  {:else if v === 'build'}
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m15 12-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4L12.6 9.6" />
      <path d="m18 15 3-3" />
      <path
        d="m21.5 11.5-1.9-1.9a2 2 0 0 1-.6-1.4V7l-2.3-2.3a6 6 0 0 0-4.2-1.7l-3.5.7.9.8a6.2 6.2 0 0 1 2.1 4.6V10l2 2h1.2a2 2 0 0 1 1.4.6l1.9 1.9"
      />
    </svg>
  {:else if v === 'clear'}
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  {/if}
{/snippet}

{#snippet spinner()}
  <svg
    class="spinner"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.4"
    stroke-linecap="round"
    aria-hidden="true"
  >
    <path d="M21 12a9 9 0 1 1-6.2-8.5" />
  </svg>
{/snippet}

<div class="panel">
  <div class="search">
    <input placeholder="Filter {repos.length} repos…" bind:value={query} />
  </div>
  <div class="list" role="listbox" aria-label="repositories">
    {#each sections as section (section.title)}
      <button
        class="shead"
        aria-expanded={isOpen(section.title)}
        onclick={() => toggle(section.title)}
      >
        <span class="chev" class:open={isOpen(section.title)}>▸</span>
        <span class="stitle">{section.title}</span>
        <span class="scount">{section.repos.length}</span>
      </button>
      {#each isOpen(section.title) ? section.repos : [] as r (r.repo.id)}
        <div class="rowwrap" class:sel={r.repo.id === selectedId}>
          <button
            class="row"
            role="option"
            aria-selected={r.repo.id === selectedId}
            onclick={() => onselect(r.repo.id)}
          >
            <span class="dot {r.status}" title={r.status}></span>
            <span class="id" title={r.repo.id}>
              {#if r.repo.parentId}<span class="rep">↳</span>{/if}
              {r.repo.id}
              {#if r.repo.branch}<span class="bpill" title="branch {r.repo.branch}">{r.repo.branch}</span>{/if}
            </span>
            {#if workloadPills(r).length}
              <span class="wpills">
                {#each workloadPills(r) as w (w.key)}
                  <span class="wpill {w.status}" title="{w.label}: {w.status}">{w.label}</span>
                {/each}
              </span>
            {:else}
              <span class="st {r.status}">{label(r.status)}</span>
            {/if}
          </button>
          <div class="actions">
            {#each STATUS_VERBS[r.status] as v (v)}
              <button
                class="act {v}"
                title="{VERB_LABEL[v]} {r.repo.id}"
                aria-label="{VERB_LABEL[v]} {r.repo.id}"
                disabled={busyId !== null}
                class:spin={busyId === r.repo.id && busyVerb === v}
                onclick={(e) => {
                  e.stopPropagation()
                  onaction(r.repo.id, v)
                }}
              >
                {#if busyId === r.repo.id && busyVerb === v}
                  {@render spinner()}
                {:else}
                  {@render icon(v)}
                {/if}
              </button>
            {/each}
            {#if r.repo.parentId}
              <button
                class="act del"
                title="delete replica {r.repo.id}"
                aria-label="delete replica {r.repo.id}"
                disabled={busyId !== null}
                onclick={(e) => {
                  e.stopPropagation()
                  onreplicadelete(r.repo.id)
                }}
              >×</button>
            {:else}
              <button
                class="act plus"
                title="new replica of {r.repo.id}"
                aria-label="new replica of {r.repo.id}"
                disabled={busyId !== null}
                onclick={(e) => {
                  e.stopPropagation()
                  onreplicate(r.repo.id)
                }}
              >+</button>
            {/if}
            <button
              class="act kebab"
              class:set={
                !!r.startupCommand || Object.values(r.startupCommands ?? {}).some(Boolean)
              }
              title="startup script for {r.repo.id}"
              aria-label="customize {r.repo.id}"
              onclick={(e) => {
                e.stopPropagation()
                oncustomize(r.repo.id)
              }}
            >⋯</button>
          </div>
        </div>
      {/each}
    {:else}
      <p class="empty">
        {repos.length === 0 ? 'No DevSpace repos discovered.' : 'No repos match your filter.'}
      </p>
    {/each}
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    overflow: hidden;
  }
  .search {
    padding: 10px;
    border-bottom: 1px solid var(--line);
  }
  .search input {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--ink);
    font-family: var(--sans);
    font-size: 13px;
    padding: 7px 10px;
    outline: none;
  }
  .search input:focus {
    border-color: var(--accent);
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .shead {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 10px 4px;
    position: sticky;
    top: 0;
    background: var(--panel);
    z-index: 1;
    width: 100%;
    border: none;
    text-align: left;
    cursor: pointer;
  }
  .shead:first-child {
    padding-top: 4px;
  }
  .shead:hover .stitle {
    color: var(--ink);
  }
  .chev {
    font-size: 9px;
    color: var(--muted);
    transition: transform 0.12s ease;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .stitle {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }
  .scount {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--muted);
    background: var(--panel2);
    border-radius: 999px;
    padding: 1px 7px;
  }
  .rowwrap {
    position: relative;
    border: 1px solid transparent;
    border-radius: 8px;
  }
  .rowwrap:hover {
    background: var(--panel2);
  }
  .rowwrap.sel {
    background: var(--panel2);
    border-color: var(--accent);
  }
  .row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 10px;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: 8px;
    padding: 8px 10px;
    cursor: pointer;
    color: var(--ink);
  }
  /* The action chips float over the right edge of the row on hover instead of
     reserving a column — the row keeps its full width for the id + status. A
     left gradient fades the underlying status text out behind them. */
  .actions {
    position: absolute;
    top: 1px;
    right: 1px;
    bottom: 1px;
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 0 7px 0 32px;
    border-radius: 0 8px 8px 0;
    background: linear-gradient(to right, transparent, var(--panel2) 24px);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s ease;
  }
  .rowwrap:hover .actions {
    opacity: 1;
    pointer-events: auto;
  }
  .act {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--muted);
    line-height: 1;
    padding: 4px;
    cursor: pointer;
    transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease;
  }
  .act :global(svg) {
    width: 13px;
    height: 13px;
    display: block;
  }
  .act:hover:not(:disabled) {
    background: var(--panel2);
  }
  .act:disabled {
    cursor: default;
  }
  .act.start:hover:not(:disabled) {
    color: var(--ok);
    border-color: color-mix(in srgb, var(--ok) 45%, transparent);
  }
  .act.restart:hover:not(:disabled) {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .act.build:hover:not(:disabled) {
    color: var(--warn);
    border-color: color-mix(in srgb, var(--warn) 45%, transparent);
  }
  .act.clear:hover:not(:disabled) {
    color: #9fb6cc;
    border-color: color-mix(in srgb, #9fb6cc 45%, transparent);
  }
  .act.stop:hover:not(:disabled) {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  }
  .act.spin {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .act.kebab {
    font-size: 14px;
    padding: 2px 5px;
  }
  .act.plus,
  .act.del {
    font-size: 13px;
    padding: 2px 6px;
  }
  .act.plus:hover:not(:disabled) {
    color: var(--ok);
    border-color: color-mix(in srgb, var(--ok) 45%, transparent);
  }
  .act.del:hover:not(:disabled) {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  }
  /* Replica rows: the ↳ marker and the branch pill inside the id cell. */
  .rep {
    color: var(--accent);
    font-family: var(--mono);
    font-size: 11px;
    margin-right: 2px;
  }
  .bpill {
    font-family: var(--mono);
    font-size: 9px;
    font-weight: 400;
    letter-spacing: 0.02em;
    padding: 1px 5px;
    margin-left: 4px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    color: var(--accent);
    white-space: nowrap;
  }
  /* A configured startup script tints the kebab accent. */
  .act.kebab.set {
    color: var(--accent);
  }
  .act.kebab:hover:not(:disabled) {
    color: var(--ink);
  }
  .spinner {
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .dot {
    flex: none;
  }
  .id {
    font-weight: 600;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .st {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    white-space: nowrap;
  }
  .st.RUNNING_MANAGED {
    color: var(--ok);
  }
  .st.RUNNING_EXTERNAL {
    color: var(--warn);
  }
  .st.CRASHED {
    color: var(--danger);
  }
  .st.BUILDING,
  .st.RESTARTING {
    color: var(--accent);
  }
  .st.DEPLOYED {
    color: #9fb6cc;
  }
  .wpills {
    display: flex;
    gap: 3px;
    justify-content: flex-end;
    flex-wrap: wrap;
    max-width: 130px;
  }
  .wpill {
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.02em;
    padding: 1px 5px;
    border-radius: 999px;
    border: 1px solid var(--line);
    color: var(--muted);
    white-space: nowrap;
  }
  .wpill.RUNNING_MANAGED {
    color: var(--ok);
    border-color: color-mix(in srgb, var(--ok) 40%, transparent);
  }
  .wpill.RUNNING_EXTERNAL {
    color: var(--warn);
    border-color: color-mix(in srgb, var(--warn) 40%, transparent);
  }
  .wpill.CRASHED {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
  }
  .wpill.BUILDING {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .wpill.DEPLOYED {
    color: #9fb6cc;
    border-color: #46566a;
  }
  .empty {
    color: var(--muted);
    font-size: 13px;
    padding: 16px 10px;
  }
</style>
