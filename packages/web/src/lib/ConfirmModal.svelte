<script lang="ts">
  let {
    title,
    message,
    confirmLabel = 'Confirm',
    danger = false,
    busy = false,
    onconfirm,
    oncancel,
  }: {
    title: string
    message: string
    confirmLabel?: string
    danger?: boolean
    busy?: boolean
    onconfirm: () => void
    oncancel: () => void
  } = $props()

  function onkey(e: KeyboardEvent) {
    if (e.key === 'Escape' && !busy) oncancel()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy) onconfirm()
  }
</script>

<svelte:window onkeydown={onkey} />

<div
  class="backdrop"
  role="button"
  tabindex="-1"
  aria-label="cancel"
  onclick={() => !busy && oncancel()}
  onkeydown={() => {}}
></div>
<div class="modal" role="dialog" aria-modal="true" aria-label={title}>
  <h3>{title}</h3>
  <p class="msg">{message}</p>
  <footer>
    <button class="ghost" onclick={oncancel} disabled={busy}>Cancel</button>
    <button class:danger class:primary={!danger} onclick={onconfirm} disabled={busy}>
      {busy ? 'Working…' : confirmLabel}
    </button>
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
    width: min(440px, calc(100vw - 48px));
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
  }
  h3 {
    margin: 0;
    font-size: 15px;
  }
  .msg {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--muted);
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
  .danger {
    background: color-mix(in srgb, var(--danger) 18%, transparent);
    border-color: color-mix(in srgb, var(--danger) 50%, transparent);
    color: var(--danger);
  }
  .danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--danger) 28%, transparent);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
