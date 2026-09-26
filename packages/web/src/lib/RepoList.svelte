<script lang="ts">
  import { type RepoState, type RepoStatus, type Verb, type InstanceView } from './api'
  import { instanceSymbol, ownerInstanceIds } from './globalRepos'
  import Icon, { type IconName } from './Icon.svelte'

  let {
    instances,
    repos,
    selectedId,
    busyId,
    busyVerb,
    listState = 'ready',
    onselect,
    onaction,
    oncustomize,
    onreplicate,
    onreplicadelete,
  }: {
    instances: InstanceView[]
    repos: RepoState[]
    selectedId: string | null
    busyId: string | null
    busyVerb: Verb | null
    /** Daemon reachability, so an empty list can say why it is empty. */
    listState?: 'loading' | 'offline' | 'ready'
    onselect: (id: string) => void
    onaction: (id: string, verb: Verb) => void
    oncustomize: (id: string) => void
    onreplicate: (id: string) => void
    onreplicadelete: (id: string) => void
  } = $props()

  const VERB_LABEL: Record<Verb, string> = {
    start: 'start',
    build: 'build',
    build_start: 'build + start',
    restart: 'restart',
    destroy: 'destroy',
  }
  const VERB_ICON: Record<Verb, IconName> = {
    start: 'play',
    build: 'hammer',
    build_start: 'hammer',
    restart: 'restart',
    destroy: 'stop',
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

{#snippet spinner()}
  <svg
    class="spinner"
    width="13"
    height="13"
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
    <span class="sicon"><Icon name="search" size={13} /></span>
    <input class="field" placeholder="Filter {repos.length} repos…" bind:value={query} aria-label="Filter repos" />
  </div>
  <div class="list" role="listbox" aria-label="repositories">
    {#each sections as section (section.title)}
      <button
        class="shead"
        aria-expanded={isOpen(section.title)}
        onclick={() => toggle(section.title)}
      >
        <span class="chev" class:open={isOpen(section.title)}><Icon name="chevron-right" size={11} /></span>
        <span class="stitle">{section.title}</span>
        <span class="scount">{section.repos.length}</span>
      </button>
      {#each isOpen(section.title) ? section.repos : [] as r (r.repo.id)}
        <div class="rowwrap" class:current={r.repo.id === selectedId}>
          <button
            class="row"
            role="option"
            aria-selected={r.repo.id === selectedId}
            onclick={() => onselect(r.repo.id)}
          >
            <span class="dot {r.status}" title={r.status}></span>
            <span class="id" title={r.repo.id}>
              {#if r.repo.parentId}<span class="rep" aria-hidden="true">↳</span>{/if}
              <span class="name">{r.repo.id}</span>
              {#each ownerInstanceIds(r) as id (id)}
                {@const machine = instances.find((i) => i.id === id)}
                <span class="owner" class:offline={!machine?.online} title="{machine?.name ?? 'Owner not connected'}{machine?.online ? '' : ' · offline'}">{instanceSymbol(machine, instances)}</span>
              {/each}
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
            {#each r.actions as v (v)}
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
                  <Icon name={VERB_ICON[v]} size={12} />
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
              ><Icon name="x" size={12} /></button>
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
              ><Icon name="plus" size={12} /></button>
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
            ><Icon name="more" size={12} /></button>
          </div>
        </div>
      {/each}
    {:else}
      <div class="empty">
        {#if repos.length > 0}
          <Icon name="search" size={16} />
          <p>No repos match your filter.</p>
        {:else if listState === 'loading'}
          <span class="spin"></span>
          <p>Connecting to the daemon…</p>
        {:else if listState === 'offline'}
          <Icon name="unplug" size={16} />
          <p>Daemon offline. Retrying…</p>
        {:else}
          <Icon name="inbox" size={16} />
          <p>No DevSpace repos discovered.</p>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .search {
    position: relative;
    flex: none;
    padding: 8px 10px;
    border-bottom: 1px solid var(--line);
  }
  .sicon {
    position: absolute;
    left: 19px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--muted);
    pointer-events: none;
    display: inline-flex;
  }
  .search .field {
    width: 100%;
    padding-left: 28px;
    background: var(--bg-0);
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .shead {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    margin-top: 6px;
    padding: 0 6px;
    position: sticky;
    top: 0;
    background: var(--bg-1);
    z-index: 1;
    width: 100%;
    border: none;
    border-radius: var(--r-1);
    text-align: left;
    color: var(--muted);
  }
  .shead:first-child {
    margin-top: 0;
  }
  .shead:hover {
    color: var(--ink-2);
  }
  .chev {
    display: inline-flex;
    transition: transform 0.12s ease;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .stitle {
    font-size: 11.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
  }
  .scount {
    font-size: 11.5px;
    font-family: var(--mono);
    color: var(--muted);
    opacity: 0.8;
  }
  .rowwrap {
    position: relative;
    border-radius: var(--r-1);
  }
  .rowwrap:hover {
    background: var(--bg-2);
  }
  .rowwrap.current {
    background: var(--bg-3);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .row {
    display: grid;
    grid-template-columns: 8px minmax(0, 1fr) auto;
    align-items: center;
    gap: 9px;
    width: 100%;
    height: 32px;
    text-align: left;
    background: none;
    border: none;
    border-radius: var(--r-1);
    padding: 0 8px 0 10px;
    color: var(--ink-2);
  }
  .rowwrap.current .row {
    color: var(--ink);
  }
  /* The action chips float over the right edge of the row on hover instead of
     reserving a column — the row keeps its full width for the id + status. A
     left gradient fades the underlying status text out behind them. */
  .actions {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 5px 0 28px;
    border-radius: 0 var(--r-1) var(--r-1) 0;
    background: linear-gradient(to right, transparent, var(--bg-2) 22px);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.1s ease;
  }
  .rowwrap.current .actions {
    background: linear-gradient(to right, transparent, var(--bg-3) 22px);
  }
  .rowwrap:hover .actions,
  .rowwrap:focus-within .actions {
    opacity: 1;
    pointer-events: auto;
  }
  /* The status sits under the actions; hide it so no clipped letters peek out. */
  .rowwrap:hover .st,
  .rowwrap:focus-within .st {
    visibility: hidden;
  }
  .act {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-1);
    color: var(--muted);
    padding: 0;
    transition: color 0.1s ease, background 0.1s ease;
  }
  .act:hover:not(:disabled) {
    background: var(--bg-1);
    color: var(--ink);
  }
  .act:disabled {
    cursor: default;
    opacity: 0.5;
  }
  .act.start:hover:not(:disabled) {
    color: var(--ok);
  }
  .act.restart:hover:not(:disabled) {
    color: var(--accent);
  }
  .act.build:hover:not(:disabled),
  .act.build_start:hover:not(:disabled) {
    color: var(--warn);
  }
  .act.destroy:hover:not(:disabled),
  .act.del:hover:not(:disabled) {
    color: var(--danger);
  }
  .act.plus:hover:not(:disabled) {
    color: var(--ok);
  }
  .act.spin {
    color: var(--accent);
  }
  /* A configured startup script tints the kebab accent. */
  .act.kebab.set {
    color: var(--accent);
  }
  .spinner {
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .id {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    font-size: 13.5px;
    font-weight: 500;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Replica rows: the ↳ marker and the branch pill inside the id cell. */
  .rep {
    color: var(--accent);
    font-family: var(--mono);
    font-size: 12px;
    flex: none;
  }
  .owner {
    flex: none;
    color: var(--accent);
    font-size: 13px;
    line-height: 1;
  }
  .owner.offline {
    color: var(--muted);
  }
  .bpill {
    flex: 0 1 auto;
    min-width: 44px;
    font-family: var(--mono);
    font-size: 11px;
    padding: 1px 5px;
    border-radius: var(--r-1);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent);
    white-space: nowrap;
    max-width: 90px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .st {
    font-size: 11.5px;
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
    color: var(--deployed);
  }
  .st.STOPPED {
    opacity: 0.7;
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
    font-size: 11px;
    padding: 1px 5px;
    border-radius: var(--r-1);
    color: var(--muted);
    background: color-mix(in srgb, var(--muted) 14%, transparent);
    white-space: nowrap;
  }
  .wpill.RUNNING_MANAGED {
    color: var(--ok);
    background: color-mix(in srgb, var(--ok) 14%, transparent);
  }
  .wpill.RUNNING_EXTERNAL {
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 14%, transparent);
  }
  .wpill.CRASHED {
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 14%, transparent);
  }
  .wpill.BUILDING,
  .wpill.RESTARTING {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .wpill.DEPLOYED {
    color: var(--deployed);
    background: color-mix(in srgb, var(--deployed) 14%, transparent);
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 32px 12px;
    color: var(--muted);
    text-align: center;
  }
  .empty p {
    margin: 0;
    font-size: 13.5px;
  }
  .spin {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--line-strong);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
</style>
