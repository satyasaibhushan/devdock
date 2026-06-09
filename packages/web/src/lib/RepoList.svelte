<script lang="ts">
  import { type RepoState, type Verb, runVerb } from './api'

  let { repos, selectedId, onselect }: {
    repos: RepoState[]
    selectedId: string | null
    onselect: (id: string) => void
  } = $props()

  let busy = $state<string | null>(null)

  async function act(id: string, verb: Verb) {
    busy = `${id}:${verb}`
    try {
      await runVerb(id, verb)
    } catch (e) {
      console.error(e)
    } finally {
      busy = null
    }
  }
</script>

<div class="list">
  {#each repos as r (r.repo.id)}
    <div class="row" class:sel={r.repo.id === selectedId}>
      <button class="name" onclick={() => onselect(r.repo.id)}>
        <span class="dot {r.status}"></span>
        <span class="id">{r.repo.name}</span>
        <span class="status">{r.status}</span>
      </button>
      <div class="ctrls">
        <button disabled={busy !== null} onclick={() => act(r.repo.id, 'start')}>Start</button>
        <button disabled={busy !== null} onclick={() => act(r.repo.id, 'build')}>Build</button>
        <button disabled={busy !== null} onclick={() => act(r.repo.id, 'restart')}>Restart</button>
        <button disabled={busy !== null} onclick={() => act(r.repo.id, 'stop')}>Kill</button>
      </div>
    </div>
  {:else}
    <p class="empty">No DevSpace repos discovered. Is the daemon scanning the right roots?</p>
  {/each}
</div>

<style>
  .list { display: flex; flex-direction: column; gap: 4px; }
  .row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px;
    background: var(--panel);
  }
  .row.sel { border-color: var(--accent); }
  .name {
    display: flex; align-items: center; gap: 10px;
    background: none; border: none; padding: 0; text-align: left; flex: 1;
  }
  .id { font-weight: 600; }
  .status { color: var(--muted); font-family: var(--mono); font-size: 11px; }
  .ctrls { display: flex; gap: 4px; }
  .empty { color: var(--muted); }
</style>
