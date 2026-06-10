<script lang="ts">
  import { FitAddon } from '@xterm/addon-fit'
  import { WebglAddon } from '@xterm/addon-webgl'
  import { Terminal } from '@xterm/xterm'
  import { openTerminal, sendResize } from './api'

  let { id, mode }: { id: string; mode: 'ro' | 'rw' } = $props()
  let host: HTMLDivElement
  let error = $state<string | null>(null)

  // xterm measures glyphs on a canvas, where CSS variables never resolve —
  // an unresolved var() breaks cell metrics (and the WebGL renderer). Resolve
  // the app's mono stack to a concrete font list up front.
  const monoStack = () =>
    getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() ||
    'ui-monospace, Menlo, Consolas, monospace'

  $effect(() => {
    error = null
    const term = new Terminal({
      fontFamily: monoStack(),
      fontSize: 12,
      cursorBlink: mode === 'rw',
      disableStdin: mode === 'ro',
      scrollback: 5000,
      theme: { background: '#0b0f14', foreground: '#c9d6e2' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    // GPU renderer — the DOM renderer relayouts on every write and is the
    // main source of sluggish output. Fall back silently where WebGL is
    // unavailable (headless, software GL).
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      /* DOM renderer fallback */
    }
    fit.fit()

    // Dial in at the fitted size so the PTY (and tmux) renders full-pane from
    // the first frame instead of an 80x24 postage stamp.
    const ws = openTerminal(id, mode, term.cols, term.rows)
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

    // Refit when the panel itself resizes (not just the window) and keep the
    // daemon-side PTY in sync so tmux redraws at the real size.
    let cols = term.cols
    let rows = term.rows
    const refit = () => {
      fit.fit()
      if (term.cols !== cols || term.rows !== rows) {
        cols = term.cols
        rows = term.rows
        if (ws.readyState === ws.OPEN) sendResize(ws, cols, rows)
      }
    }
    const ro = new ResizeObserver(refit)
    ro.observe(host)

    return () => {
      ro.disconnect()
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
