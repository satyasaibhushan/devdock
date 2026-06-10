<script lang="ts">
  import { FitAddon } from '@xterm/addon-fit'
  import { Terminal } from '@xterm/xterm'
  import { openTerminal } from './api'

  let { id, mode }: { id: string; mode: 'ro' | 'rw' } = $props()
  let host: HTMLDivElement
  let error = $state<string | null>(null)

  $effect(() => {
    error = null
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
    ws.onmessage = (ev) => {
      const data = String(ev.data)
      // The daemon sends a JSON envelope when it can't attach a PTY.
      if (data.startsWith('{') && data.includes('"type":"error"')) {
        try {
          const msg = JSON.parse(data)
          if (msg.type === 'error') {
            error = String(msg.error ?? 'terminal unavailable')
            return
          }
        } catch {
          /* not an envelope — fall through and render */
        }
      }
      term.write(data)
    }
    ws.onerror = () => {
      error = 'connection to daemon lost'
    }
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

<div class="wrap">
  <div class="term" bind:this={host} class:hidden={error !== null}></div>
  {#if error}
    <div class="overlay">
      <p class="title">Terminal unavailable</p>
      <p class="msg">{error}</p>
      <p class="hint">
        Attaches the dev session — or a pod shell if the deployment was started outside devdock.
        Nothing running? Start it first.
      </p>
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
    height: 100%;
    min-height: 0;
  }
  .term {
    height: 100%;
    padding: 8px;
    background: #0b0f14;
    border: 1px solid var(--line);
    border-radius: 10px;
  }
  .term.hidden {
    visibility: hidden;
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    background: #0b0f14;
    border: 1px solid var(--line);
    border-radius: 10px;
    text-align: center;
    padding: 20px;
  }
  .title {
    margin: 0;
    color: var(--ink);
    font-weight: 600;
  }
  .msg {
    margin: 0;
    color: var(--danger);
    font-family: var(--mono);
    font-size: 12px;
  }
  .hint {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 12px;
  }
</style>
