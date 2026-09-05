<script lang="ts">
  import { fetchCheckout, fetchOperations, runPrerequisites, type Checkout, type CheckResult, type Operation } from './api'
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
</script>

<div class="workflow">
  <details class="checkout">
    <summary title="Checkout details, not a pod-sync guarantee">
    {#if checkout}
      <span class="branch">{checkout.branch ?? 'detached / unknown'}</span><span>·</span><code>{checkout.commit?.slice(0, 7) ?? 'unknown'}</code>
      {#if checkout.dirty !== false}<span class="dirty">{checkout.dirty === null ? 'changes unknown' : 'modified'}</span>{/if}
    {:else}<span class="muted">Checkout unavailable</span>{/if}
    <span aria-hidden="true">⌄</span>
    </summary>
    <div class="checkout-detail">
      {#if checkout}<code>{checkout.path}</code>{/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
  </details>
  <details class="checks-menu">
    <summary>Checks</summary>
    <div class="checkout-detail">
    <button disabled={busy || operation?.state === 'active'} onclick={check}>{busy ? 'Working…' : 'Check prerequisites'}</button>
  {#if checks}
    {#if checks.length === 0}<p class="muted">No machine-specific prerequisites configured.</p>{/if}
    {#each checks as check (check.id)}<div class="check"><span class:failed={check.status !== 'passed'}>{check.status}</span> {check.label} <span class="muted">{check.detail}</span></div>{/each}
  {/if}
    </div>
  </details>
  {#if operation && (operation.state === 'active' || ((operation.state === 'failed' || operation.state === 'interrupted') && dismissed !== operation.id))}
    <details class="operation">
      <summary class:failed={operation.state !== 'active'}>{operation.state === 'active' ? 'Activity' : operation.state} · {Math.max(0, Math.floor(((operation.state === 'active' ? now : operation.updatedAt) - operation.createdAt) / 1000))}s</summary>
      <div class="checkout-detail">
      <code class="muted">{operation.id} · {operation.namespace}</code>
      {#each operation.checks as check (check.id)}<div class="check"><span class:failed={check.status !== 'passed'}>{check.status}</span> {check.label} <span class="muted">{check.detail}</span></div>{/each}
      {#each operation.logs as line}<div class="log"><time>{new Date(line.at).toLocaleTimeString()}</time> {line.message}</div>{/each}
      </div>
    </details>
    {#if operation.state !== 'active'}<button class="dismiss" aria-label="Dismiss operation failure" onclick={() => dismissed = operation!.id}>×</button>{/if}
  {/if}
</div>

<style>
  .workflow { display: flex; gap: 16px; align-items: center; min-width: 0; font-size: 12px; }
  .checkout { min-width: 0; }
  .checkout summary { display: flex; gap: 8px; align-items: center; }
  .branch { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; }
  .checkout-detail { position: absolute; z-index: 20; top: 100%; left: 0; margin-top: 8px; padding: 12px; width: max-content; max-width: min(520px, 75vw); max-height: 320px; overflow: auto; background: var(--panel, #161d25); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 8px 24px #0006; }
  code { overflow-wrap: anywhere; }
  .muted, time { color: var(--muted); }
  .dirty { color: #e0b962; }
  .failed, .error { color: #f87171; }
  button { font: inherit; color: var(--ink); background: var(--surface, #18202a); border: 1px solid var(--line); border-radius: 5px; padding: 5px 8px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  details { position: relative; }
  summary { cursor: pointer; color: var(--muted); }
  summary:hover { color: var(--ink); }
  .dismiss { border: 0; background: transparent; padding: 0 4px; color: var(--muted); }
  .check, .log { margin-top: 6px; overflow-wrap: anywhere; }
</style>
