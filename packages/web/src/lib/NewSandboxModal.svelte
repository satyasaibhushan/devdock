<script lang="ts">
  import { type RepoState, type SandboxMemberInput, createSandbox } from './api'
  import Icon from './Icon.svelte'
  import SandboxMemberForm from './SandboxMemberForm.svelte'
  import { SANDBOX_KEY, checkoutLabel, memberKey } from './sandboxUi'

  let {
    repos,
    instance,
    onclose,
    oncreated,
  }: {
    repos: RepoState[]
    instance: string
    onclose: () => void
    oncreated: (key: string, operationId: string) => void
  } = $props()

  let key = $state('')
  let title = $state('')
  let wake = $state(false)
  let members = $state<SandboxMemberInput[]>([])
  let creating = $state(false)
  let error = $state('')
  let keyInput: HTMLInputElement

  const trimmedKey = $derived(key.trim())
  const validKey = $derived(SANDBOX_KEY.test(trimmedKey))
  const canCreate = $derived(validKey && members.length > 0 && !creating)

  $effect(() => keyInput?.focus())

  async function create() {
    if (!canCreate) return
    creating = true
    error = ''
    try {
      const result = await createSandbox(
        { key: trimmedKey, title: title.trim() || undefined, members, wake },
        instance,
      )
      oncreated(trimmedKey, result.operationId)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      creating = false
    }
  }

  function onkey(e: KeyboardEvent) {
    if (e.key === 'Escape' && !creating) onclose()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) create()
  }
</script>

<svelte:window onkeydown={onkey} />

<div
  class="backdrop"
  role="button"
  tabindex="-1"
  aria-label="close"
  onclick={() => !creating && onclose()}
  onkeydown={() => {}}
></div>
<div class="modal" role="dialog" aria-modal="true" aria-label="New sandbox">
  <header><h3>New sandbox</h3></header>
  <div class="body">
    <p class="hint">
      A ticket sandbox leases a shared namespace and builds each member from a checkout, uncommitted
      files included. Leave the path empty to build the repo's checkout.
    </p>
    <label class="lbl">
      <span>Ticket key</span>
      <input
        class="field mono"
        bind:this={keyInput}
        bind:value={key}
        placeholder="SULF-1234"
        spellcheck="false"
        disabled={creating}
      />
    </label>
    {#if trimmedKey && !validKey}<p class="err">Letters, digits, dots, dashes and underscores only.</p>{/if}
    <label class="lbl">
      <span>Title <span class="opt">optional</span></span>
      <input class="field" bind:value={title} placeholder="What this sandbox is for" disabled={creating} />
    </label>

    <div class="members" role="group" aria-label="members">
      {#each members as m (memberKey(m))}
        <div class="cand">
          <span class="mono repo">{m.repo}</span>
          <span class="wl">{m.workload}</span>
          <span class="src" title={m.path ?? "The repo's registered checkout"}>{checkoutLabel(m)}</span>
          <button
            class="btn ghost icon sm"
            aria-label="Remove {m.repo} {m.workload}"
            disabled={creating}
            onclick={() => (members = members.filter((c) => memberKey(c) !== memberKey(m)))}
          ><Icon name="x" size={11} /></button>
        </div>
      {:else}
        <p class="empty">Add members below.</p>
      {/each}
    </div>

    <SandboxMemberForm
      {repos}
      taken={members.map(memberKey)}
      disabled={creating}
      onadd={(m) => (members = [...members, m])}
    />

    <label class="toggle">
      <input type="checkbox" bind:checked={wake} disabled={creating} />
      <span>Wake after build</span>
      <span class="opt">scale deployments up once every member is built</span>
    </label>

    {#if error}<p class="err" role="alert"><Icon name="alert" size={13} />{error}</p>{/if}
  </div>
  <footer>
    <button class="btn ghost" onclick={onclose} disabled={creating}>Cancel</button>
    <button class="btn primary" onclick={create} disabled={!canCreate}>
      {creating ? 'Creating…' : members.length ? `Create with ${members.length} member${members.length === 1 ? '' : 's'}` : 'Create sandbox'}
    </button>
  </footer>
</div>

<style>
  .modal {
    width: min(620px, calc(100vw - 48px));
  }
  .lbl {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 12.5px;
    color: var(--ink-2);
  }
  .lbl .field {
    width: 100%;
  }
  .field.mono {
    font-family: var(--mono);
    font-size: 13px;
  }
  .opt {
    color: var(--muted);
    font-weight: 400;
  }
  .members {
    max-height: 220px;
    overflow-y: auto;
    background: var(--bg-0);
    border: 1px solid var(--line);
    border-radius: var(--r-2);
    padding: 4px;
  }
  .cand {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    padding: 0 8px;
    border-radius: var(--r-1);
    font-size: 13px;
    color: var(--ink-2);
  }
  .mono {
    font-family: var(--mono);
    font-size: 12.5px;
  }
  .repo {
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wl {
    font-size: 11px;
    padding: 1px 5px;
    border-radius: var(--r-1);
    color: var(--muted);
    background: color-mix(in srgb, var(--muted) 14%, transparent);
  }
  .src {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--accent);
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    margin: 0;
    padding: 14px 10px;
    font-size: 13px;
    color: var(--muted);
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--ink-2);
    cursor: pointer;
  }
  .toggle input {
    margin: 0;
    accent-color: var(--accent);
  }
  .toggle .opt {
    font-size: 12px;
  }
  .err {
    display: flex;
    align-items: center;
    gap: 6px;
  }
</style>
