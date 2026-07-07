<script lang="ts">
  // Global namespace selector (header, top right) — the UI face of the user's
  // `kn` alias. Shows the kube context's current namespace; picking another
  // switches the context, so terminal and UI stay in sync. Listing cluster
  // namespaces is RBAC-forbidden for most users, so the options are learned
  // (persisted by the daemon) plus a free-text "add" entry.
  let {
    current,
    known,
    busy = false,
    onswitch,
  }: {
    current: string
    known: string[]
    busy?: boolean
    onswitch: (ns: string) => Promise<unknown>
  } = $props()

  let adding = $state(false)
  let draft = $state('')

  // Always offer the current namespace, even before the daemon remembers it.
  const options = $derived(known.includes(current) ? known : [current, ...known])

  async function pick(e: Event & { currentTarget: HTMLSelectElement }) {
    const sel = e.currentTarget
    const v = sel.value
    if (v === '__add__') {
      adding = true
      draft = ''
      sel.value = current
      return
    }
    if (v === current) return
    try {
      await onswitch(v)
    } catch {
      sel.value = current // the caller toasts the failure; snap the select back
    }
  }

  function submit() {
    const ns = draft.trim()
    adding = false
    if (ns && ns !== current) void onswitch(ns)
  }

  function focusNow(node: HTMLElement) {
    node.focus()
  }
</script>

<div
  class="ns"
  title="kubernetes namespace — switching runs kubectl config set-context --current --namespace (your kn alias). Running dev sessions keep the namespace they started in."
>
  <span class="k">ns</span>
  {#if adding}
    <input
      class="nsinput"
      placeholder="namespace…"
      bind:value={draft}
      disabled={busy}
      use:focusNow
      onkeydown={(e) => {
        if (e.key === 'Enter') submit()
        if (e.key === 'Escape') adding = false
      }}
      onblur={() => (adding = false)}
    />
  {:else}
    <select
      class="nsselect"
      value={current}
      disabled={busy}
      onchange={pick}
      aria-label="kubernetes namespace"
    >
      {#each options as ns (ns)}
        <option value={ns}>{ns}</option>
      {/each}
      <option value="__add__">+ add namespace…</option>
    </select>
  {/if}
  {#if busy}<span class="spin" aria-label="switching namespace"></span>{/if}
</div>

<style>
  .ns {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .k {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  .nsselect,
  .nsinput {
    font-family: var(--mono);
    font-size: 11px;
    padding: 3px 6px;
    border-radius: 6px;
    border: 1px solid var(--line);
    background: var(--panel2);
    color: var(--ink);
  }
  .nsselect {
    cursor: pointer;
  }
  .nsselect:hover:not(:disabled) {
    border-color: var(--accent);
  }
  .nsselect:disabled,
  .nsinput:disabled {
    opacity: 0.6;
  }
  .nsinput {
    width: 140px;
  }
  .nsinput:focus {
    outline: none;
    border-color: var(--accent);
  }
  .spin {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 2px solid var(--line);
    border-top-color: var(--accent);
    animation: rot 0.8s linear infinite;
  }
  @keyframes rot {
    to {
      transform: rotate(360deg);
    }
  }
</style>
