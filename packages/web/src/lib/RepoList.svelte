<script lang="ts">
  import type { RepoState, RepoStatus } from './api'

  let {
    repos,
    selectedId,
    busyId,
    onselect,
    onstart,
  }: {
    repos: RepoState[]
    selectedId: string | null
    busyId: string | null
    onselect: (id: string) => void
    onstart: (id: string) => void
  } = $props()

  let query = $state('')
  const filtered = $derived(
    repos.filter((r) => r.repo.id.toLowerCase().includes(query.trim().toLowerCase())),
  )

  // Live things first, dormant last — each status group is its own section.
  const SECTIONS: { title: string; statuses: RepoStatus[] }[] = [
    { title: 'crashed', statuses: ['CRASHED'] },
    { title: 'running', statuses: ['RUNNING_MANAGED', 'RUNNING_EXTERNAL'] },
    { title: 'building', statuses: ['BUILDING'] },
    { title: 'deployed', statuses: ['DEPLOYED'] },
    { title: 'stopped', statuses: ['STOPPED'] },
  ]
  const sections = $derived(
    SECTIONS.map((s) => ({
      ...s,
      repos: filtered.filter((r) => s.statuses.includes(r.status)),
    })).filter((s) => s.repos.length > 0),
  )

  const label = (s: string) => s.replace('RUNNING_', '').replace('_', ' ').toLowerCase()
  const startable = (s: RepoStatus) => s === 'STOPPED' || s === 'DEPLOYED'

  // For a multi-workload repo, the workload types that currently have something
  // in the cluster (anything but STOPPED) — shown as pills so one row conveys
  // "api + worker up, cron down" at a glance.
  const runningWorkloads = (r: RepoState) =>
    (r.repo.workloads?.length ?? 0) > 1
      ? r.workloads.filter((w) => w.status !== 'STOPPED')
      : []

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
            <span class="id" title={r.repo.id}>{r.repo.id}</span>
            {#if runningWorkloads(r).length}
              <span class="wpills">
                {#each runningWorkloads(r) as w (w.type)}
                  <span class="wpill {w.status}" title="{w.type}: {w.status}">{w.type}</span>
                {/each}
              </span>
            {:else}
              <span class="st {r.status}">{label(r.status)}</span>
            {/if}
          </button>
          {#if startable(r.status)}
            <button
              class="quick"
              title="start {r.repo.id} (devspace dev)"
              aria-label="start {r.repo.id}"
              disabled={busyId !== null}
              class:spin={busyId === r.repo.id}
              onclick={(e) => {
                e.stopPropagation()
                onstart(r.repo.id)
              }}
            >{busyId === r.repo.id ? '◌' : '▶'}</button>
          {/if}
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
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
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
  .quick {
    background: none;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--muted);
    font-size: 10px;
    line-height: 1;
    padding: 5px 7px;
    margin-right: 6px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .rowwrap:hover .quick,
  .rowwrap.sel .quick,
  .quick.spin {
    opacity: 1;
  }
  .quick:hover:not(:disabled) {
    color: var(--ok);
    border-color: color-mix(in srgb, var(--ok) 40%, transparent);
  }
  .quick:disabled {
    cursor: default;
  }
  .quick.spin {
    color: var(--accent);
    animation: pulse 1s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
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
  .st.BUILDING {
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
