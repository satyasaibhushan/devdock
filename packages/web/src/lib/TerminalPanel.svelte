<script lang="ts">
  import Terminal from './Terminal.svelte'

  // `attach` mirrors the daemon's attach target for the active workload:
  //  'tmux' → a managed dev session exists, 'pod' → only a pod shell, 'none' →
  //  nothing to attach. The panel is keyed on it in App, so a change in target
  //  remounts the panel and resets tabs.
  let {
    id,
    workload,
    attach,
  }: { id: string; workload?: string; attach: 'tmux' | 'pod' | 'none' } = $props()

  type Tab = { uid: number; kind: 'auto' | 'shell'; mode: 'ro' | 'rw' }

  let seq = 0
  const makeTab = (kind: 'auto' | 'shell', mode: 'ro' | 'rw'): Tab => ({ uid: seq++, kind, mode })

  let tabs = $state<Tab[]>([])
  let activeUid = $state<number>(-1)
  let full = $state(false)

  // Seed the primary terminal once on mount (auto attach — dev session or pod
  // shell — read-only, the pre-tabs behavior). One-shot: the panel is remounted
  // when the attach target changes (App keys on it), and not re-seeding lets the
  // empty state stick if the user closes every tab.
  let seeded = false
  $effect(() => {
    if (seeded || attach === 'none') return
    seeded = true
    const t = makeTab('auto', 'ro')
    tabs = [t]
    activeUid = t.uid
  })

  const active = $derived(tabs.find((t) => t.uid === activeUid) ?? null)
  // Independent pod shells need a running pod; the primary tmux session doesn't.
  const canAddShell = $derived(attach !== 'none')

  function add() {
    if (!canAddShell) return
    // Every extra terminal is an independent `devspace enter` shell into the pod,
    // opened read-write — that's the point of a second terminal.
    const t = makeTab('shell', 'rw')
    tabs = [...tabs, t]
    activeUid = t.uid
  }

  function close(uid: number) {
    const i = tabs.findIndex((t) => t.uid === uid)
    if (i === -1) return
    tabs = tabs.filter((t) => t.uid !== uid)
    if (activeUid === uid) activeUid = tabs[Math.max(0, i - 1)]?.uid ?? -1
  }

  function setMode(mode: 'ro' | 'rw') {
    if (active) active.mode = mode
  }

  // A tab's label: the primary session (the `devspace dev` output, or a pod
  // shell when the deployment runs outside devdock) vs numbered `devspace enter`
  // shells.
  function label(t: Tab): string {
    if (t.kind === 'auto') return attach === 'tmux' ? 'devspace dev' : 'pod shell'
    return `enter ${tabs.filter((x) => x.kind === 'shell').indexOf(t) + 1}`
  }

  function onkey(e: KeyboardEvent) {
    if (e.key === 'Escape' && full) full = false
  }
</script>

<svelte:window onkeydown={onkey} />

<div class="panel" class:full>
  <div class="tabs">
    <div class="strip">
      {#each tabs as t (t.uid)}
        <div class="tab" class:active={t.uid === activeUid} class:primary={t.kind === 'auto'}>
          <button class="tablabel" onclick={() => (activeUid = t.uid)} title={label(t)}>
            <span class="tdot {t.mode}"></span>
            <span class="name">{label(t)}</span>
            <span class="badge {t.kind === 'auto' ? 'primary' : 'enter'}">
              {t.kind === 'auto' ? 'primary' : 'enter'}
            </span>
          </button>
          {#if t.kind !== 'auto'}
            <button class="x" title="close" aria-label="close terminal" onclick={() => close(t.uid)}
              >×</button
            >
          {/if}
        </div>
      {/each}
      <button
        class="add"
        title="new devspace enter shell into this pod"
        disabled={!canAddShell}
        onclick={add}>+</button
      >
    </div>

    <div class="tools">
      {#if active}
        <div class="modes">
          <button class:active={active.mode === 'ro'} onclick={() => setMode('ro')}>read-only</button>
          <button class:active={active.mode === 'rw'} onclick={() => setMode('rw')}>read-write</button>
        </div>
      {/if}
      <button class="full-btn" title={full ? 'restore' : 'expand to full screen'} onclick={() => (full = !full)}>
        {full ? '⤡ restore' : '⤢ expand'}
      </button>
    </div>
  </div>

  <div class="screens">
    {#if tabs.length === 0}
      <div class="empty">
        <p>No terminal open.</p>
        {#if canAddShell}
          <button onclick={add}>+ open a shell</button>
        {:else}
          <p class="hint">Nothing running — start the workload first.</p>
        {/if}
      </div>
    {:else}
      {#each tabs as t (t.uid)}
        <div class="screen" class:shown={t.uid === activeUid}>
          {#key t.uid + t.mode + t.kind}
            <Terminal {id} mode={t.mode} {workload} kind={t.kind} />
          {/key}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
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
  .badge {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    line-height: 1;
    padding: 2px 5px;
    border-radius: 999px;
    border: 1px solid var(--line);
    color: var(--muted);
  }
  /* primary = the can't-close devspace dev tab; enter = a devspace enter shell. */
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
    /* Kept mounted but hidden when inactive so its session (and scrollback)
       survives a tab switch — and stays sized so xterm's fit stays correct. */
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
  .empty .hint {
    font-size: 12px;
    margin: 0;
  }
</style>
