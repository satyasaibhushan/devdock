<script lang="ts">
  import { type BranchInfo, type ReplicaRecord, createReplica, fetchBranches } from './api'

  let {
    repoId,
    onclose,
    oncreated,
  }: {
    repoId: string
    onclose: () => void
    oncreated: (rec: ReplicaRecord) => void
  } = $props()

  let branches = $state<BranchInfo[]>([])
  let loading = $state(true)
  let query = $state('')
  let picked = $state<string | null>(null)
  let creating = $state(false)
  let error = $state<string | null>(null)
  let initialized = false

  $effect(() => {
    if (initialized) return
    initialized = true
    fetchBranches(repoId)
      .then((b) => (branches = b))
      .catch((e) => (error = e instanceof Error ? e.message : String(e)))
      .finally(() => (loading = false))
  })

  // The daemon already sorts by most-recent commit; the filter narrows in place.
  const filtered = $derived(
    branches.filter((b) => b.name.toLowerCase().includes(query.trim().toLowerCase())),
  )

  const when = (ts: number) => {
    if (!ts) return ''
    const days = Math.floor((Date.now() - ts) / 86_400_000)
    if (days <= 0) return 'today'
    if (days === 1) return '1d ago'
    if (days < 30) return `${days}d ago`
    return new Date(ts).toISOString().slice(0, 10)
  }

  async function create() {
    if (!picked || creating) return
    creating = true
    error = null
    try {
      const rec = await createReplica(repoId, picked)
      oncreated(rec)
      onclose()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      creating = false
    }
  }

  function onkey(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose()
    if (e.key === 'Enter' && picked) create()
  }
</script>

<svelte:window onkeydown={onkey} />

<div
  class="backdrop"
  role="button"
  tabindex="-1"
  aria-label="close"
  onclick={onclose}
  onkeydown={() => {}}
></div>
<div class="modal" role="dialog" aria-modal="true" aria-label="New replica of {repoId}">
  <header>
    <div>
      <p class="eyebrow">parallel deployment</p>
      <h3>New replica</h3>
    </div>
    <code>{repoId}</code>
  </header>
  <p class="hint">
    Deploys the picked branch side-by-side with <b>{repoId}</b> — its own pods and
    <b>/{repoId}-rN/</b> URL, the original checkout untouched. Auto-deleted after 2 days.
  </p>

  <input
    class="filter"
    placeholder="Filter {branches.length} branches…"
    bind:value={query}
    disabled={loading}
  />

  <div class="branches" role="listbox" aria-label="branches">
    {#if loading}
      <p class="empty">Loading branches…</p>
    {:else}
      {#each filtered as b (b.name)}
        <button
          class="branch"
          class:picked={picked === b.name}
          role="option"
          aria-selected={picked === b.name}
          onclick={() => (picked = b.name)}
        >
          <span class="bname">{b.name}</span>
          <span class="bwhen">{when(b.lastCommitAt)}</span>
        </button>
      {:else}
        <p class="empty">
          {branches.length === 0 ? 'No local branches found.' : 'No branches match your filter.'}
        </p>
      {/each}
    {/if}
  </div>

  {#if error}<p class="err">{error}</p>{/if}
  <footer>
    <button class="ghost" onclick={onclose} disabled={creating}>Cancel</button>
    <button class="primary" onclick={create} disabled={!picked || creating}>
      {creating ? 'Creating…' : picked ? `Create from ${picked}` : 'Pick a branch'}
    </button>
  </footer>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(4, 8, 12, 0.72);
    backdrop-filter: blur(3px);
    z-index: 50;
  }
  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 51;
    width: min(520px, calc(100vw - 40px));
    background: var(--panel);
    border: 1px solid var(--line);
    border-top: 2px solid var(--accent);
    border-radius: 10px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    box-shadow: 0 28px 80px rgba(0, 0, 0, 0.58);
  }
  header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
  }
  .eyebrow {
    margin: 0 0 4px;
    color: var(--accent);
    font-family: var(--mono);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
  header h3 {
    margin: 0;
    font-size: 18px;
    letter-spacing: -0.02em;
  }
  header code {
    max-width: 55%;
    color: var(--muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.55;
  }
  .hint b {
    color: var(--ink);
    font-weight: 600;
  }
  .filter {
    width: 100%;
    box-sizing: border-box;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--ink);
    font-family: var(--sans);
    font-size: 13px;
    padding: 7px 10px;
    outline: none;
  }
  .filter:focus {
    border-color: var(--accent);
  }
  .branches {
    height: 260px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 6px;
  }
  .branch {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    text-align: left;
    background: none;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 7px 10px;
    cursor: pointer;
    color: var(--ink);
  }
  .branch:hover {
    background: var(--panel2);
  }
  .branch.picked {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border-color: color-mix(in srgb, var(--accent) 36%, var(--line));
  }
  .bname {
    font-family: var(--mono);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bwhen {
    flex: none;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 10px;
  }
  .empty {
    color: var(--muted);
    font-size: 13px;
    padding: 16px 10px;
    margin: 0;
  }
  .err {
    margin: 0;
    font-size: 12px;
    color: var(--danger);
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .ghost {
    background: none;
  }
  .primary {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
    color: var(--accent);
  }
  .primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
