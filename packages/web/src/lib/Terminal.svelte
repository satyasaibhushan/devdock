<script lang="ts">
  import { FitAddon } from '@xterm/addon-fit'
  import { WebglAddon } from '@xterm/addon-webgl'
  import { Terminal, type IDisposable } from '@xterm/xterm'
  import { onMount } from 'svelte'
  import { attachTerminal, sendResize } from './api'

  // A live viewer on a registered terminal: attaches by id, replays the
  // scrollback, then streams. Closing this component only detaches the
  // viewer — the terminal keeps running for other clients.
  let {
    instance = '',
    tid,
    mode,
    onclosed,
  }: { instance?: string; tid: string; mode: 'ro' | 'rw'; onclosed?: () => void } = $props()
  let host: HTMLDivElement
  let error = $state<string | null>(null)
  let ready = $state(false)
  let term: Terminal | null = null
  let fit: FitAddon | null = null
  let ws: WebSocket | null = null
  let cols = 0
  let rows = 0
  let needsReplay = true

  // The connect effect below must key on the VALUES of tid/mode, not the raw
  // prop reads: the panel rebuilds its TermInfo objects on every 4s poll, and
  // a raw prop read tracks that parent object — re-running the effect (socket
  // teardown + redial, a visible flash) even though the id never changed.
  // $derived memoizes by value, so equal strings don't re-trigger.
  const tidVal = $derived(tid)
  const modeVal = $derived(mode)

  // xterm measures glyphs on a canvas, where CSS variables never resolve —
  // an unresolved var() breaks cell metrics (and the WebGL renderer). Resolve
  // the app's mono stack to a concrete font list up front.
  const monoStack = () =>
    getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() ||
    'ui-monospace, Menlo, Consolas, monospace'

  onMount(() => {
    // NOTE: no `disableStdin` for read-only — it would also swallow the mouse
    // reports that make wheel-scrolling work (tmux mouse mode). Read-only is
    // enforced by only forwarding wheel reports (below), and again daemon-side.
    term = new Terminal({
      fontFamily: monoStack(),
      fontSize: 12,
      cursorBlink: modeVal === 'rw',
      scrollback: 5000,
      theme: { background: '#0b0f14', foreground: '#c9d6e2' },
    })
    fit = new FitAddon()
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

    // Refit when the panel itself resizes (not just the window) and keep the
    // daemon-side PTY in sync so tmux redraws at the real size.
    cols = term.cols
    rows = term.rows
    const refit = () => {
      fit?.fit()
      if (!term) return
      if (term.cols !== cols || term.rows !== rows) {
        cols = term.cols
        rows = term.rows
        if (ws && ws.readyState === WebSocket.OPEN) sendResize(ws, cols, rows)
      }
    }
    const ro = new ResizeObserver(refit)
    ro.observe(host)
    ready = true

    return () => {
      ready = false
      ro.disconnect()
      if (ws) {
        ws.onclose = null // deliberate detach — not an exit the panel should react to
        ws.close()
      }
      term?.dispose()
      ws = null
      term = null
      fit = null
    }
  })

  $effect(() => {
    if (!ready || !term) return
    error = null
    term.options.cursorBlink = modeVal === 'rw'
    fit?.fit()
    cols = term.cols
    rows = term.rows

    // Dial in at the fitted size so the PTY (and tmux) renders full-pane from
    // the first frame instead of a 200x50 headless canvas.
    const socket = attachTerminal(tidVal, modeVal, term.cols, term.rows, needsReplay, instance)
    needsReplay = false
    ws = socket
    socket.onmessage = (ev) => {
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
      term?.write(data)
    }
    socket.onerror = () => {
      error = 'connection to daemon lost'
    }
    // Daemon closed the stream: the PTY exited (or the terminal was closed by
    // another client). Tell the panel so it can refresh its tab list.
    socket.onclose = () => onclosed?.()
    // rw forwards everything; ro forwards only SGR mouse-wheel reports so the
    // attached tmux session can scroll its history — keystrokes never leave the
    // browser (and the daemon's broker drops anything but wheel reports anyway).
    const WHEEL_REPORT = /^(?:\x1b\[<6[45];\d+;\d+[Mm])+$/
    const dataListener: IDisposable = term.onData((d) => {
      if (modeVal === 'ro' && !WHEEL_REPORT.test(d)) return
      if (socket.readyState === WebSocket.OPEN) socket.send(d)
    })

    return () => {
      dataListener.dispose()
      socket.onclose = null // deliberate detach — not an exit the panel should react to
      socket.close()
      if (ws === socket) ws = null
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
        Terminals are shared daemon sessions — this one may have exited or been closed by
        another client. Nothing running? Start it first.
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
