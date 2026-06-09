<script lang="ts">
  import LogViewer from './lib/LogViewer.svelte'
  import RepoList from './lib/RepoList.svelte'
  import Terminal from './lib/Terminal.svelte'
  import { type RepoState, fetchRepos, openEvents } from './lib/api'

  let repos = $state<RepoState[]>([])
  let selectedId = $state<string | null>(null)
  let mode = $state<'ro' | 'rw'>('ro')
  let connected = $state(false)

  async function refresh() {
    try {
      repos = await fetchRepos()
      connected = true
      if (!selectedId && repos.length) selectedId = repos[0]?.repo.id ?? null
    } catch {
      connected = false
    }
  }

  $effect(() => {
    refresh()
    const poll = setInterval(refresh, 4000)
    // live status/crash events nudge an immediate refresh (spec §13 /events).
    const ws = openEvents()
    ws.onmessage = () => refresh()
    return () => {
      clearInterval(poll)
      ws.close()
    }
  })

  const selected = $derived(repos.find((r) => r.repo.id === selectedId) ?? null)
</script>

<header>
  <h1>dev<b>dock</b></h1>
  <span class="conn" class:on={connected}>{connected ? 'daemon connected' : 'daemon offline'}</span>
</header>

<main>
  <section class="left">
    <RepoList {repos} {selectedId} onselect={(id) => (selectedId = id)} />
  </section>

  <section class="right">
    {#if selected}
      <div class="head">
        <h2>{selected.repo.name} <span class="st {selected.status}">{selected.status}</span></h2>
        <div class="modes">
          <button class:active={mode === 'ro'} onclick={() => (mode = 'ro')}>Listen (ro)</button>
          <button class:active={mode === 'rw'} onclick={() => (mode = 'rw')}>Control (rw)</button>
        </div>
      </div>
      <h3>Logs</h3>
      {#key selected.repo.id}
        <LogViewer id={selected.repo.id} />
        <h3>Terminal — {mode === 'rw' ? 'read-write' : 'read-only'}</h3>
        <Terminal id={selected.repo.id} {mode} />
      {/key}
    {:else}
      <p class="muted">Select a repo.</p>
    {/if}
  </section>
</main>

<style>
  header {
    display: flex; align-items: baseline; gap: 16px;
    padding: 16px 24px; border-bottom: 1px solid var(--line);
  }
  h1 { font-family: var(--mono); font-size: 20px; margin: 0; }
  h1 b { color: var(--accent); }
  .conn { font-size: 12px; color: var(--danger); }
  .conn.on { color: var(--ok); }
  main { display: grid; grid-template-columns: 380px 1fr; gap: 20px; padding: 20px 24px; }
  .head { display: flex; align-items: center; justify-content: space-between; }
  h2 { font-size: 18px; margin: 0 0 8px; }
  .st { font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .modes button.active { border-color: var(--accent); color: var(--accent); }
  h3 { font-size: 13px; color: var(--accent); margin: 18px 0 6px; }
  .muted { color: var(--muted); }
</style>
