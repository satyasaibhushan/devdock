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
    <h3>Startup scripts</h3>
    <code>{repoId}</code>
  </header>
  <div class="body">
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
            <span class="ptype">{type}</span>
            <small>{commands[type]?.trim() ? 'configured' : 'idle'}</small>
          </button>
        {/each}
      </nav>
      <section class="editor">
        <div class="editorhead">
          <span>Run for</span>
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
  </div>
  <footer>
    <button class="btn ghost" onclick={onclose} disabled={saving}>Cancel</button>
    <button class="btn primary" onclick={save} disabled={saving}>
      {saving ? 'Saving…' : `Save ${podTypes.length} pod ${podTypes.length === 1 ? 'script' : 'scripts'}`}
    </button>
  </footer>
</div>

<style>
  .modal {
    width: min(660px, calc(100vw - 48px));
  }
  .workspace {
    min-height: 210px;
    display: grid;
    grid-template-columns: 150px minmax(0, 1fr);
    overflow: hidden;
    background: var(--bg-0);
    border: 1px solid var(--line);
    border-radius: var(--r-2);
  }
  nav {
    padding: 4px;
    border-right: 1px solid var(--line);
  }
  nav button {
    width: 100%;
    display: grid;
    grid-template-columns: 8px 1fr;
    gap: 1px 8px;
    align-items: center;
    padding: 7px 8px;
    background: transparent;
    border: 0;
    border-radius: var(--r-1);
    text-align: left;
    color: var(--ink-2);
  }
  nav button:hover {
    background: var(--bg-2);
    color: var(--ink);
  }
  nav button.active {
    background: var(--bg-3);
    color: var(--ink);
  }
  .ptype {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
  }
  nav small {
    grid-column: 2;
    color: var(--muted);
    font-size: 10.5px;
  }
  .status {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--stopped);
  }
  .status.set {
    background: var(--ok);
  }
  .editor {
    min-width: 0;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .editorhead {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--muted);
    font-size: 11px;
  }
  .editorhead strong {
    padding: 1px 6px;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border-radius: var(--r-1);
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
  }
  textarea {
    width: 100%;
    flex: 1;
    box-sizing: border-box;
    resize: vertical;
    background: var(--term-bg);
    border: 1px solid var(--line);
    border-radius: var(--r-1);
    color: var(--ink);
    font-family: var(--mono);
    font-size: 12.5px;
    line-height: 1.55;
    padding: 10px;
    outline: none;
  }
  textarea:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent);
  }
  .shortcut {
    align-self: flex-end;
    color: var(--muted);
    font-size: 10.5px;
  }
  @media (max-width: 560px) {
    .workspace {
      grid-template-columns: 1fr;
    }
    nav {
      display: flex;
      gap: 4px;
      overflow-x: auto;
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }
    nav button {
      min-width: 108px;
    }
  }
</style>
