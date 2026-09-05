<script lang="ts">
  import { beginOperation, fetchCheckout, fetchOperations, runPrerequisites, type Checkout, type CheckResult, type Operation } from './api'
  let { repo, workload, instance, onoperation }: { repo: string; workload?: string; instance: string; onoperation: (operation: Operation | null) => void } = $props()
  let checkout = $state<Checkout | null>(null)
  let operation = $state<Operation | null>(null)
  let checks = $state<CheckResult[] | null>(null)
  let busy = $state(false)
  let error = $state('')
  let now = $state(Date.now())
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
  async function verify() {
    busy = true
    try { operation = await beginOperation(repo, 'verify', workload, instance); onoperation(operation); error = '' }
    catch (e) { error = e instanceof Error ? e.message : 'Cannot start verification' }
    finally { busy = false }
  }
</script>

<div class="workflow">
  <div class="checkout" title="Checkout on this machine, not a pod-sync guarantee">
    <span class="muted">checkout</span>
    {#if checkout}
      <span>{checkout.machine}</span><code>{checkout.path}</code>
      <span>{checkout.branch ?? 'detached / unknown'}</span><code>{checkout.commit ?? 'commit unknown'}</code>
      {#if checkout.dirty !== false}<span class="dirty">{checkout.dirty === null ? 'changes unknown' : 'modified'}</span>{/if}
    {:else}<span class="muted">unavailable</span>{/if}
  </div>
  <div class="controls">
    <button disabled={busy || operation?.state === 'active'} onclick={check}>{busy ? 'Working…' : 'Check prerequisites'}</button>
    <button disabled={busy || operation?.state === 'active'} onclick={verify} title="Deploy if stopped, start dev if needed, then check the configured endpoint">Deploy · dev · verify</button>
    {#if operation}
      <span class="state" class:failed={operation.state === 'failed' || operation.state === 'interrupted'}>{operation.state === 'active' ? operation.stage : operation.state}</span>
      <span class="muted">{Math.max(0, Math.floor(((operation.state === 'active' ? now : operation.updatedAt) - operation.createdAt) / 1000))}s</span>
    {/if}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if checks}
    {#if checks.length === 0}<p class="muted">No machine-specific prerequisites configured.</p>{/if}
    {#each checks as check (check.id)}<div class="check"><span class:failed={check.status !== 'passed'}>{check.status}</span> {check.label} <span class="muted">{check.detail}</span></div>{/each}
  {/if}
  {#if operation}
    <details>
      <summary>Operation <code>{operation.id.slice(0, 8)}</code></summary>
      <code class="muted">{operation.id} · {operation.namespace}</code>
      {#each operation.checks as check (check.id)}<div class="check"><span class:failed={check.status !== 'passed'}>{check.status}</span> {check.label} <span class="muted">{check.detail}</span></div>{/each}
      {#each operation.logs as line}<div class="log"><time>{new Date(line.at).toLocaleTimeString()}</time> {line.message}</div>{/each}
    </details>
  {/if}
</div>

<style>
  .workflow { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; font-size: 12px; }
  .checkout, .controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .checkout { margin-bottom: 8px; }
  code { overflow-wrap: anywhere; }
  .muted, time { color: var(--muted); }
  .dirty { color: #e0b962; }
  .failed, .error { color: #f87171; }
  .state { color: var(--accent); }
  button { font: inherit; color: var(--ink); background: var(--surface, #18202a); border: 1px solid var(--line); border-radius: 5px; padding: 5px 8px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  details { margin-top: 8px; }
  summary { cursor: pointer; color: var(--muted); }
  .check, .log { margin-top: 6px; overflow-wrap: anywhere; }
</style>
