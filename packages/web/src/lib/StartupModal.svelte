<script lang="ts">
  import { saveStartup } from './api'

  let {
    repoId,
    initial,
    onclose,
    onsaved,
  }: {
    repoId: string
    initial: string
    onclose: () => void
    onsaved: (id: string, command: string) => void
  } = $props()

  let command = $state(initial)
  let saving = $state(false)
  let error = $state<string | null>(null)

  async function save() {
    saving = true
    error = null
    try {
      await saveStartup(repoId, command)
      onsaved(repoId, command.trim())
      onclose()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      saving = false
    }
  }

  function onkey(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose()
    // ⌘/Ctrl+Enter saves, matching the textarea-as-form convention.
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
<div class="modal" role="dialog" aria-modal="true" aria-label="Startup script for {repoId}">
  <header>
    <h3>Startup script</h3>
    <code>{repoId}</code>
  </header>
  <p class="hint">
    Runs automatically in the <b>devspace dev</b> pod once it's up. It is not run in
    <b>devspace enter</b> shells. Leave empty to disable.
  </p>
  <textarea
    bind:value={command}
    placeholder="e.g. npm run dev"
    spellcheck="false"
    autocapitalize="off"
    autocorrect="off"
    rows="4"
  ></textarea>
  {#if error}<p class="err">{error}</p>{/if}
  <footer>
    <button class="ghost" onclick={onclose} disabled={saving}>Cancel</button>
    <button class="primary" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
  </footer>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 50;
  }
  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 51;
    width: min(520px, calc(100vw - 48px));
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
  }
  header {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  header h3 {
    margin: 0;
    font-size: 15px;
  }
  header code {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--muted);
  }
  .hint b {
    color: var(--ink);
    font-weight: 600;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--ink);
    font-family: var(--mono);
    font-size: 13px;
    padding: 10px;
    outline: none;
  }
  textarea:focus {
    border-color: var(--accent);
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
</style>
