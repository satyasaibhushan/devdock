<script lang="ts">
  import { type SandboxView, sandboxAction } from './api'
  import Icon from './Icon.svelte'
  import SandboxCard from './SandboxCard.svelte'

  // Every sandbox as a card, personal first, under a thin rail of the namespace
  // pool. Wake and restore run from here; anything deeper opens the sandbox page.
  let {
    sandboxes,
    instance,
    listState,
    error = '',
    onopen,
    onnew,
    onchanged,
  }: {
    sandboxes: SandboxView[]
    instance: string
    listState: 'loading' | 'offline' | 'ready'
    error?: string
    onopen: (key: string | null) => void
    onnew: () => void
    onchanged: () => void
  } = $props()

  let now = $state(Date.now())
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000)
    return () => clearInterval(timer)
  })
  const pool = $derived(sandboxes[0]?.pool ?? [])
  const tickets = $derived(sandboxes.filter((s) => !s.personal))
  const personal = $derived(sandboxes.find((s) => s.personal) ?? null)
  let busyKey = $state<string | null>(null)
  let actionError = $state('')
  async function act(sandbox: SandboxView, action: 'wake' | 'restore' | 'evict') {
    if (busyKey) return
    busyKey = sandbox.key
    actionError = ''
    try {
      await sandboxAction(sandbox.key, 'wake', instance, { evict: action === 'evict' })
      onchanged()
    } catch (e) {
      actionError = `${sandbox.key}: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      busyKey = null
    }
  }
</script>

<div class="head">
  <div class="title">
    <span class="ticon"><Icon name="box" size={14} /></span>
    <h2>Sandboxes</h2>
  </div>
  <button class="btn primary" onclick={onnew}><Icon name="plus" size={12} />New sandbox</button>
</div>
<div class="rail">
  <span class="lbl">pool</span>
  {#each pool as entry (entry.slot)}
    <span class="sq" class:free={!entry.key} title={entry.key ? `${entry.slot} held by ${entry.key}` : `${entry.slot} is free`}>
      {entry.slot}{entry.key ? ` · ${entry.key}` : ' · free'}
    </span>
  {:else}
    <span class="sq free">no slots configured</span>
  {/each}
</div>
{#if error || actionError}
  <p class="error" role="alert"><Icon name="alert" size={13} /><span>{actionError || error}</span></p>
{/if}
<div class="scroll">
  {#if listState === 'loading' && !sandboxes.length}
    <div class="placeholder"><span class="spin"></span><p>Connecting to the daemon…</p></div>
  {:else if listState === 'offline' && !sandboxes.length}
    <div class="placeholder warn"><Icon name="unplug" size={18} /><p>The daemon is offline. Retrying every few seconds.</p></div>
  {:else}
    <div class="grid">
      {#if personal}
        <SandboxCard sandbox={personal} {now} {onopen} onaction={act} />
      {/if}
      {#each tickets as sandbox (sandbox.key)}
        <SandboxCard {sandbox} {now} busy={busyKey === sandbox.key} {onopen} onaction={act} />
      {:else}
        <p class="empty">No ticket sandboxes yet.</p>
      {/each}
    </div>
  {/if}
</div>

<style>
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 48px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--line);
  }
  .title {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .title h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .ticon {
    display: inline-flex;
    color: var(--accent);
  }
  .head .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .rail {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 14px;
    background: var(--bg-1);
    border-bottom: 1px solid var(--line);
    font-size: 12px;
    color: var(--muted);
  }
  .lbl {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    margin-right: 4px;
  }
  .sq {
    display: inline-flex;
    align-items: center;
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--line-strong);
    border-radius: var(--r-1);
    background: var(--bg-2);
    color: var(--ink-2);
    font-family: var(--mono);
    font-size: 11.5px;
    white-space: nowrap;
  }
  .sq.free {
    border-style: dashed;
    background: transparent;
    color: var(--muted);
  }
  .error {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 0;
    padding: 8px 16px;
    border-bottom: 1px solid var(--line);
    color: var(--danger);
    font-size: 12.5px;
    overflow-wrap: anywhere;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    padding: 12px 14px;
  }
  @media (max-width: 1400px) {
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  .empty {
    grid-column: 1 / -1;
    margin: 24px 0;
    text-align: center;
    color: var(--muted);
    font-size: 13px;
  }
  .placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 48px 24px;
    color: var(--muted);
    text-align: center;
  }
  .placeholder p {
    margin: 0;
    font-size: 14px;
  }
  .placeholder.warn {
    color: var(--warn);
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
</style>
