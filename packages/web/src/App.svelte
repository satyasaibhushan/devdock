<script lang="ts">
  import AuthBanner from './lib/AuthBanner.svelte'
  import ConfirmModal from './lib/ConfirmModal.svelte'
  import LogViewer from './lib/LogViewer.svelte'
  import NamespacePicker from './lib/NamespacePicker.svelte'
  import RepoList from './lib/RepoList.svelte'
  import StartupModal from './lib/StartupModal.svelte'
  import TerminalPanel from './lib/TerminalPanel.svelte'
  import {
    type AuthState,
    type NamespaceInfo,
    type RepoState,
    type Verb,
    STATUS_VERBS,
    adoptRepo,
    fetchAuth,
    fetchNamespace,
    fetchRepos,
    openEvents,
    runVerb,
    switchNamespace,
  } from './lib/api'

  let repos = $state<RepoState[]>([])
  let selectedId = $state<string | null>(null)
  // The repo whose startup-script modal is open, or null when none.
  let customizingId = $state<string | null>(null)
  const customizing = $derived(repos.find((r) => r.repo.id === customizingId) ?? null)
  // Which workload the detail pane acts on for a multi-workload repo. Null means
  // "follow the repo default"; a value sticks until the user picks another.
  let pickedType = $state<string | null>(null)
  let connected = $state(false)
  let busy = $state<{ id: string; verb: Verb } | null>(null)
  let toast = $state<string | null>(null)
  // The kube context's namespace + the selectable list (null until first fetch).
  let nsInfo = $state<NamespaceInfo | null>(null)
  let nsBusy = $state(false)
  // Kubernetes OIDC auth (null until first fetch / older daemon).
  let auth = $state<AuthState | null>(null)
  // The "move external session here" confirmation flow.
  let confirmAdopt = $state(false)
  let adoptBusy = $state(false)

  async function refresh() {
    try {
      repos = await fetchRepos()
      connected = true
      if (!selectedId && repos.length) selectedId = repos[0]?.repo.id ?? null
    } catch {
      connected = false
    }
    // Polled alongside repos so a `kn` run in a terminal shows up here too.
    // Skipped mid-switch so the poll can't flash the old namespace back.
    if (!nsBusy) {
      try {
        nsInfo = await fetchNamespace()
      } catch {
        /* older daemon or offline — the picker just stays hidden */
      }
    }
    try {
      auth = await fetchAuth()
    } catch {
      /* older daemon or offline — the banner just stays hidden */
    }
  }

  // Switch the kube context's namespace (what `kn <ns>` does), then re-pull
  // everything so statuses reflect the new namespace right away.
  async function changeNamespace(ns: string) {
    if (nsBusy) return
    nsBusy = true
    try {
      nsInfo = await switchNamespace(ns)
      await refresh()
    } catch (e) {
      toast = `namespace switch failed: ${e instanceof Error ? e.message : String(e)}`
      setTimeout(() => (toast = null), 4000)
      throw e // lets the picker snap its select back
    } finally {
      nsBusy = false
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

  // A repo can deploy several workloads (api/cron/worker) off one config. The
  // detail pane works one workload at a time; the dropdown picks which. Single-
  // workload repos have one entry (type ''), no dropdown.
  const workloads = $derived(selected?.workloads ?? [])
  const showSelector = $derived((selected?.repo.workloads?.length ?? 0) > 1)
  // The active workload: the user's pick if the repo still offers it, else the
  // repo default, else the first. `selected` is a fresh object each poll, so
  // matching by type (not identity) keeps the selection across refreshes.
  const active = $derived.by(() => {
    if (!workloads.length) return null
    return (
      workloads.find((w) => w.type === pickedType) ??
      workloads.find((w) => w.type === selected?.repo.defaultWorkload) ??
      workloads[0]
    )
  })
  // What to send the daemon as ?workload= — only for repos that have workloads
  // (type carries meaning there); undefined for plain single-workload repos.
  const wl = $derived(selected?.repo.workloads?.length ? active?.type : undefined)
  const workloadLabel = $derived.by(() => {
    if (!selected) return null
    if (showSelector) return null
    if (selected.repo.codeArea === 'frontend') return 'ui'
    if (wl && wl !== 'api') return wl
    return null
  })
  // The status/pods shown and acted on are the active workload's, not the
  // aggregate the list row shows.
  const view = $derived(active ?? null)
  const vstatus = $derived(view?.status ?? selected?.status ?? 'STOPPED')

  // Memoized primitives for the stream children. `selected` is a fresh object
  // every 4s poll, so passing `selected.repo.id` straight through would retrigger
  // the children's $effects — tearing down and redialing their WebSockets (and
  // the daemon-side PTY) on every refresh. A $derived string only propagates
  // when its value actually changes.
  const sid = $derived(selected?.repo.id ?? '')
  const swl = $derived(wl ?? '')
  const sstatus = $derived(vstatus)
  // What the terminal would attach to (mirrors service.openTerminal): the tmux
  // session, a pod shell, or nothing. Keying the terminal on this — instead of
  // the raw status — keeps it connected across status flips that don't change
  // the attach target (BUILDING → RUNNING_MANAGED, RUNNING → CRASHED), so it
  // stops redialing mid-session.
  const sterm = $derived(
    !view ? 'none' : view.hasSession ? 'tmux' : view.pods.length ? 'pod' : 'none',
  )

  const verbs = $derived(selected ? STATUS_VERBS[vstatus] : [])

  // The detail pane acts on the chosen workload (`wl`); a list row acts on the
  // repo's default workload, so it passes its own id and leaves `workload` unset.
  async function act(verb: Verb, id = selected?.repo.id, workload = id === selected?.repo.id ? wl : undefined) {
    if (!id || busy) return
    busy = { id, verb }
    try {
      await runVerb(id, verb, workload)
      await refresh()
    } catch (e) {
      toast = `${verb} failed: ${e instanceof Error ? e.message : String(e)}`
      setTimeout(() => (toast = null), 4000)
    } finally {
      busy = null
    }
  }

  // Take over an externally-managed session: purge it, then start a managed
  // `devspace dev` in its place. Confirmed first since it kills running pods.
  async function doAdopt() {
    const id = selected?.repo.id
    if (!id || adoptBusy) return
    adoptBusy = true
    try {
      await adoptRepo(id, wl)
      await refresh()
      confirmAdopt = false
    } catch (e) {
      toast = `move here failed: ${e instanceof Error ? e.message : String(e)}`
      setTimeout(() => (toast = null), 4000)
    } finally {
      adoptBusy = false
    }
  }
</script>

<header>
  <h1>dev<b>dock</b></h1>
  <span class="conn" class:on={connected}>
    <span class="cdot" class:on={connected}></span>
    {connected ? 'daemon connected' : 'daemon offline'}
  </span>
  <div class="hright">
    {#if auth}
      <AuthBanner {auth} onchanged={(next) => (auth = next)} />
    {/if}
    {#if nsInfo}
      <NamespacePicker
        current={nsInfo.current}
        known={nsInfo.known}
        busy={nsBusy}
        onswitch={changeNamespace}
      />
    {/if}
  </div>
</header>

<main>
  <aside>
    <RepoList
      {repos}
      {selectedId}
      busyId={busy?.id ?? null}
      busyVerb={busy?.verb ?? null}
      onselect={(id) => (selectedId = id)}
      onaction={(id, verb) => act(verb, id)}
      oncustomize={(id) => (customizingId = id)}
    />
  </aside>

  <section class="detail">
    {#if selected}
      <div class="head">
        <div class="title">
          <span class="dot {vstatus}"></span>
          <h2>{selected.repo.id}</h2>
          {#if showSelector}
            <select
              class="wlselect"
              value={active?.type ?? ''}
              onchange={(e) => (pickedType = e.currentTarget.value)}
              aria-label="workload"
            >
              {#each workloads as w (w.type)}
                <option value={w.type}>{w.type}{w.status !== 'STOPPED' ? ' ●' : ''}</option>
              {/each}
            </select>
          {:else if workloadLabel}
            <span class="tag">{workloadLabel}</span>
          {/if}
          <span class="pill {vstatus}">{vstatus.replace('_', ' ').toLowerCase()}</span>
        </div>
        <div class="actions">
          {#if vstatus === 'RUNNING_EXTERNAL'}
            <button
              class="adopt"
              title="stop the external devspace dev process and reconnect here (keeps the dev pod)"
              disabled={busy !== null || adoptBusy}
              onclick={() => (confirmAdopt = true)}
            >move here</button>
          {/if}
          {#each verbs as v (v)}
            <button
              class:danger={v === 'stop'}
              disabled={busy !== null || adoptBusy}
              onclick={() => act(v)}
            >{v === 'stop' ? 'kill' : v === 'clear' ? 'clear pod' : v}</button>
          {/each}
        </div>
      </div>

      <div class="meta">
        <code>{selected.repo.path}</code>
        <span>· {view?.pods.length ?? 0} pod{(view?.pods.length ?? 0) === 1 ? '' : 's'}</span>
        {#if vstatus === 'DEPLOYED'}<span>· deployment present</span>{/if}
        {#if selected.repo.ports.length}<span>· :{selected.repo.ports.join(' :')}</span>{/if}
      </div>

      <div class="streams">
        <div class="block">
          <div class="bhead"><h3>Logs</h3></div>
          {#key sid + swl + sstatus}
            <LogViewer id={sid} workload={wl} />
          {/key}
        </div>

        <div class="block">
          <div class="bhead"><h3>Terminal</h3></div>
          {#key sid + swl + sterm}
            <TerminalPanel id={sid} workload={wl} attach={sterm} />
          {/key}
        </div>
      </div>
    {:else}
      <div class="placeholder"><p>Select a repo to view its logs and terminal.</p></div>
    {/if}
  </section>
</main>

{#if customizing}
  {#key customizing.repo.id}
    <StartupModal
      repoId={customizing.repo.id}
      initial={customizing.startupCommand ?? ''}
      onclose={() => (customizingId = null)}
      onsaved={(id, command) => {
        const r = repos.find((x) => x.repo.id === id)
        if (r) r.startupCommand = command || undefined
      }}
    />
  {/key}
{/if}

{#if confirmAdopt && selected}
  <ConfirmModal
    title="Move external session here?"
    message={`This stops the external "devspace dev" process driving ${selected.repo.id}${wl ? ` (${wl})` : ''} — the running dev pod is kept — then reconnects by running devspace dev here, so devdock manages it. No purge or redeploy; other services are untouched.`}
    confirmLabel="Move here"
    busy={adoptBusy}
    onconfirm={doAdopt}
    oncancel={() => (confirmAdopt = false)}
  />
{/if}

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
  /* right-aligned header controls (the namespace selector) */
  .hright {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 14px;
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
  .pill.BUILDING,
  .pill.RESTARTING {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .pill.DEPLOYED {
    color: #9fb6cc;
    border-color: #46566a;
  }

  .wlselect {
    font-family: var(--mono);
    font-size: 11px;
    padding: 3px 6px;
    border-radius: 6px;
    border: 1px solid var(--line);
    background: var(--panel2);
    color: var(--ink);
    cursor: pointer;
  }
  .wlselect:hover {
    border-color: var(--accent);
  }
  /* The active workload's type, shown when it isn't the plain `api` default. */
  .tag {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 3px 8px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--accent);
    white-space: nowrap;
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
  .actions button.adopt {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
    color: var(--accent);
  }
  .actions button.adopt:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 28%, transparent);
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
