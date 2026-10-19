<script lang="ts">
  import type { SandboxView } from './api'
  import Icon from './Icon.svelte'
  import { sandboxHint } from './sandboxUi'

  // The selected sandbox is the context for the content below.
  let {
    sandboxes,
    selected,
    listState = 'ready',
    error = '',
    onselect,
    onnew,
  }: {
    sandboxes: SandboxView[]
    /** Ticket key, null for the personal row, undefined when another view (All terminals) is current. */
    selected: string | null | undefined
    listState?: 'loading' | 'offline' | 'ready'
    /** Why the ticket list may be empty when the daemon itself is reachable. */
    error?: string
    onselect: (key: string | null) => void
    onnew: () => void
  } = $props()

  const personal = $derived(sandboxes.find((s) => s.personal) ?? null)
  const tickets = $derived(sandboxes.filter((s) => !s.personal))
  const personalRepos = $derived(new Set(personal?.members.map((m) => m.repo)).size)
</script>

<div class="sandbox-panel">
  <div class="switcher">
    <label class="context">
      <span class="stitle">Sandbox</span>
      <select class="sel mono" aria-label="Sandbox" value={selected ?? ''}
        onchange={(event) => onselect(event.currentTarget.value || null)}>
        <option value="">{personal?.key ?? 'personal'} · personal</option>
        {#each tickets as s (s.key)}
          <option value={s.key}>{s.key} · {s.state}{sandboxHint(s) ? ` · ${sandboxHint(s)}` : ''}{s.title ? ` · ${s.title}` : ''}</option>
        {/each}
      </select>
    </label>
    <button class="btn ghost icon sm" title="New sandbox" aria-label="New sandbox" onclick={onnew}>
      <Icon name="plus" size={12} />
    </button>
  </div>
  {#if error}
    <p class="hint err" role="alert">{error}</p>
  {:else if listState === 'loading'}
    <p class="hint">Connecting…</p>
  {:else if listState === 'offline'}
    <p class="hint">Sandbox context unavailable while offline.</p>
  {:else if !tickets.length}
    <p class="hint">No ticket sandboxes yet.</p>
  {/if}
  {#if selected === null && personal}
    <p class="hint">Personal namespace · {personalRepos} repo{personalRepos === 1 ? '' : 's'}</p>
  {/if}
</div>

<style>
  .sandbox-panel {
    flex: none;
    max-height: 45%;
    overflow-y: auto;
    padding: 10px 10px 8px 14px;
    border-bottom: 1px solid var(--line);
  }
  .switcher {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .context {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .stitle {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
  }
  .sel {
    width: 100%;
    min-width: 0;
    text-overflow: ellipsis;
  }
  .hint {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--muted);
  }
  .err {
    color: var(--danger);
    overflow-wrap: anywhere;
  }
</style>
