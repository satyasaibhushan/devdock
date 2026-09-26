<script lang="ts">
  import { fetchCheckout, fetchOperations, runPrerequisites, type Checkout, type CheckResult, type Operation } from './api'
  import Icon from './Icon.svelte'
  let { repo, workload, instance, onoperation }: { repo: string; workload?: string; instance: string; onoperation: (operation: Operation | null) => void } = $props()
  let checkout = $state<Checkout | null>(null)
  let operation = $state<Operation | null>(null)
  let checks = $state<CheckResult[] | null>(null)
  let busy = $state(false)
  let error = $state('')
  let now = $state(Date.now())
  let dismissed = $state('')
  $effect(() => {
    const id = repo, type = workload, machine = instance
    let disposed = false
    let polling = false
    checkout = null; operation = null; checks = null; error = ''; onoperation(null)
    async function refresh() {
      if (polling) return
      polling = true
      try {
        const [meta, operations] = await Promise.all([fetchCheckout(id, type, machine), fetchOperations(id, machine)])
        if (disposed) return
        checkout = meta
        operation = operations.filter((op) => op.workload === (type ?? '')).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
        onoperation(operation?.state === 'active' ? operation : null)
        error = ''
      } catch (e) { if (!disposed) error = e instanceof Error ? e.message : 'Machine unavailable' }
      finally { polling = false }
    }
    void refresh()
    const poll = setInterval(() => { now = Date.now(); void refresh() }, 4000)
    return () => { disposed = true; clearInterval(poll) }
  })
  async function check() {
    busy = true
    try { checks = await runPrerequisites(repo, workload, instance); error = '' }
    catch (e) { error = e instanceof Error ? e.message : 'Checks unavailable' }
    finally { busy = false }
  }
  const elapsed = $derived(
    operation ? Math.max(0, Math.floor(((operation.state === 'active' ? now : operation.updatedAt) - operation.createdAt) / 1000)) : 0,
  )
</script>

<!-- Root is display:contents so the chips sit as siblings in the parent's
     meta strip; the checks/activity chips push to its right edge. -->
<div class="workflow">
  <details class="checkout">
    <summary title="Checkout details, not a pod-sync guarantee">
      <Icon name="branch" size={12} />
      {#if checkout}
        <span class="branch">{checkout.branch ?? 'detached / unknown'}</span><code>{checkout.commit?.slice(0, 7) ?? 'unknown'}</code>
        {#if checkout.dirty !== false}<span class="dirty">{checkout.dirty === null ? 'changes unknown' : 'modified'}</span>{/if}
      {:else}<span class="muted">Checkout unavailable</span>{/if}
    </summary>
    <div class="card">
      {#if checkout}<code class="path">{checkout.path}</code>{/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
  </details>
  <details class="checks-menu">
    <summary>Checks<Icon name="chevron-down" size={11} /></summary>
    <div class="card right">
      <button class="btn sm" disabled={busy || operation?.state === 'active'} onclick={check}>{busy ? 'Working…' : 'Check prerequisites'}</button>
      {#if checks}
        {#if checks.length === 0}<p class="muted">No machine-specific prerequisites configured.</p>{/if}
        {#each checks as check (check.id)}<div class="check"><span class="st" class:failed={check.status !== 'passed'}>{check.status}</span> {check.label} <span class="muted">{check.detail}</span></div>{/each}
      {/if}
    </div>
  </details>
  {#if operation && (operation.state === 'active' || ((operation.state === 'failed' || operation.state === 'interrupted') && dismissed !== operation.id))}
    <details class="operation">
      <summary class:failed={operation.state !== 'active'}>
        {#if operation.state === 'active'}<span class="spin"></span>Activity{:else}<Icon name="alert" size={12} />{operation.state}{/if}
        <span class="secs">{elapsed}s</span>
      </summary>
      <div class="card right">
        <code class="muted">{operation.id} · {operation.namespace}</code>
        {#each operation.checks as check (check.id)}<div class="check"><span class="st" class:failed={check.status !== 'passed'}>{check.status}</span> {check.label} <span class="muted">{check.detail}</span></div>{/each}
        {#each operation.logs as line}<div class="log"><time>{new Date(line.at).toLocaleTimeString()}</time> {line.message}</div>{/each}
      </div>
    </details>
    {#if operation.state !== 'active'}<button class="dismiss" aria-label="Dismiss operation failure" onclick={() => dismissed = operation!.id}><Icon name="x" size={11} /></button>{/if}
  {/if}
</div>

<style>
  .workflow {
    display: contents;
    font-size: 12px;
  }
  details {
    position: relative;
    min-width: 0;
  }
  .checkout {
    min-width: 0;
  }
  /* Push the action chips to the right edge of the meta strip. */
  .checks-menu {
    margin-left: auto;
  }
  summary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 7px;
    cursor: pointer;
    color: var(--muted);
    list-style: none;
    border-radius: var(--r-1);
    white-space: nowrap;
    user-select: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover,
  details[open] > summary {
    color: var(--ink);
    background: var(--bg-2);
  }
  summary:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: -1px;
  }
  summary.failed {
    color: var(--danger);
  }
  .branch {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 240px;
    color: var(--ink-2);
  }
  summary code {
    color: var(--muted);
    font-size: 11px;
  }
  .secs {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  .card {
    position: absolute;
    z-index: 20;
    top: 100%;
    left: 0;
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
  }
  .card.right {
    left: auto;
    right: 0;
  }
  code {
    overflow-wrap: anywhere;
  }
  .path {
    font-size: 11px;
    color: var(--ink-2);
  }
  .muted,
  time {
    color: var(--muted);
  }
  time {
    font-family: var(--mono);
    font-size: 11px;
  }
  .dirty {
    color: var(--warn);
    font-size: 11px;
  }
  .st {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ok);
  }
  .failed,
  .error {
    color: var(--danger);
  }
  .error {
    margin: 6px 0 0;
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
  .check,
  .log {
    margin-top: 6px;
    overflow-wrap: anywhere;
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
</style>
