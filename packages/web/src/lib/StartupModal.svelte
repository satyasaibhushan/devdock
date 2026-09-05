<script lang="ts">
  import { saveStartup } from './api'

  let {
    instanceFor = () => '',
    repoId,
    podTypes,
    initial,
    onclose,
    onsaved,
  }: {
    instanceFor?: (type: string) => string
    repoId: string
    podTypes: string[]
    initial: Record<string, string>
    onclose: () => void
    onsaved: (id: string, commands: Record<string, string>) => void
  } = $props()

  let commands = $state<Record<string, string>>({})
  let active = $state('')
  let initialized = false
  let saving = $state(false)
  let error = $state<string | null>(null)

  $effect(() => {
    if (initialized) return
    commands = Object.fromEntries(podTypes.map((type) => [type, initial[type] ?? '']))
    active = podTypes[0] ?? 'api'
    initialized = true
  })

  async function save() {
    saving = true
    error = null
    try {
      await Promise.all(
        podTypes.map((type) => saveStartup(repoId, type, commands[type] ?? '', instanceFor(type))),
      )
      const normalized = Object.fromEntries(
        podTypes.map((type) => [type, (commands[type] ?? '').trim()]),
      )
      onsaved(repoId, normalized)
      onclose()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      saving = false
    }
  }

  function onkey(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
  }
</script>

<svelte:window onkeydown={onkey} />

<div
  class="backdrop"
  role="button"
  tabindex="-1"
  aria-label="close"
  onclick={onclose}
  onkeydown={() => {}}
></div>
<div class="modal" role="dialog" aria-modal="true" aria-label="Startup scripts for {repoId}">
  <header>
    <div>
      <p class="eyebrow">pod boot sequence</p>
      <h3>Startup scripts</h3>
    </div>
    <code>{repoId}</code>
  </header>
  <p class="hint">
    Each pod type can run a different command after <b>devspace dev</b> is ready. Empty
    scripts are skipped; <b>devspace enter</b> shells are unaffected.
  </p>

  <div class="workspace">
    <nav aria-label="pod type">
      {#each podTypes as type (type)}
        <button
          class:active={active === type}
          aria-pressed={active === type}
          onclick={() => (active = type)}
        >
          <span class="status" class:set={!!commands[type]?.trim()}></span>
          <span>{type}</span>
          <small>{commands[type]?.trim() ? 'configured' : 'idle'}</small>
        </button>
      {/each}
    </nav>
    <section class="editor">
      <div class="editorhead">
        <span>run for</span>
        <strong>{active}</strong>
      </div>
      <textarea
        value={commands[active] ?? ''}
        oninput={(e) => (commands[active] = e.currentTarget.value)}
        placeholder={active === 'ui' ? 'e.g. pnpm dev' : `e.g. pnpm start:${active}`}
        aria-label="startup command for {active}"
        spellcheck="false"
        autocapitalize="off"
        rows="5"
      ></textarea>
      <span class="shortcut">⌘ / Ctrl + Enter to save</span>
    </section>
  </div>

  {#if error}<p class="err">{error}</p>{/if}
  <footer>
    <button class="ghost" onclick={onclose} disabled={saving}>Cancel</button>
    <button class="primary" onclick={save} disabled={saving}>
      {saving ? 'Saving…' : `Save ${podTypes.length} pod ${podTypes.length === 1 ? 'script' : 'scripts'}`}
    </button>
  </footer>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(4, 8, 12, 0.72);
    backdrop-filter: blur(3px);
    z-index: 50;
  }
  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 51;
    width: min(680px, calc(100vw - 40px));
    background: var(--panel);
    border: 1px solid var(--line);
    border-top: 2px solid var(--accent);
    border-radius: 10px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    box-shadow: 0 28px 80px rgba(0, 0, 0, 0.58);
  }
  header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
  }
  .eyebrow {
    margin: 0 0 4px;
    color: var(--accent);
    font-family: var(--mono);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
  header h3 {
    margin: 0;
    font-size: 18px;
    letter-spacing: -0.02em;
  }
  header code {
    max-width: 55%;
    color: var(--muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint {
    margin: 0;
    max-width: 580px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.55;
  }
  .hint b {
    color: var(--ink);
    font-weight: 600;
  }
  .workspace {
    min-height: 210px;
    display: grid;
    grid-template-columns: 156px minmax(0, 1fr);
    overflow: hidden;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  nav {
    padding: 7px;
    background: color-mix(in srgb, var(--panel2) 72%, var(--bg));
    border-right: 1px solid var(--line);
  }
  nav button {
    width: 100%;
    display: grid;
    grid-template-columns: 8px 1fr;
    gap: 2px 8px;
    align-items: center;
    padding: 9px 10px;
    background: transparent;
    border-color: transparent;
    text-align: left;
  }
  nav button.active {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border-color: color-mix(in srgb, var(--accent) 36%, var(--line));
  }
  nav button > span:nth-child(2) {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 700;
  }
  nav small {
    grid-column: 2;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 9px;
    text-transform: uppercase;
  }
  .status {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #52606e;
  }
  .status.set {
    background: var(--ok);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 12%, transparent);
  }
  .editor {
    min-width: 0;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .editorhead {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
  }
  .editorhead strong {
    padding: 2px 6px;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
    border-radius: 4px;
    font-size: 10px;
  }
  textarea {
    width: 100%;
    flex: 1;
    box-sizing: border-box;
    resize: vertical;
    background: #0b1016;
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--ink);
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.55;
    padding: 12px;
    outline: none;
  }
  textarea:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .shortcut {
    align-self: flex-end;
    color: #667483;
    font-family: var(--mono);
    font-size: 9px;
  }
  .err {
    margin: 0;
    font-size: 12px;
    color: var(--danger);
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .ghost {
    background: none;
  }
  .primary {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
    color: var(--accent);
  }
  .primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  @media (max-width: 560px) {
    .modal {
      padding: 16px;
    }
    .workspace {
      grid-template-columns: 1fr;
    }
    nav {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }
    nav button {
      min-width: 108px;
    }
  }
</style>
