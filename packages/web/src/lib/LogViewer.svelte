<script lang="ts">
  import { openLogs } from './api'

  let { id, workload, instance = '' }: { id: string; workload?: string; instance?: string } = $props()

  // Hard cap on retained lines — the pane is a recent-history view, not an
  // archive. Old lines are purged as new ones arrive so a long-running session
  // can't grow the DOM/memory without bound. (The daemon's per-workload ring
  // buffer is capped at 1000 lines too, so this is also all it can replay.)
  const MAX_LINES = 1000

  // Lines carry a monotonic seq used as the render key: when old lines are
  // purged the survivors keep their keys, so Svelte only mounts the new rows
  // instead of re-rendering the whole pane on every message.
  type Line = { seq: number; text: string }
  let lines = $state<Line[]>([])
  let box: HTMLDivElement

  $effect(() => {
    // re-subscribe whenever the selected repo (or workload) changes.
    lines = []
    let seq = 0
    // Chatty services can emit hundreds of lines a second; a state update per
    // WebSocket message would re-render per line. Buffer and flush per frame.
    let pending: Line[] = []
    let raf = 0
    const flush = () => {
      raf = 0
      lines = [...lines, ...pending].slice(-MAX_LINES)
      pending = []
      queueMicrotask(() => box?.scrollTo(0, box.scrollHeight))
    }
    const ws = openLogs(id, workload, instance)
    ws.onmessage = (ev) => {
      pending.push({ seq: seq++, text: String(ev.data) })
      if (pending.length > MAX_LINES) pending = pending.slice(-MAX_LINES)
      if (!raf) raf = requestAnimationFrame(flush)
    }
    return () => {
      if (raf) cancelAnimationFrame(raf)
      ws.close()
    }
  })
</script>

<div class="logs" bind:this={box}>
  {#each lines as line (line.seq)}<div class="line">{line.text}</div>{:else}<div class="empty">Waiting for log output…</div>{/each}
</div>

<style>
  .logs {
    height: 100%; min-height: 0; overflow-y: auto;
    background: #0b0f14; border: 1px solid var(--line); border-radius: 10px;
    padding: 10px; font-family: var(--mono); font-size: 12px; line-height: 1.5;
    color: #c9d6e2; white-space: pre-wrap; word-break: break-all;
  }
  .line { min-height: 1em; }
  .empty { color: var(--muted); }
</style>
