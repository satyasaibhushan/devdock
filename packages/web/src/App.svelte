<script lang="ts">
  import { globalRepos, workloadTarget, instanceEndpoint, instanceSymbol, retainOwners } from './lib/globalRepos'
  import AuthBanner from './lib/AuthBanner.svelte'
  import InstancePanel from './lib/InstancePanel.svelte'
  import ConfirmModal from './lib/ConfirmModal.svelte'
  import LogViewer from './lib/LogViewer.svelte'
  import NamespacePicker from './lib/NamespacePicker.svelte'
  import ReplicaModal from './lib/ReplicaModal.svelte'
  import RepoList from './lib/RepoList.svelte'
  import StartupModal from './lib/StartupModal.svelte'
  import TerminalPanel from './lib/TerminalPanel.svelte'
  import {
    type AuthState,
    type InstanceView,
    type NamespaceInfo,
    type RepoState,
    type Verb,
    adoptRepo,
    deleteReplica,
    fetchAuth,
    fetchNamespace,
    fetchInstances,
    openEvents,
    runVerb,
    switchNamespace,
  } from './lib/api'

  let instances = $state<InstanceView[]>([])
  let preferred = $state(new URLSearchParams(location.search).get('instance') ?? '')
  const repos = $derived(globalRepos(instances, preferred))
  const preferredInstance = $derived(instances.find((i) => i.id === preferred))
  const preferredEndpoint = $derived(preferredInstance ? instanceEndpoint(preferredInstance) : '')
  function target(id: string, type?: string): string {
    const workload = workloadTarget(repos.find((r) => r.repo.id === id), type)
    const machine = instances.find((i) => i.id === workload?.instanceId)
    if (!machine?.online || workload?.unavailable) throw new Error('Deployment owner unavailable. Reconnect its instance or restore Kubernetes access.')
    return instanceEndpoint(machine)
  }
  function chooseInstance(id: string) {
    preferred = id
    const url = new URL(location.href)
    url.searchParams.set('instance', id)
    history.replaceState(null, '', url)
    auth = null; nsInfo = null
    void refresh()
  }
  let selectedId = $state<string | null>(new URLSearchParams(location.search).get('repo'))
  // Sentinel selection for the host-machine terminal view (no repo attached).
  const HOST_ID = '@host'
  // The repo whose startup-script modal is open, or null when none.
  let customizingId = $state<string | null>(null)
  const customizing = $derived(repos.find((r) => r.repo.id === customizingId) ?? null)
  const startupTypes = (r: RepoState) =>
    r.repo.workloads?.length
      ? r.repo.workloads
      : [r.repo.workloadType ?? (r.repo.codeArea === 'frontend' ? 'ui' : 'api')]
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
  // The repo whose branch-picker (new replica) modal is open, or null.
  let replicatingId = $state<string | null>(null)
  // The replica pending delete confirmation, or null.
  let deletingReplicaId = $state<string | null>(null)
  let replicaDeleteBusy = $state(false)

  let refreshing = false
  async function refresh() {
    if (refreshing) return
    refreshing = true
    try {
      const next = await fetchInstances()
      instances = retainOwners(next, instances)
      if (!instances.some((i) => i.id === preferred)) preferred = instances.find((i) => i.local)?.id ?? instances[0]?.id ?? ''
      connected = true
      if (!selectedId && repos.length) selectedId = repos[0]?.repo.id ?? null
    } catch {
      connected = false
    }
    // Polled alongside repos so a `kn` run in a terminal shows up here too.
    // Skipped mid-switch so the poll can't flash the old namespace back.
    if (!nsBusy) {
      try {
        const id = preferred
        const next = await fetchNamespace(preferredEndpoint)
        if (id === preferred) nsInfo = next
      } catch {
        /* older daemon or offline — the picker just stays hidden */
      }
    }
    try {
      const id = preferred
      const next = await fetchAuth(preferredEndpoint)
      if (id === preferred) auth = next
    } catch {
      /* older daemon or offline — the banner just stays hidden */
    }
    refreshing = false
  }

  // Switch the kube context's namespace (what `kn <ns>` does), then re-pull
  // everything so statuses reflect the new namespace right away.
  async function changeNamespace(ns: string) {
    if (nsBusy) return
    nsBusy = true
    try {
      nsInfo = await switchNamespace(ns, preferredEndpoint)
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
  const owner = $derived(instances.find((i) => i.id === view?.instanceId))
  const ownerEndpoint = $derived(owner ? instanceEndpoint(owner) : '')
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
  // session, a pod shell, or nothing. Passed to TerminalPanel as a live prop —
  // NOT part of its {#key}: this value can flap during reconciles, and keying
  // on it remounted the whole panel, redialing every viewer socket (visible as
  // all terminals flashing). The panel re-ensures its primary terminal itself
  // when this changes.
  const sterm = $derived(
    !view ? 'none' : view.hasSession ? 'tmux' : view.pods.length ? 'pod' : 'none',
  )

  const verbs = $derived(view?.actions ?? selected?.actions ?? [])

  // The detail pane acts on the chosen workload (`wl`); a list row acts on the
  // repo's default workload, so it passes its own id and leaves `workload` unset.
  async function act(verb: Verb, id = selected?.repo.id, workload?: string) {
    if (!id || busy) return
    busy = { id, verb }
    try {
      await runVerb(id, verb, workload, target(id, workload))
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
      await adoptRepo(id, wl, target(id, wl))
      await refresh()
      confirmAdopt = false
    } catch (e) {
      toast = `move here failed: ${e instanceof Error ? e.message : String(e)}`
      setTimeout(() => (toast = null), 4000)
    } finally {
      adoptBusy = false
    }
  }

  // The selected repo's family: its parent (or itself) plus that parent's
  // replicas — feeds the replica selector in the detail pane.
  const familyRoot = $derived.by(() => {
    if (!selected) return null
    if (!selected.repo.parentId) return selected
    return repos.find((r) => r.repo.id === selected.repo.parentId) ?? selected
  })
  const family = $derived(
    familyRoot
      ? [familyRoot, ...repos.filter((r) => r.repo.parentId === familyRoot.repo.id)]
      : [],
  )

  // Tear down a replica: pods, alias ingress, worktree — the parent untouched.
  async function doReplicaDelete() {
    const id = deletingReplicaId
    if (!id || replicaDeleteBusy) return
    replicaDeleteBusy = true
    try {
      await deleteReplica(id, target(id))
      if (selectedId === id) selectedId = repos.find((r) => r.repo.id === id)?.repo.parentId ?? null
      deletingReplicaId = null
      await refresh()
    } catch (e) {
      toast = `delete replica failed: ${e instanceof Error ? e.message : String(e)}`
      setTimeout(() => (toast = null), 4000)
    } finally {
      replicaDeleteBusy = false
    }
  }
</script>

<header>
  <h1>dev<b>dock</b></h1>
  <InstancePanel {instances} value={preferred} onchange={chooseInstance} onrefresh={refresh} />
  <span class="conn" class:on={connected}>
    <span class="cdot" class:on={connected}></span>
    {connected ? 'daemon connected' : 'daemon offline'}
  </span>
  <div class="hright">
    {#if auth}
      {#key preferred}<AuthBanner {auth} instance={preferredEndpoint} onchanged={(next) => (auth = next)} />{/key}
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
    <div class="repos">
      <RepoList
        {repos}
        {selectedId}
        {instances}
        busyId={busy?.id ?? null}
        busyVerb={busy?.verb ?? null}
        onselect={(id) => (selectedId = id)}
        onaction={(id, verb) => act(verb, id)}
        oncustomize={(id) => (customizingId = id)}
        onreplicate={(id) => (replicatingId = id)}
        onreplicadelete={(id) => (deletingReplicaId = id)}
      />
    </div>
    <button
      class="hostbtn"
      class:selected={selectedId === HOST_ID}
      title="shells on this machine — shared with agents"
      onclick={() => (selectedId = HOST_ID)}
    >
      <span class="hicon">❯_</span> host terminals
    </button>
  </aside>

  <section class="detail">
    {#if selectedId === HOST_ID}
      <div class="head">
        <div class="title">
          <h2>host</h2>
          <span class="pill">{instanceSymbol(preferredInstance)} {preferredInstance?.name ?? 'No instance'}</span>
        </div>
      </div>
      <div class="meta">
        <span>login shells on this machine — the same host:t1/t2/… terminals agents use</span>
      </div>
      <div class="streams solo">
        <div class="block">
          <div class="bhead"><h3>Terminal</h3></div>
          {#key preferred}
            {#if preferredInstance?.online}<TerminalPanel instance={preferredEndpoint} />
            {:else}<p class="placeholder">This instance is offline.</p>{/if}
          {/key}
        </div>
      </div>
    {:else if selected}
      <div class="head">
        <div class="title">
          <span class="dot {vstatus}"></span>
          <h2>{selected.repo.id}</h2>
          {#if view?.ownerInstanceId}
            <span class="pill" title="Deployment owner">{instanceSymbol(owner)} {owner?.name ?? 'Owner not connected'}</span>
          {:else}
            <span class="pill" title="No confirmed deployment owner. This is the action target only.">target: {owner?.name ?? 'Unavailable'}</span>
          {/if}
          {#if family.length > 1}
            <select
              class="wlselect"
              value={selected.repo.id}
              onchange={(e) => (selectedId = e.currentTarget.value)}
              aria-label="replica"
            >
              {#each family as f (f.repo.id)}
                <option value={f.repo.id}>
                  {f.repo.parentId
                    ? `${f.repo.id.slice(f.repo.parentId.length + 1)} · ${f.repo.branch ?? ''}`
                    : 'primary'}
                </option>
              {/each}
            </select>
          {/if}
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
          {#if vstatus === 'RUNNING_EXTERNAL' && !view?.unavailable}
            <button
              class="adopt"
              title="stop the external devspace dev process and reconnect here (keeps the dev pod)"
              disabled={busy !== null || adoptBusy}
              onclick={() => (confirmAdopt = true)}
            >move here</button>
          {/if}
          {#each verbs as v (v)}
            <button
              class:danger={v === 'destroy'}
              disabled={busy !== null || adoptBusy}
              onclick={() => act(v, sid, wl)}
            >{v === 'build_start' ? 'build + start' : v}</button>
          {/each}
        </div>
      </div>

      <div class="meta">
        <code>{selected.repo.path}</code>
        {#if selected.repo.parentId}
          <span>· branch {selected.repo.branch}</span>
          <span>· url /{selected.repo.id}/</span>
        {/if}
        <span>· {view?.pods.length ?? 0} pod{(view?.pods.length ?? 0) === 1 ? '' : 's'}</span>
        {#if vstatus === 'DEPLOYED'}<span>· deployment present</span>{/if}
        {#if selected.repo.ports.length}<span>· :{selected.repo.ports.join(' :')}</span>{/if}
      </div>

      {#if view?.unavailable}
        <div class="placeholder"><p>{owner ? `${owner.name} is unavailable or ownership could not be verified.` : 'Connect the instance that owns this deployment.'} Existing ownership is preserved.</p></div>
      {:else}
      <div class="streams">
        <div class="block">
          <div class="bhead"><h3>Logs</h3></div>
          {#key ownerEndpoint + sid + swl + sstatus}
            <LogViewer id={sid} workload={wl} instance={ownerEndpoint} />
          {/key}
        </div>

        <div class="block">
          <div class="bhead"><h3>Terminal</h3></div>
          {#key ownerEndpoint + sid + swl}
            <TerminalPanel repo={sid} workload={wl} attach={sterm} instance={ownerEndpoint} />
          {/key}
        </div>
      </div>
      {/if}
    {:else}
      <div class="placeholder"><p>Select a repo to view its logs and terminal.</p></div>
    {/if}
  </section>
</main>

{#if customizing && !customizing.workloads.some((w) => w.unavailable)}
  {#key customizing.repo.id}
    <StartupModal
      instanceFor={(type) => target(customizing.repo.id, customizing.repo.workloads?.length ? type : undefined)}
      repoId={customizing.repo.id}
      podTypes={startupTypes(customizing)}
      initial={customizing.startupCommands ?? {}}
      onclose={() => (customizingId = null)}
      onsaved={(id, commands) => {
        const r = repos.find((x) => x.repo.id === id)
        if (r) {
          r.startupCommands = commands
          const defaultType = r.repo.defaultWorkload ?? startupTypes(r)[0]
          r.startupCommand = defaultType ? commands[defaultType] || undefined : undefined
        }
      }}
    />
  {/key}
{/if}

{#if replicatingId}
  {#key replicatingId}
    <ReplicaModal
      {preferred}
      repoId={replicatingId}
      onclose={() => (replicatingId = null)}
      oncreated={async (rec) => {
        await refresh()
        selectedId = rec.id
      }}
    />
  {/key}
{/if}

{#if deletingReplicaId}
  <ConfirmModal
    title="Delete {deletingReplicaId}?"
    message={`This kills ${deletingReplicaId}'s pods, removes its /${deletingReplicaId}/ ingress and deletes its worktree. The parent repo and its running pods are untouched.`}
    confirmLabel="Delete replica"
    danger
    busy={replicaDeleteBusy}
    onconfirm={doReplicaDelete}
    oncancel={() => (deletingReplicaId = null)}
  />
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
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  aside .repos {
    flex: 1;
    min-height: 0;
  }
  .hostbtn {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px;
    border: 1px dashed var(--line);
    border-radius: 10px;
    background: none;
    color: var(--muted);
    font-size: 12px;
    cursor: pointer;
    text-align: left;
  }
  .hostbtn:hover {
    border-color: var(--accent);
    color: var(--ink);
  }
  .hostbtn.selected {
    border-style: solid;
    border-color: var(--accent);
    color: var(--ink);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .hicon {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--accent);
  }
  /* Host view: the terminal block gets the whole column (no logs pane). */
  .streams.solo {
    grid-template-rows: 1fr;
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
