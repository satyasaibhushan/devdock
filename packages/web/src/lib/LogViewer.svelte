<script lang="ts">
  import { openLogs } from './api'

  let { id }: { id: string } = $props()
  let lines = $state<string[]>([])
  let box: HTMLDivElement

  $effect(() => {
    // re-subscribe whenever the selected repo changes.
    lines = []
    const ws = openLogs(id)
    ws.onmessage = (ev) => {
      lines = [...lines.slice(-999), String(ev.data)]
      queueMicrotask(() => box?.scrollTo(0, box.scrollHeight))
    }
    return () => ws.close()
  })
</script>

<div class="logs" bind:this={box}>
  {#each lines as line, i (i)}<div class="line">{line}</div>{:else}<div class="empty">Waiting for log output…</div>{/each}
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
