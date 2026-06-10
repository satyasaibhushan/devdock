<script lang="ts">
  import LogViewer from './lib/LogViewer.svelte'
  import RepoList from './lib/RepoList.svelte'
  import Terminal from './lib/Terminal.svelte'
  import { type RepoState, type RepoStatus, type Verb, fetchRepos, openEvents, runVerb } from './lib/api'

  let repos = $state<RepoState[]>([])
  let selectedId = $state<string | null>(null)
  let mode = $state<'ro' | 'rw'>('ro')
  let connected = $state(false)
  let busy = $state<{ id: string; verb: Verb } | null>(null)
  let toast = $state<string | null>(null)

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
    const ws = openEvents()
    ws.onmessage = () => refresh()
    return () => {
      clearInterval(poll)
      ws.close()
    }
  })

  const selected = $derived(repos.find((r) => r.repo.id === selectedId) ?? null)
  // Memoized primitives for the stream children. `selected` is a fresh object
  // every 4s poll, so passing `selected.repo.id` straight through would retrigger
  // the children's $effects — tearing down and redialing their WebSockets (and
  // the daemon-side PTY) on every refresh. A $derived string only propagates
  // when its value actually changes.
  const sid = $derived(selected?.repo.id ?? '')
  const sstatus = $derived(selected?.status ?? '')
  // What the terminal would attach to (mirrors service.openTerminal): the tmux
  // session, a pod shell, or nothing. Keying the terminal on this — instead of
  // the raw status — keeps it connected across status flips that don't change
  // the attach target (BUILDING → RUNNING_MANAGED, RUNNING → CRASHED), so it
  // stops redialing mid-session.
  const sterm = $derived(
    !selected ? 'none' : selected.hasSession ? 'tmux' : selected.pods.length ? 'pod' : 'none',
  )

  // Only the verbs that make sense for the repo's current state (spec §7).
  const ACTIONS: Record<RepoStatus, Verb[]> = {
    STOPPED: ['start', 'build'],
    DEPLOYED: ['start', 'build', 'stop'],
    BUILDING: ['stop'],
    RUNNING_MANAGED: ['restart', 'stop'],
    RUNNING_EXTERNAL: ['start', 'restart', 'stop'],
    CRASHED: ['restart', 'stop'],
  }
  const verbs = $derived(
    selected
      ? ACTIONS[selected.status].filter((v) => v !== 'restart' || selected.repo.workload)
      : [],
  )

  async function act(verb: Verb, id = selected?.repo.id) {
    if (!id || busy) return
    busy = { id, verb }
    try {
      await runVerb(id, verb)
      await refresh()
    } catch (e) {
      toast = `${verb} failed: ${e instanceof Error ? e.message : String(e)}`
      setTimeout(() => (toast = null), 4000)
    } finally {
      busy = null
    }
  }
</script>

<header>
  <h1>dev<b>dock</b></h1>
  <span class="conn" class:on={connected}>
    <span class="cdot" class:on={connected}></span>
    {connected ? 'daemon connected' : 'daemon offline'}
  </span>
</header>

<main>
  <aside>
    <RepoList
      {repos}
      {selectedId}
      busyId={busy?.id ?? null}
      onselect={(id) => (selectedId = id)}
      onstart={(id) => act('start', id)}
    />
  </aside>

  <section class="detail">
    {#if selected}
      <div class="head">
        <div class="title">
          <span class="dot {selected.status}"></span>
          <h2>{selected.repo.id}</h2>
          <span class="pill {selected.status}">{selected.status.replace('_', ' ').toLowerCase()}</span>
        </div>
        <div class="actions">
          {#each verbs as v (v)}
            <button
              class:danger={v === 'stop'}
              disabled={busy !== null}
              onclick={() => act(v)}
            >{v === 'stop' ? 'kill' : v}</button>
          {/each}
        </div>
      </div>

      <div class="meta">
        <code>{selected.repo.path}</code>
        <span>· {selected.pods.length} pod{selected.pods.length === 1 ? '' : 's'}</span>
        {#if selected.status === 'DEPLOYED'}<span>· deployment present, scaled to 0</span>{/if}
        {#if selected.repo.ports.length}<span>· :{selected.repo.ports.join(' :')}</span>{/if}
      </div>

      <div class="streams">
        <div class="block">
          <div class="bhead"><h3>Logs</h3></div>
          {#key sid + sstatus}
            <LogViewer id={sid} />
          {/key}
        </div>

        <div class="block">
          <div class="bhead">
            <h3>Terminal</h3>
            <div class="modes">
              <button class:active={mode === 'ro'} onclick={() => (mode = 'ro')}>read-only</button>
              <button class:active={mode === 'rw'} onclick={() => (mode = 'rw')}>read-write</button>
            </div>
          </div>
          {#key sid + mode + sterm}
            <Terminal id={sid} {mode} />
          {/key}
        </div>
      </div>
    {:else}
      <div class="placeholder"><p>Select a repo to view its logs and terminal.</p></div>
    {/if}
  </section>
</main>

{#if toast}<div class="toast">{toast}</div>{/if}

<style>
  header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px 24px;
    border-bottom: 1px solid var(--line);
    flex: none;
  }
  h1 {
    font-family: var(--mono);
    font-size: 20px;
    margin: 0;
    letter-spacing: -0.02em;
  }
  h1 b {
    color: var(--accent);
  }
  .conn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .cdot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--danger);
  }
  .cdot.on {
    background: var(--ok);
  }

  main {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 320px 1fr;
    gap: 16px;
    padding: 16px 24px 24px;
  }
  aside {
    min-height: 0;
  }

  .detail {
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .title h2 {
    margin: 0;
    font-size: 18px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pill {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 3px 8px;
    border-radius: 999px;
    border: 1px solid var(--line);
    color: var(--muted);
    white-space: nowrap;
  }
  .pill.RUNNING_MANAGED {
    color: var(--ok);
    border-color: color-mix(in srgb, var(--ok) 40%, transparent);
  }
  .pill.RUNNING_EXTERNAL {
    color: var(--warn);
    border-color: color-mix(in srgb, var(--warn) 40%, transparent);
  }
  .pill.CRASHED {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
  }
  .pill.BUILDING {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .pill.DEPLOYED {
    color: #9fb6cc;
    border-color: #46566a;
  }

  .actions {
    display: flex;
    gap: 6px;
  }
  .actions button {
    text-transform: capitalize;
  }
  .actions button.danger:hover {
    border-color: var(--danger);
    color: var(--danger);
  }

  .meta {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--muted);
  }
  .meta code {
    font-size: 12px;
  }

  .streams {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-rows: 1fr 1fr;
    gap: 12px;
  }
  .block {
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .bhead {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h3 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    margin: 0;
  }
  .modes {
    display: flex;
    gap: 4px;
  }
  .modes button {
    font-size: 11px;
    padding: 3px 8px;
  }
  .modes button.active {
    border-color: var(--accent);
    color: var(--accent);
  }

  .placeholder {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    border: 1px dashed var(--line);
    border-radius: 12px;
  }

  .toast {
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: var(--panel2);
    border: 1px solid var(--danger);
    color: var(--ink);
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 13px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
</style>
