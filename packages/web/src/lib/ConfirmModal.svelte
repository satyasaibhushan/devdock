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
  <header><h3>{title}</h3></header>
  <div class="body"><p class="msg">{message}</p></div>
  <footer>
    <button class="btn ghost" onclick={oncancel} disabled={busy}>Cancel</button>
    <button class="btn" class:danger class:primary={!danger} onclick={onconfirm} disabled={busy}>
      {busy ? 'Working…' : confirmLabel}
    </button>
  </footer>
</div>

<style>
  .modal {
    width: min(420px, calc(100vw - 48px));
  }
  .msg {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--ink-2);
  }
</style>
