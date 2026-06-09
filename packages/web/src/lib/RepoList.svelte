<script lang="ts">
  import type { RepoState } from './api'

  let {
    repos,
    selectedId,
    onselect,
  }: {
    repos: RepoState[]
    selectedId: string | null
    onselect: (id: string) => void
  } = $props()

  let query = $state('')
  const filtered = $derived(
    repos.filter((r) => r.repo.id.toLowerCase().includes(query.trim().toLowerCase())),
  )
  const label = (s: string) => s.replace('RUNNING_', '').replace('_', ' ').toLowerCase()
</script>

<div class="panel">
  <div class="search">
    <input placeholder="Filter {repos.length} repos…" bind:value={query} />
  </div>
  <div class="list" role="listbox" aria-label="repositories">
    {#each filtered as r (r.repo.id)}
      <button
        class="row"
        class:sel={r.repo.id === selectedId}
        role="option"
        aria-selected={r.repo.id === selectedId}
        onclick={() => onselect(r.repo.id)}
      >
        <span class="dot {r.status}" title={r.status}></span>
        <span class="id" title={r.repo.id}>{r.repo.id}</span>
        <span class="st {r.status}">{label(r.status)}</span>
      </button>
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
  .row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 10px;
    width: 100%;
    text-align: left;
    background: none;
    border: 1px solid transparent;
    border-radius: 8px;
    padding: 8px 10px;
    cursor: pointer;
    color: var(--ink);
  }
  .row:hover {
    background: var(--panel2);
  }
  .row.sel {
    background: var(--panel2);
    border-color: var(--accent);
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
  .empty {
    color: var(--muted);
    font-size: 13px;
    padding: 16px 10px;
  }
</style>
