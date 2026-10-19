<script lang="ts">
  import { untrack } from 'svelte'
  import { fetchSandboxLogs } from './api'

  // Sandbox pods have no dev session, so there is no log socket to attach to.
  // This pane polls the cursor-based query instead: one tail read, then only
  // what arrived since. Rendering mirrors LogViewer so the two read the same.
  let {
    sandbox,
    repo,
    workload,
    instance,
  }: { sandbox: string; repo: string; workload: string; instance: string } = $props()

  const MAX_LINES = 1000
  const POLL_MS = 3000
  type Line = { seq: number; text: string }
  let lines = $state<Line[]>([])
  let error = $state('')
  let loaded = $state(false)
  let box: HTMLDivElement

  // The parent remounts this pane per member, so the poll starts once. Parent
  // polls can still re-run an effect that tracks props, and a re-run would
  // reset the pane while a slow read is in flight.
  $effect(() => untrack(() => {
    const key = sandbox
    const member = { repo, workload }
    const machine = instance
    let disposed = false
    let reading = false
    let cursor: string | undefined
    let seq = 0
    lines = []
    error = ''
    loaded = false
    async function read() {
      if (reading) return
      reading = true
      try {
        const page = await fetchSandboxLogs(key, member, machine, cursor)
        if (disposed) return
        cursor = page.cursor
        // A stale cursor restarts from the tail; drop what we had so the pane
        // does not show two tails stitched together.
        const fresh = page.lines.map((text) => ({ seq: seq++, text }))
        lines = page.resync ? fresh : [...lines, ...fresh].slice(-MAX_LINES)
        error = ''
        if (fresh.length) queueMicrotask(() => box?.scrollTo(0, box.scrollHeight))
      } catch (e) {
        if (!disposed) error = e instanceof Error ? e.message : String(e)
      } finally {
        reading = false
        if (!disposed) loaded = true
      }
    }
    void read()
    const poll = setInterval(read, POLL_MS)
    return () => {
      disposed = true
      clearInterval(poll)
    }
  }))
</script>

<div class="logs" bind:this={box}>
  {#each lines as line (line.seq)}<div class="line">{line.text}</div>{:else}
    {#if error}<div class="empty err">{error}</div>
    {:else if loaded}<div class="empty">No log output yet.</div>
    {:else}<div class="empty">Loading logs…</div>{/if}
  {/each}
</div>

<style>
  .logs {
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    background: var(--term-bg);
    padding: 8px 16px;
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.5;
    color: #c9d6e2;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .line {
    min-height: 1em;
  }
  .empty {
    color: var(--muted);
    font-family: var(--sans);
  }
  .empty.err {
    color: var(--warn);
  }
</style>
