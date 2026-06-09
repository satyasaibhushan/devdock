<script lang="ts">
  import { FitAddon } from '@xterm/addon-fit'
  import { Terminal } from '@xterm/xterm'
  import { openTerminal } from './api'

  let { id, mode }: { id: string; mode: 'ro' | 'rw' } = $props()
  let host: HTMLDivElement

  $effect(() => {
    const term = new Terminal({
      fontFamily: 'var(--mono)',
      fontSize: 12,
      cursorBlink: mode === 'rw',
      disableStdin: mode === 'ro',
      theme: { background: '#0b0f14', foreground: '#c9d6e2' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    const ws = openTerminal(id, mode)
    ws.onmessage = (ev) => term.write(String(ev.data))
    if (mode === 'rw') term.onData((d) => ws.readyState === ws.OPEN && ws.send(d))

    const onResize = () => fit.fit()
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      ws.close()
      term.dispose()
    }
  })
</script>

<div class="term" bind:this={host}></div>

<style>
  .term {
    height: 280px; padding: 8px;
    background: #0b0f14; border: 1px solid var(--line); border-radius: 8px;
  }
</style>
