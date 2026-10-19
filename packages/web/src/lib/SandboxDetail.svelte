<script lang="ts">
  import {
    type InstanceView,
    type Operation,
    type RepoState,
    type SandboxAction,
    type SandboxControllerStatus,
    type SandboxMember,
    type SandboxOperation,
    type SandboxView,
    buildSandbox,
    fetchOperations,
    sandboxAction,
    updateSandbox,
  } from './api'
  import ConfirmModal from './ConfirmModal.svelte'
  import Icon from './Icon.svelte'
  import SandboxLogs from './SandboxLogs.svelte'
  import SandboxMemberForm from './SandboxMemberForm.svelte'
  import { expiryLabel, memberBuildState, memberKey, relativeTime } from './sandboxUi'

  let {
    sandbox,
    picked,
    addingMember = $bindable(false),
    repos,
    instance,
    instances,
    controller,
    initialOperationId = '',
    onchanged,
  }: {
    sandbox: SandboxView
    picked: SandboxMember | null
    addingMember?: boolean
    /** Candidate members: the daemon instance's repos. */
    repos: RepoState[]
    instance: string
    instances: InstanceView[]
    controller: SandboxControllerStatus | null
    /** The create operation, so a just-made sandbox shows its progress at once. */
    initialOperationId?: string
    onchanged: () => void
  } = $props()

  let error = $state('')
  let busy = $state(false)
  let confirm = $state<'expire' | 'delete' | null>(null)
  let copied = $state('')
  let now = $state(Date.now())
  let operation = $state<Operation | null>(null)
  let dismissedOperation = $state('')

  const memberKeys = $derived(sandbox.members.map(memberKey))
  const activity = $derived([...sandbox.activity].sort((a, b) => b.at - a.at))
  const expired = $derived(!sandbox.slot)
  const operationActive = $derived(operation?.state === 'active')
  const locked = $derived(busy || operationActive || sandbox.state === 'creating')
  const leader = $derived(
    controller?.holder
      ? (instances.find((i) => i.id === controller.holder)?.name ?? controller.holder)
      : null,
  )

  // Sandbox operations are keyed `sandbox:<key>`; the latest one is the
  // progress line, and an active one holds the actions until it settles.
  $effect(() => {
    const key = sandbox.key
    const machine = instance
    const initial = initialOperationId
    let disposed = false
    let polling = false
    operation = null
    dismissedOperation = ''
    async function poll() {
      if (polling) return
      polling = true
      try {
        const ops = await fetchOperations(`sandbox:${key}`, machine)
        if (disposed) return
        operation =
          ops.find((op) => op.id === initial && op.state === 'active') ??
          [...ops].sort((a, b) => b.createdAt - a.createdAt)[0] ??
          null
      } catch {
        /* the detail still renders from the polled sandbox view */
      } finally {
        polling = false
      }
    }
    void poll()
    const timer = setInterval(() => {
      now = Date.now()
      void poll()
    }, 3000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  })

  async function run(work: () => Promise<SandboxOperation>) {
    if (locked) return
    busy = true
    error = ''
    try {
      await work()
      confirm = null
      addingMember = false
      onchanged()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }
  const act = (action: SandboxAction) => run(() => sandboxAction(sandbox.key, action, instance))
  const buildAll = () => run(() => buildSandbox(sandbox.key, {}, instance))
  const buildRepo = (m: SandboxMember) =>
    run(() => buildSandbox(sandbox.key, { repo: m.repo }, instance))
  const remove = (m: SandboxMember) =>
    run(() =>
      updateSandbox(sandbox.key, { remove: [{ repo: m.repo, workload: m.workload }] }, instance),
    )

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      copied = url
      setTimeout(() => (copied = ''), 1500)
    } catch {
      error = 'Could not copy the URL'
    }
  }

</script>

<div class="head">
  <div class="title">
    <span class="dot {sandbox.power}" title="power: {sandbox.power}"></span>
    <h2 title={sandbox.key}>{sandbox.key}</h2>
    <span class="badge {sandbox.state}">{sandbox.state}</span>
    {#if sandbox.title}<span class="subtitle" title={sandbox.title}>{sandbox.title}</span>{/if}
  </div>
  <div class="actions">
    <button
      class="btn"
      title="Scale every deployment up"
      disabled={locked || expired || sandbox.power === 'awake'}
      onclick={() => act('wake')}
    >Wake</button>
    <button
      class="btn"
      title="Scale every deployment to zero; the slot stays leased"
      disabled={locked || expired || sandbox.power === 'asleep'}
      onclick={() => act('sleep')}
    >Sleep</button>
    <button
      class="btn primary"
      title={expired ? 'Lease a slot and build every member' : 'Build every member from its checkout'}
      disabled={locked || sandbox.members.length === 0}
      onclick={buildAll}
    >{expired ? 'Rebuild' : 'Build'}</button>
    <button
      class="btn"
      title="Uninstall sandbox releases and free the slot; the sandbox can be rebuilt later"
      disabled={locked || expired}
      onclick={() => (confirm = 'expire')}
    >Expire</button>
    <button class="btn danger" disabled={locked} onclick={() => (confirm = 'delete')}>Delete</button>
  </div>
</div>

<div class="meta">
  {#if sandbox.slot}<span class="fact mono" title="personal namespace suffix"><Icon name="layers" size={12} />{sandbox.slot}</span>{/if}
  {#if sandbox.power !== 'unknown'}<span class="fact">{sandbox.power}</span>{/if}
  <span class="fact" class:due={!!sandbox.slot && sandbox.expiresAt <= now}>{expiryLabel(sandbox, now)}</span>
  <span class="spacer"></span>
  <details class="pop">
    <summary>Activity<span class="secs">{activity.length}</span></summary>
    <div class="card">
      <ol class="activity">
        {#each activity as entry (entry.at + entry.actor + entry.action)}
          <li>
            <span class="who">{entry.actor}</span>
            <span class="what">{entry.action}</span>
            <span class="detail" title={entry.detail}>{entry.detail ?? ''}</span>
            <time title={new Date(entry.at).toLocaleString()}>{relativeTime(entry.at, now)}</time>
          </li>
        {:else}<li class="muted">No activity yet.</li>{/each}
      </ol>
    </div>
  </details>
  {#if operation && (operationActive || (operation.state !== 'succeeded' && dismissedOperation !== operation.id))}
    <details class="pop">
      <summary class:failed={!operationActive}>
        {#if operationActive}<span class="spin"></span>{operation.action === 'destroy' ? 'Releasing' : 'Building'}
        {:else}<Icon name="alert" size={12} />{operation.state}{/if}
        <span class="secs">{relativeTime(operation.createdAt, operationActive ? now : operation.updatedAt)}</span>
      </summary>
      <div class="card">
        <code class="muted">{operation.id}</code>
        {#each operation.logs as line (line.at + line.message)}
          <div class="log"><time>{new Date(line.at).toLocaleTimeString()}</time> {line.message}</div>
        {:else}<div class="log muted">{operation.stage}…</div>{/each}
      </div>
    </details>
    {#if !operationActive}
      <button class="dismiss" aria-label="Dismiss operation result" onclick={() => (dismissedOperation = operation?.id ?? '')}><Icon name="x" size={11} /></button>
    {/if}
  {/if}
</div>

{#if sandbox.urls.length}
  <div class="urls">
    {#each sandbox.urls as url (url)}
      <span class="chip">
        <a href={url} target="_blank" rel="noreferrer" title={url}>
          <span class="url">{url.replace(/^https?:\/\//, '')}</span>
          <Icon name="external" size={11} />
        </a>
        <button class="copy" title="Copy URL" aria-label="Copy {url}" onclick={() => copy(url)}>
          <Icon name={copied === url ? 'check' : 'copy'} size={11} />
        </button>
      </span>
    {/each}
  </div>
{/if}

{#if error}<p class="error" role="alert"><Icon name="alert" size={13} /><span>{error}</span></p>{/if}

{#if addingMember}
  <div class="add">
    <SandboxMemberForm
      {repos}
      taken={memberKeys}
      disabled={locked}
      onadd={(member) => run(() => updateSandbox(sandbox.key, { add: [member] }, instance))}
    />
    <button class="btn ghost sm" onclick={() => (addingMember = false)}>Cancel</button>
  </div>
{/if}

<div class="pane">
  <div class="pane-head">
    <span class="pane-title">Logs</span>
    {#if picked}
      <span class="pane-sub">{picked.repo} · {picked.workload}</span>
      <span class="bst {picked.build.state}">{memberBuildState(picked)}</span>
      {#if picked.build.error}<span class="berr" title={picked.build.error}>{picked.build.error}</span>{/if}
      <span class="spacer"></span>
      <button class="btn sm" title="Rebuild {picked.repo} from its checkout" disabled={locked || expired} onclick={() => picked && buildRepo(picked)}>Build</button>
      <button class="btn sm quiet" title="Remove {picked.repo} {picked.workload} from the sandbox" disabled={locked} onclick={() => picked && remove(picked)}>Remove</button>
    {/if}
  </div>
  <div class="pane-body">
    {#if expired}
      <div class="placeholder">Rebuild the sandbox to read logs.</div>
    {:else if !picked}
      <div class="placeholder">Add a member to read its logs.</div>
    {:else if sandbox.power === 'asleep'}
      <div class="placeholder">The sandbox is asleep. Wake it to read logs.</div>
    {:else}
      {#key `${instance}:${sandbox.key}:${memberKey(picked)}`}
        <SandboxLogs sandbox={sandbox.key} repo={picked.repo} workload={picked.workload} {instance} />
      {/key}
    {/if}
  </div>
</div>

<footer class="controller" title="The one daemon that sleeps idle sandboxes and expires old ones">
  {#if !controller}controller status unavailable
  {:else}
    controller: {leader ? `${leader}${controller.isLeader ? ' (this machine)' : ''}` : 'no leader'}
    {#if controller.lastPollAt}· polled {relativeTime(controller.lastPollAt, now)} ago{/if}
    {#if controller.lastError}· <span class="cerr">{controller.lastError}</span>{/if}
  {/if}
</footer>

{#if confirm}
  <ConfirmModal
    title="{confirm === 'delete' ? 'Delete' : 'Expire'} {sandbox.key}?"
    message={confirm === 'delete'
      ? `Uninstalls every member's release, frees ${sandbox.slot ?? 'its slot'} and removes the sandbox record and its activity.`
      : `Uninstalls every member's release and frees ${sandbox.slot ?? 'its slot'}. The record stays, so the sandbox can be rebuilt into a free slot later.`}
    confirmLabel={confirm === 'delete' ? 'Delete sandbox' : 'Expire sandbox'}
    danger
    {busy}
    onconfirm={() => confirm && act(confirm)}
    oncancel={() => (confirm = null)}
  />
{/if}

<style>
  /* Header and meta mirror the repo detail so the two views read as siblings. */
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
    font-family: var(--mono);
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.01em;
    white-space: nowrap;
  }
  .subtitle {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-2);
    font-size: 13.5px;
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
    font-size: 13px;
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
    font-size: 12.5px;
  }
  .fact.due {
    color: var(--warn);
  }

  .spacer {
    flex: 1;
  }

  /* Activity and the operation result: chips that open a card, like
     WorkflowPanel's, so neither takes room from the logs. */
  .pop {
    position: relative;
  }
  .pop summary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 7px;
    cursor: pointer;
    list-style: none;
    border-radius: var(--r-1);
    white-space: nowrap;
    user-select: none;
  }
  .pop summary::-webkit-details-marker {
    display: none;
  }
  .pop summary:hover,
  .pop[open] > summary {
    color: var(--ink);
    background: var(--bg-2);
  }
  .pop summary.failed {
    color: var(--danger);
  }
  .secs {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
  }
  .card {
    position: absolute;
    z-index: 20;
    top: 100%;
    right: 0;
    margin-top: 6px;
    padding: 10px 12px;
    width: max-content;
    max-width: min(520px, 75vw);
    max-height: 320px;
    overflow: auto;
    background: var(--bg-2);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-2);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    font-size: 12.5px;
  }
  .card code {
    overflow-wrap: anywhere;
    font-size: 12px;
  }
  .log {
    margin-top: 6px;
    overflow-wrap: anywhere;
  }
  .log time {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
  }
  .dismiss {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border: 0;
    border-radius: var(--r-1);
    background: transparent;
    color: var(--muted);
    padding: 0;
  }
  .dismiss:hover {
    color: var(--ink);
    background: var(--bg-2);
  }
  .spin {
    width: 10px;
    height: 10px;
    border: 1.5px solid color-mix(in srgb, var(--accent) 30%, transparent);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .error {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 0;
    padding: 8px 16px;
    font-size: 13px;
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 8%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--danger) 30%, var(--line));
    overflow-wrap: anywhere;
  }
  .error :global(svg) {
    margin-top: 2px;
  }
  .muted {
    color: var(--muted);
  }

  .urls {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--line);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    height: 24px;
    background: var(--bg-2);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-1);
    overflow: hidden;
  }
  .chip a {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    height: 100%;
    padding: 0 8px;
    color: var(--accent);
    text-decoration: none;
    font-family: var(--mono);
    font-size: 12px;
  }
  .chip a:hover {
    background: var(--bg-3);
  }
  .url {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 320px;
  }
  .copy {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 100%;
    border: 0;
    border-left: 1px solid var(--line-strong);
    background: transparent;
    color: var(--muted);
    padding: 0;
  }
  .copy:hover {
    color: var(--ink);
    background: var(--bg-3);
  }
  .add {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--line);
  }
  .add :global(.member-form) {
    flex: 1 1 auto;
  }

  /* The selected member's logs fill the rest, as in the repo view. */
  .pane {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .pane-head {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 10px 0 16px;
    flex: none;
    font-size: 12px;
    color: var(--muted);
    border-bottom: 1px solid var(--line);
  }
  .pane-title {
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .pane-sub {
    font-family: var(--mono);
    white-space: nowrap;
  }
  .bst {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ok);
  }
  .bst.idle {
    color: var(--muted);
  }
  .bst.building,
  .bst.queued {
    color: var(--accent);
  }
  .bst.failed {
    color: var(--danger);
  }
  .berr {
    min-width: 0;
    flex: 0 1 auto;
    color: var(--danger);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pane-body {
    flex: 1;
    min-height: 0;
  }
  .placeholder {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    color: var(--muted);
    background: var(--term-bg);
    text-align: center;
  }
  .activity {
    margin: 0;
    padding: 0;
    list-style: none;
    min-width: 320px;
  }
  .activity li {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr) auto;
    align-items: baseline;
    gap: 8px;
    padding: 3px 0;
  }
  .activity li.muted {
    display: block;
  }
  .who {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--accent);
  }
  .what {
    color: var(--ink);
  }
  .detail {
    max-width: 260px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .activity time {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--muted);
    white-space: nowrap;
  }

  .controller {
    flex: none;
    padding: 5px 16px;
    font-size: 11.5px;
    color: var(--muted);
    border-top: 1px solid var(--line);
    background: var(--bg-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cerr {
    color: var(--warn);
  }
</style>
