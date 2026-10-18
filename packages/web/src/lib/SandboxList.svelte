<script lang="ts">
  import type { SandboxView } from './api'
  import Icon from './Icon.svelte'
  import { sandboxHint } from './sandboxUi'

  // The sidebar's top block: the personal sandbox pinned first, then every
  // ticket sandbox. `selected` is null for the personal one.
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

<div class="panel">
  <div class="shead">
    <span class="stitle">Sandboxes</span>
    <button class="btn ghost icon sm" title="New sandbox" aria-label="New sandbox" onclick={onnew}>
      <Icon name="plus" size={12} />
    </button>
  </div>
  <div class="list" role="listbox" aria-label="sandboxes">
    <button
      class="row personal"
      class:current={selected === null}
      role="option"
      aria-selected={selected === null}
      onclick={() => onselect(null)}
    >
      <span class="dot {personal?.power ?? 'unknown'}" title={personal?.power ?? 'unknown'}></span>
      <span class="text">
        <span class="key">{personal?.key ?? 'personal'}</span>
        <span class="sub">
          {#if personal}personal · {personalRepos} repo{personalRepos === 1 ? '' : 's'}
          {:else if listState === 'loading'}connecting…
          {:else}personal{/if}
        </span>
      </span>
    </button>
    {#each tickets as s (s.key)}
      {@const hint = sandboxHint(s)}
      <button
        class="row"
        class:current={selected === s.key}
        role="option"
        aria-selected={selected === s.key}
        onclick={() => onselect(s.key)}
      >
        <span class="dot {s.power}" class:pulse={hint === 'building'} title={s.power}></span>
        <span class="text">
          <span class="key">{s.key}</span>
          {#if s.title}<span class="sub" title={s.title}>{s.title}</span>{/if}
        </span>
        <span class="st {s.state}">
          {s.state}
          {#if hint}<span class="hint" class:warn={hint !== 'building'}>{hint}</span>{/if}
        </span>
      </button>
    {:else}
      {#if listState === 'ready' && !error}
        <p class="empty">No ticket sandboxes yet.</p>
      {/if}
    {/each}
    {#if error}<p class="empty err" role="alert">{error}</p>{/if}
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-bottom: 1px solid var(--line);
  }
  .shead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 32px;
    padding: 0 8px 0 14px;
    flex: none;
  }
  .stitle {
    font-size: 11.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
  }
  .list {
    min-height: 0;
    overflow-y: auto;
    padding: 0 6px 6px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .row {
    display: grid;
    grid-template-columns: 8px minmax(0, 1fr) auto;
    align-items: center;
    gap: 9px;
    width: 100%;
    min-height: 34px;
    padding: 5px 8px 5px 10px;
    text-align: left;
    background: none;
    border: none;
    border-radius: var(--r-1);
    color: var(--ink-2);
  }
  .row:hover {
    background: var(--bg-2);
  }
  .row.current {
    background: var(--bg-3);
    color: var(--ink);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  /* The personal row has no state column; the repo list below it is its detail. */
  .row.personal {
    grid-template-columns: 8px minmax(0, 1fr);
  }
  .dot.pulse {
    animation: dotpulse 1.4s ease-in-out infinite;
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 1px;
  }
  .key {
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    font-size: 11.5px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .st {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    white-space: nowrap;
  }
  .st.creating {
    color: var(--accent);
  }
  .st.failed {
    color: var(--danger);
  }
  .st.expired {
    opacity: 0.7;
  }
  .hint {
    font-size: 10.5px;
    color: var(--accent);
  }
  .hint.warn {
    color: var(--warn);
  }
  .empty {
    margin: 0;
    padding: 8px 10px 6px;
    font-size: 12.5px;
    color: var(--muted);
  }
  .empty.err {
    color: var(--danger);
    overflow-wrap: anywhere;
  }
</style>
