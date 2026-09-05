<script lang="ts">
  import { createTerminal, deleteTerminal, fetchTerminals, type TermInfo } from './api'
  import Terminal from './Terminal.svelte'
  import { terminalVisible, terminalLabel } from './terminalContext'

  // Tabs mirror the daemon's terminal registry — the same scope-qualified
  // sessions (`repo:t1`, `repo.workload:t1`, `host:t1`) agents open over MCP
  // show up here, and terminals opened here are visible to agents. The panel
  // only decides which ones belong to it:
  //  - repo mode (repo set): this workload's terminals (the auto primary +
  //    any pod shells), ensured to have a primary while something runs.
  //  - host mode (repo unset): `local` login shells on the devdock machine.
  //
  // `attach` mirrors the daemon's attach target for the active workload:
  //  'tmux' → a managed dev session exists, 'pod' → only a pod shell, 'none' →
  //  nothing to attach. It's a live prop (the panel is NOT keyed on it — that
  //  remounted every viewer socket on each flap, flashing all terminals);
  //  instead ensurePrimary reacts to changes and re-ensures the primary
  //  against the new target while every other tab keeps streaming.
  let {
    instance = '',
    repo,
    workload,
    attach = 'none',
    machine = 'machine',
    all = false,
  }: { instance?: string; repo?: string; workload?: string; attach?: 'tmux' | 'pod' | 'none'; machine?: string; all?: boolean } = $props()

  let terms = $state<TermInfo[]>([])
  let activeTid = $state<string | null>(null)
  let full = $state(false)
  let createError = $state<string | null>(null)
  let adding = $state(false)
  let addButton: HTMLButtonElement
  let menu: HTMLDivElement
  let menuX = $state(0)
  let menuY = $state(0)
  let menuOpen = $state(false)
  function closeMenu() {
    menu?.hidePopover()
    menuOpen = false
  }
  function dismissMenuOutside(event: PointerEvent | FocusEvent) {
    if (!menuOpen) return
    const path = event.composedPath()
    if (!path.includes(menu) && !path.includes(addButton)) closeMenu()
  }
  function openMenu(event: MouseEvent | KeyboardEvent) {
    event.preventDefault()
    const rect = addButton.getBoundingClientRect()
    menuX = Math.max(8, Math.min(rect.left, window.innerWidth - 260))
    menuY = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 100))
    menu.showPopover()
    menuOpen = true
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }
  function menuKey(event: KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const current = buttons.findIndex((button) => button === document.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }
  // Per-viewer ro/rw, by terminal id. THIS browser's choice only — another
  // window (or an agent) can be writing to the same terminal regardless.
  let viewer = $state<Record<string, 'ro' | 'rw'>>({})

  async function refresh() {
    try {
      const registered = await fetchTerminals(instance)
      terms = registered
        .filter((t) => terminalVisible(t, all, repo, workload))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      if (!terms.some((t) => t.id === activeTid)) activeTid = terms.at(-1)?.id ?? null
    } catch {
      /* daemon offline — keep showing what we had */
    }
  }

  // Ensure the workload's primary terminal exists and matches the attach
  // target (the daemon dedupes `auto` opens and swaps a stale pod shell for
  // the dev session itself — we just ask again when the target moves).
  // `lastEnsure` remembers the exact situation we last acted on, so if the
  // daemon disagrees with our `attach` prop we don't re-POST every poll.
  let lastEnsure = ''
  async function ensurePrimary() {
    if (!repo || attach === 'none') return
    const cur = terms.find((t) => t.kind === 'auto')
    if (cur && cur.attach === attach) return
    const key = cur ? `${cur.id}:${cur.attach}->${attach}` : `none->${attach}`
    if (key === lastEnsure) return
    lastEnsure = key
    try {
      await createTerminal({ repo, workload, kind: 'auto' }, instance)
      await refresh()
    } catch (e) {
      createError = e instanceof Error ? e.message : String(e)
    }
  }

  $effect(() => {
    void attach // re-ensure immediately when the attach target changes
    refresh().then(ensurePrimary)
    const poll = setInterval(() => refresh().then(ensurePrimary), 4000)
    return () => clearInterval(poll)
  })

  const active = $derived(terms.find((t) => t.id === activeTid) ?? null)
  const canAdd = $derived(!repo || attach !== 'none')

  // A fresh terminal opens read-only for the shared dev session (look, don't
  // touch) and read-write for shells you explicitly opened to type into.
  const modeOf = (t: TermInfo): 'ro' | 'rw' => viewer[t.id] ?? (t.kind === 'auto' ? 'ro' : 'rw')

  async function add(normal = false) {
    if (adding || (!normal && !canAdd)) return
    closeMenu()
    adding = true
    createError = null
    try {
      const t = await createTerminal({ repo, workload, kind: normal || !repo ? 'local' : 'shell' }, instance)
      await refresh()
      activeTid = t.id
    } catch (e) {
      createError = e instanceof Error ? e.message : String(e)
    } finally { adding = false }
  }

  // Close for everyone — the daemon kills the PTY, agents lose it too.
  async function close(tid: string) {
    try {
      await deleteTerminal(tid, instance)
    } catch {
      /* already gone */
    }
    await refresh()
  }

  function setMode(mode: 'ro' | 'rw') {
    if (active) viewer = { ...viewer, [active.id]: mode }
  }

  function label(t: TermInfo): string {
    return terminalLabel(t, machine)
  }

  // Badge shows just the per-scope number — the panel already names the scope.
  // The tooltip keeps the full id agents use.
  const shortId = (t: TermInfo): string => t.id.slice(t.id.lastIndexOf(':t') + 2)

  function onkey(e: KeyboardEvent) {
    if (e.key === 'Escape' && menuOpen) {
      e.preventDefault()
      e.stopPropagation()
      closeMenu()
      addButton.focus()
      return
    }
    if (e.key === 'Escape' && full) full = false
  }
</script>

<svelte:window onkeydown={onkey} onpointerdown={dismissMenuOutside} onfocusin={dismissMenuOutside} />

<div class="panel" class:full>
  <div class="tabs">
    <div class="strip">
      {#each terms as t (t.id)}
        <div class="tab" class:active={t.id === activeTid} class:primary={t.kind === 'auto'}>
          <button class="tablabel" onclick={() => (activeTid = t.id)} title="{label(t)} — terminal {t.id}, shared with agents">
            <span class="tdot {modeOf(t)}"></span>
            <span class="name">{label(t)}</span>
            <span class="badge {t.kind === 'auto' ? 'primary' : 'enter'}">{shortId(t)}</span>
          </button>
          {#if t.kind !== 'auto'}
            <button class="x" title="close for all clients" aria-label="close terminal" onclick={() => close(t.id)}
              >×</button
            >
          {/if}
        </div>
      {/each}
      <button
        bind:this={addButton}
        class="add"
        title={repo ? 'Open DevSpace terminal. Right-click for a normal terminal on this machine.' : 'Open normal terminal on this machine'}
        aria-label="New terminal"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-disabled={!canAdd || adding}
        oncontextmenu={openMenu}
        onkeydown={(event) => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openMenu(event) }}
        onclick={() => add()}>+</button
      >
      <button class="add" title="Terminal options" aria-label="Terminal options" aria-haspopup="menu" aria-expanded={menuOpen} onclick={openMenu}>⌄</button>
    </div>

    <div class="tools">
      {#if active}
        <div class="modes">
          <button class:active={modeOf(active) === 'ro'} onclick={() => setMode('ro')}>read-only</button>
          <button class:active={modeOf(active) === 'rw'} onclick={() => setMode('rw')}>read-write</button>
        </div>
      {/if}
      <button class="full-btn" title={full ? 'restore' : 'expand to full screen'} onclick={() => (full = !full)}>
        {full ? '⤡ restore' : '⤢ expand'}
      </button>
    </div>
  </div>

  <div class="screens">
    {#if terms.length === 0}
      <div class="empty">
        {#if createError}
          <p class="err">{createError}</p>
        {:else}
          <p>{canAdd ? 'No terminal open.' : 'Start the workload to open a DevSpace terminal.'}</p>
        {/if}
        {#if canAdd}
          <button onclick={() => add()}>+ open a shell</button>
        {/if}
      </div>
    {:else}
      {#each terms as t (t.id)}
        <div class="screen" class:shown={t.id === activeTid}>
          <Terminal {instance} tid={t.id} mode={modeOf(t)} onclosed={refresh} />
        </div>
      {/each}
    {/if}
  </div>
</div>

<!-- Auto popovers light-dismiss on the pointerup that completes a right-click. -->
<div bind:this={menu} popover="manual" class="terminal-menu" role="menu" tabindex="-1" aria-label="New terminal" style:left="{menuX}px" style:top="{menuY}px" onkeydown={menuKey}>
  <button role="menuitem" disabled={!repo || !canAdd || adding} onclick={() => add()}>Open DevSpace terminal</button>
  <button role="menuitem" disabled={adding} onclick={() => add(true)}>Open normal terminal</button>
</div>
{#if createError && terms.length > 0}<p class="err" role="alert">{createError}</p>{/if}

<style>
  .terminal-menu { position: fixed; margin: 0; padding: 5px; width: 250px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg, #0b0f14); color: var(--ink); box-shadow: 0 10px 30px #0007; }
  .terminal-menu button { display: block; width: 100%; padding: 9px 10px; text-align: left; font: inherit; font-size: 12px; color: inherit; background: transparent; border: 0; border-radius: 4px; cursor: pointer; }
  .terminal-menu button:hover:not(:disabled), .terminal-menu button:focus-visible { background: var(--accent-dim, #182a29); outline: 1px solid var(--accent); }
  .terminal-menu button:disabled { opacity: .4; cursor: default; }
  .panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 0;
    height: 100%;
  }
  /* Full-screen: cover the whole viewport above everything else. The terminals'
     own ResizeObserver refits them to the new size. */
  .panel.full {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: var(--bg, #0b0f14);
    padding: 12px 16px 16px;
    gap: 8px;
  }

  .tabs {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex: none;
  }
  .strip {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    overflow-x: auto;
  }
  .tab {
    display: flex;
    align-items: center;
    border: 1px solid var(--line);
    border-radius: 7px;
    background: var(--panel2);
    overflow: hidden;
    flex: none;
  }
  .tab.active {
    border-color: var(--accent);
  }
  /* The primary tab (devspace dev output / pod shell) reads as the anchor — it
     can't be closed and carries an accent-tinted edge even when inactive. */
  .tab.primary {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
  }
  .tablabel {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: none;
    background: none;
    color: var(--muted);
    font-size: 11px;
    padding: 4px 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  .tab.active .tablabel {
    color: var(--ink);
  }
  /* The terminal's per-scope number (1, 2, …); the tooltip carries the full
     scope-qualified id agents see. */
  .badge {
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.04em;
    line-height: 1;
    padding: 2px 5px;
    border-radius: 999px;
    border: 1px solid var(--line);
    color: var(--muted);
  }
  .badge.primary {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .tdot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--muted);
  }
  /* read-write tabs glow accent; read-only stay dim. */
  .tdot.rw {
    background: var(--ok);
  }
  .x {
    border: none;
    background: none;
    color: var(--muted);
    font-size: 14px;
    line-height: 1;
    padding: 4px 7px 4px 2px;
    cursor: pointer;
  }
  .x:hover {
    color: var(--danger);
  }
  .add {
    border: 1px dashed var(--line);
    background: none;
    color: var(--muted);
    font-size: 14px;
    line-height: 1;
    padding: 3px 9px;
    border-radius: 7px;
    cursor: pointer;
    flex: none;
  }
  .add:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .add:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .tools {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  .modes {
    display: flex;
    gap: 4px;
  }
  .modes button {
    font-size: 11px;
    padding: 3px 8px;
  }
  .modes button.active {
    border-color: var(--accent);
    color: var(--accent);
  }
  .full-btn {
    font-size: 11px;
    padding: 3px 8px;
    white-space: nowrap;
  }

  .screens {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .screen {
    position: absolute;
    inset: 0;
    /* Kept mounted but hidden when inactive so its viewer socket survives a
       tab switch — and stays sized so xterm's fit stays correct. */
    visibility: hidden;
    pointer-events: none;
  }
  .screen.shown {
    visibility: visible;
    pointer-events: auto;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    height: 100%;
    color: var(--muted);
    border: 1px dashed var(--line);
    border-radius: 10px;
  }
  .empty .err {
    font-size: 12px;
    margin: 0;
    color: var(--danger);
    font-family: var(--mono);
    max-width: 80%;
    text-align: center;
  }
</style>
