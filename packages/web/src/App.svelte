<script lang="ts">
  import { globalRepos, workloadTarget, instanceEndpoint, instanceSymbol, retainOwners } from './lib/globalRepos'
  import AuthBanner from './lib/AuthBanner.svelte'
  import InstancePanel from './lib/InstancePanel.svelte'
  import ConfirmModal from './lib/ConfirmModal.svelte'
  import Icon from './lib/Icon.svelte'
  import LogViewer from './lib/LogViewer.svelte'
  import MoveModal from './lib/MoveModal.svelte'
  import NamespacePicker from './lib/NamespacePicker.svelte'
  import ReplicaModal from './lib/ReplicaModal.svelte'
  import RepoList from './lib/RepoList.svelte'
  import StartupModal from './lib/StartupModal.svelte'
  import TerminalPanel from './lib/TerminalPanel.svelte'
  import WorkflowPanel from './lib/WorkflowPanel.svelte'
  import { beginOperation, type Operation } from './lib/api'
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
    moveDeployment,
    openEvents,
    switchNamespace,
    stopSession,
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
  // False until the first /instances round-trip settles, so the empty sidebar
  // reads as "connecting" rather than "no repos" or "offline".
  let loaded = $state(false)
  let busy = $state<{ id: string; verb: Verb } | null>(null)
  let activeOperation = $state<Operation | null>(null)
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
  let stoppingSession = $state(false)
  async function stopDevSession() {
    if (!selected || stoppingSession) return
    stoppingSession = true
    try {
      await stopSession(sid, wl, target(sid, wl))
      await refresh()
    } catch (error) {
      toast = error instanceof Error ? error.message : String(error)
      setTimeout(() => toast = null, 5000)
    } finally { stoppingSession = false }
  }

  // Moving the selected workload's deployment to another machine.
  let moveTarget = $state<InstanceView | null>(null)
  let moveBusy = $state(false)
  // Machines with this checkout; new work and moves can only target those.
  const machines = $derived(instances.filter((i) => i.repos.some((r) => r.repo.id === sid)))
  function pickMachine(select: HTMLSelectElement) {
    const id = select.value
    const from = view?.ownerInstanceId
    if (!from) return chooseInstance(id)
    // Stay on the owner until the move is confirmed.
    select.value = from
    if (id !== from) moveTarget = instances.find((i) => i.id === id) ?? null
  }
  // The local daemon runs the whole sequence (release or take-over, then the
  // planned follow-up on the target); the modal has already shown that plan.
  async function doMove() {
    const to = moveTarget
    if (!to || moveBusy) return
    moveBusy = true
    try {
      const result = await moveDeployment(sid, wl, to.id)
      // The follow-up runs on the new owner; hold the actions until its
      // WorkflowPanel picks the operation up from /operations.
      if (result.operation) activeOperation = result.operation
      chooseInstance(to.id)
      moveTarget = null
    } catch (error) {
      toast = `move failed: ${error instanceof Error ? error.message : String(error)}`
      setTimeout(() => (toast = null), 5000)
    } finally {
      moveBusy = false
    }
  }

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
    loaded = true
    // Polled alongside repos so a `kn` run in a terminal shows up here too.
    // Skipped mid-switch so the poll can't flash the old namespace back.
    if (!nsBusy) {
      try {
        const id = controlEndpoint
        const next = await fetchNamespace(id)
        if (id === controlEndpoint) nsInfo = next
      } catch {
        /* older daemon or offline — the picker just stays hidden */
      }
    }
    try {
      const id = controlEndpoint
      const next = await fetchAuth(id)
      if (id === controlEndpoint) auth = next
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
      nsInfo = await switchNamespace(ns, controlEndpoint)
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
  const controlInstance = $derived(selectedId === HOST_ID ? preferredInstance : owner ?? preferredInstance)
  const controlEndpoint = $derived(controlInstance ? instanceEndpoint(controlInstance) : '')
  $effect(() => { void controlEndpoint; auth = null; nsInfo = null; void refresh() })
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
  // Badge text: the running operation's stage wins over the polled status.
  const statusText = $derived(
    activeOperation?.repo === sid
      ? activeOperation.stage
      : vstatus === 'BUILDING'
        ? 'starting'
        : vstatus.replace('_', ' ').toLowerCase(),
  )

  const verbs = $derived(view?.actions ?? selected?.actions ?? [])
  const VERB_LABEL: Record<Verb, string> = {
    start: 'Start',
    build: 'Build',
    build_start: 'Build + start',
    restart: 'Restart',
    destroy: 'Destroy',
  }

  // The detail pane acts on the chosen workload (`wl`); a list row acts on the
  // repo's default workload, so it passes its own id and leaves `workload` unset.
  async function act(verb: Verb, id = selected?.repo.id, workload?: string) {
    if (!id || busy) return
    busy = { id, verb }
    try {
      await beginOperation(id, verb, workload, target(id, workload))
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

  const listState = $derived<'loading' | 'offline' | 'ready'>(
    !loaded ? 'loading' : connected ? 'ready' : 'offline',
  )
  const podCount = $derived(view?.pods.length ?? 0)
</script>

<header class="topbar">
  <h1 class="brand">dev<b>dock</b></h1>
  <InstancePanel {instances} onrefresh={refresh} />
  <div class="hright">
    {#if auth}
      {#key controlEndpoint}<AuthBanner {auth} instance={controlEndpoint} onchanged={(next) => (auth = next)} />{/key}
    {/if}
    {#if nsInfo}
      <NamespacePicker
        current={nsInfo.current}
        known={nsInfo.known}
        busy={nsBusy}
        onswitch={changeNamespace}
      />
    {/if}
    <span class="conn" class:on={connected} title={connected ? 'The local daemon is answering' : 'The local daemon is not answering; retrying every 4s'}>
      <span class="cdot"></span>
      {connected ? 'daemon connected' : 'daemon offline'}
    </span>
  </div>
</header>

<main>
  <aside>
    <div class="repos">
      <RepoList
        {repos}
        {selectedId}
        {instances}
        listState={listState}
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
      <Icon name="terminal" size={13} />
      <span>All terminals</span>
    </button>
  </aside>

  <section class="detail">
    {#if selectedId === HOST_ID}
      <div class="head">
        <div class="title">
          <span class="ticon"><Icon name="terminal" size={14} /></span>
          <h2>All terminals</h2>
          <label class="ctl">on
            <select class="sel mono" value={preferred} onchange={(e) => chooseInstance(e.currentTarget.value)} aria-label="Host terminal machine">
              {#each instances as item (item.id)}<option value={item.id}>{item.name}{item.online ? '' : ' (offline)'}</option>{/each}
            </select>
          </label>
        </div>
      </div>
      <div class="meta">
        <span class="fact">Every live DevDock terminal on this machine, including agent-created sessions</span>
      </div>
      <div class="streams solo">
        <div class="pane tpane">
          {#key preferred}
            {#if preferredInstance?.online}<TerminalPanel instance={preferredEndpoint} machine={preferredInstance.name} all />
            {:else}<div class="placeholder"><Icon name="unplug" size={18} /><p>This instance is offline.</p></div>{/if}
          {/key}
        </div>
      </div>
    {:else if selected}
      <div class="head">
        <div class="title">
          <span class="dot {vstatus}"></span>
          <h2 title={selected.repo.id}>{selected.repo.id}</h2>
          <span class="badge {vstatus}">{statusText}</span>
          <span class="ctls">
            <select
              class="sel mono"
              title={view?.ownerInstanceId ? `Deployed from ${owner?.name ?? 'an unlinked instance'}. Pick another machine to move it.` : 'Machine for new work'}
              value={view?.ownerInstanceId ?? owner?.id ?? preferred}
              onchange={(e) => pickMachine(e.currentTarget)}
              aria-label="Machine"
              disabled={busy !== null || moveBusy || activeOperation !== null}
            >
              {#each machines as item (item.id)}<option value={item.id} disabled={!item.online}>{instanceSymbol(item)} {item.name}{item.online ? '' : ' (offline)'}</option>{/each}
              {#if view?.ownerInstanceId && !owner}<option value={view.ownerInstanceId} disabled>? unlinked owner</option>{/if}
            </select>
            {#if family.length > 1}
              <select
                class="sel mono"
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
                class="sel mono"
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
          </span>
        </div>
        <div class="actions">
          {#if view?.hasSession && !view.unavailable}
            <button class="btn" title="Stop the dev session and automatic reconnect. Keep the deployment." disabled={stoppingSession} onclick={stopDevSession}>{stoppingSession ? 'Stopping…' : 'Stop session'}</button>
          {/if}
          {#if vstatus === 'RUNNING_EXTERNAL' && !view?.unavailable}
            <button
              class="btn primary"
              title="stop the external devspace dev process and reconnect here (keeps the dev pod)"
              disabled={busy !== null || adoptBusy || stoppingSession}
              onclick={() => (confirmAdopt = true)}
            >Move here</button>
          {/if}
          {#each verbs as v (v)}
            <button
              class="btn"
              class:danger={v === 'destroy'}
              disabled={busy !== null || adoptBusy || stoppingSession || activeOperation !== null}
              onclick={() => act(v, sid, wl)}
            >{VERB_LABEL[v]}</button>
          {/each}
        </div>
      </div>

      <div class="meta">
        <span class="fact" title="pods for this workload"><Icon name="layers" size={12} />{podCount} pod{podCount === 1 ? '' : 's'}</span>
        {#if selected.repo.ports.length}<span class="fact mono">:{selected.repo.ports.join(' :')}</span>{/if}
        {#if selected.repo.parentId}
          <span class="fact mono">/{selected.repo.id}/</span>
        {/if}
        {#if !view?.unavailable}
          {#key ownerEndpoint + sid + swl}
            <WorkflowPanel repo={sid} workload={wl} instance={ownerEndpoint} onoperation={(operation) => activeOperation = operation} />
          {/key}
        {/if}
      </div>

      {#if view?.unavailable}
        <div class="placeholder warn">
          <Icon name="alert" size={18} />
          <p>{owner ? `${owner.name} is unavailable or ownership could not be verified.` : 'Connect the instance that owns this deployment.'} Existing ownership is preserved.</p>
        </div>
      {:else}
      <!-- The terminal is the dev session; without one there is nothing to attach to. -->
      <div class="streams" class:solo={!view?.hasSession}>
        <div class="pane">
          <div class="pane-head">
            <span class="pane-title">Logs</span>
            {#if wl}<span class="pane-sub">{wl}</span>{/if}
          </div>
          <div class="pane-body">
            {#key ownerEndpoint + sid + swl + sstatus}
              <LogViewer id={sid} workload={wl} instance={ownerEndpoint} />
            {/key}
          </div>
        </div>

        {#if view?.hasSession}
          <div class="pane tpane">
            {#key ownerEndpoint + sid + swl}
              <TerminalPanel repo={sid} workload={wl} attach={sterm} instance={ownerEndpoint} machine={owner?.name ?? 'machine'} />
            {/key}
          </div>
        {/if}
      </div>
      {/if}
    {:else if listState === 'loading'}
      <div class="placeholder"><span class="spin"></span><p>Connecting to the daemon…</p></div>
    {:else if listState === 'offline' && repos.length === 0}
      <div class="placeholder warn"><Icon name="unplug" size={18} /><p>The daemon is offline. Retrying every few seconds.</p></div>
    {:else if repos.length === 0}
      <div class="placeholder"><Icon name="inbox" size={18} /><p>No DevSpace repos discovered on any linked machine.</p></div>
    {:else}
      <div class="placeholder"><Icon name="layers" size={18} /><p>Select a repo to view its logs and terminal.</p></div>
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

{#if moveTarget && selected}
  {#key moveTarget.id + sid + swl}
    <MoveModal
      repo={sid}
      workload={wl}
      to={moveTarget}
      {owner}
      busy={moveBusy}
      onconfirm={doMove}
      oncancel={() => (moveTarget = null)}
    />
  {/key}
{/if}

{#if toast}<div class="toast" role="alert"><Icon name="alert" size={14} /><span>{toast}</span></div>{/if}

<style>
  /* ---- header ---- */
  .topbar {
    display: flex;
    align-items: center;
    gap: 14px;
    height: 44px;
    padding: 0 14px;
    background: var(--bg-1);
    border-bottom: 1px solid var(--line);
    flex: none;
  }
  .brand {
    margin: 0 4px 0 0;
    font-family: var(--mono);
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.02em;
    white-space: nowrap;
  }
  .brand b {
    color: var(--accent);
    font-weight: 600;
  }
  /* Both header groups may shrink (chip labels ellipsise) so two auth chips
     plus three machines still fit on one 1280px row without clipping. */
  .hright {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex: 0 1 auto;
  }
  .conn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }
  .cdot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--danger);
  }
  .conn.on .cdot {
    background: var(--ok);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 18%, transparent);
  }

  /* ---- body ---- */
  main {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr);
  }
  @media (max-width: 1100px) {
    main {
      grid-template-columns: 240px minmax(0, 1fr);
    }
    .conn {
      font-size: 0;
      gap: 0;
    }
  }
  /* The daemon dot alone carries the state once the header gets crowded. */
  @media (max-width: 1440px) {
    .conn {
      font-size: 0;
      gap: 0;
    }
  }
  aside {
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-1);
    border-right: 1px solid var(--line);
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
    height: 36px;
    padding: 0 14px;
    border: none;
    border-top: 1px solid var(--line);
    background: none;
    color: var(--muted);
    font-size: 12px;
    font-weight: 500;
    text-align: left;
  }
  .hostbtn:hover {
    color: var(--ink);
    background: var(--bg-2);
  }
  .hostbtn.selected {
    color: var(--ink);
    background: var(--bg-3);
    box-shadow: inset 2px 0 0 var(--accent);
  }

  /* ---- detail ---- */
  .detail {
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-0);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    min-height: 48px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--line);
  }
  .title {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .title h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ticon {
    display: inline-flex;
    color: var(--accent);
  }
  .ctls {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin-left: 6px;
    min-width: 0;
  }
  /* Replica names carry their branch; keep one long branch from eating the row. */
  .ctls .sel {
    max-width: 220px;
  }
  .ctl {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--muted);
    font-size: 12px;
  }
  /* The active workload's type, shown when it isn't the plain `api` default. */
  .tag {
    font-family: var(--mono);
    font-size: 10.5px;
    padding: 2px 6px;
    border-radius: var(--r-1);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    white-space: nowrap;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    min-height: 32px;
    padding: 4px 16px;
    font-size: 12px;
    color: var(--muted);
    border-bottom: 1px solid var(--line);
    background: var(--bg-1);
  }
  .fact {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }
  .fact.mono {
    font-family: var(--mono);
    font-size: 11.5px;
  }

  .streams {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
  }
  /* Host view / no session: the one pane gets the whole column. */
  .streams.solo {
    grid-template-rows: minmax(0, 1fr);
  }
  .pane {
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .pane + .pane {
    border-top: 1px solid var(--line-strong);
  }
  .pane-head {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 16px;
    flex: none;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    border-bottom: 1px solid var(--line);
  }
  .pane-sub {
    font-family: var(--mono);
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    color: var(--muted);
  }
  .pane-body {
    flex: 1;
    min-height: 0;
  }

  .placeholder {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 24px;
    color: var(--muted);
    text-align: center;
  }
  .placeholder p {
    margin: 0;
    max-width: 420px;
    font-size: 13px;
    line-height: 1.5;
  }
  .placeholder.warn {
    color: var(--warn);
  }
  .placeholder.warn p {
    color: var(--ink-2);
  }
  .spin {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid var(--line-strong);
    border-top-color: var(--accent);
    animation: rot 0.8s linear infinite;
  }
  @keyframes rot {
    to {
      transform: rotate(360deg);
    }
  }

  .toast {
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 70;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    max-width: 420px;
    padding: 10px 12px;
    background: var(--bg-2);
    border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--line-strong));
    border-left: 3px solid var(--danger);
    border-radius: var(--r-2);
    color: var(--ink);
    font-size: 12.5px;
    line-height: 1.45;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  }
  .toast :global(svg) {
    color: var(--danger);
    margin-top: 2px;
  }
</style>
