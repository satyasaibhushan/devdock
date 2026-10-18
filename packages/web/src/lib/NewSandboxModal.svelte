<script lang="ts">
  import { type RepoState, type SandboxMemberInput, createSandbox, discoverSandbox } from './api'
  import Icon from './Icon.svelte'
  import SandboxMemberForm from './SandboxMemberForm.svelte'
  import { SANDBOX_KEY, memberKey, sourceLabel } from './sandboxUi'

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

  type Candidate = { member: SandboxMemberInput; checked: boolean; discovered: boolean }
  let key = $state('')
  let title = $state('')
  let wake = $state(false)
  let candidates = $state<Candidate[]>([])
  let discovering = $state(false)
  let creating = $state(false)
  // The key the proposals belong to; a different key means Discover again.
  let discoveredFor = $state<string | null>(null)
  let error = $state('')
  let keyInput: HTMLInputElement

  const trimmedKey = $derived(key.trim())
  const validKey = $derived(SANDBOX_KEY.test(trimmedKey))
  const chosen = $derived(candidates.filter((c) => c.checked).map((c) => c.member))
  const busy = $derived(discovering || creating)
  const canCreate = $derived(validKey && chosen.length > 0 && !busy)

  $effect(() => keyInput?.focus())

  async function discover() {
    if (!validKey || busy) return
    discovering = true
    error = ''
    try {
      const proposed = await discoverSandbox(trimmedKey, instance)
      const manual = candidates.filter((c) => !c.discovered)
      const manualKeys = new Set(manual.map((c) => memberKey(c.member)))
      candidates = [
        ...manual,
        ...proposed
          .filter((m) => !manualKeys.has(memberKey(m)))
          .map((member) => ({ member, checked: true, discovered: true })),
      ]
      discoveredFor = trimmedKey
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      discovering = false
    }
  }

  function add(member: SandboxMemberInput) {
    candidates = [...candidates, { member, checked: true, discovered: false }]
  }

  async function create() {
    if (!canCreate) return
    creating = true
    error = ''
    try {
      const result = await createSandbox(
        { key: trimmedKey, title: title.trim() || undefined, members: chosen, wake },
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
    if (e.key === 'Escape' && !busy) onclose()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) create()
  }
</script>

<svelte:window onkeydown={onkey} />

<div
  class="backdrop"
  role="button"
  tabindex="-1"
  aria-label="close"
  onclick={() => !busy && onclose()}
  onkeydown={() => {}}
></div>
<div class="modal" role="dialog" aria-modal="true" aria-label="New sandbox">
  <header><h3>New sandbox</h3></header>
  <div class="body">
    <p class="hint">
      A ticket sandbox leases a shared namespace and builds each member from its PR or branch.
      Members with matching open PRs are proposed; tick the ones to include.
    </p>
    <div class="row">
      <label class="lbl grow">
        <span>Ticket key</span>
        <input
          class="field mono"
          bind:this={keyInput}
          bind:value={key}
          placeholder="SULF-1234"
          spellcheck="false"
          disabled={busy}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              discover()
            }
          }}
        />
      </label>
      <button class="btn" disabled={!validKey || busy} onclick={discover}>
        {discovering ? 'Discovering…' : 'Discover PRs'}
      </button>
    </div>
    {#if trimmedKey && !validKey}<p class="err">Letters, digits, dots, dashes and underscores only.</p>{/if}
    <label class="lbl">
      <span>Title <span class="opt">optional</span></span>
      <input class="field" bind:value={title} placeholder="What this sandbox is for" disabled={busy} />
    </label>

    <div class="members" role="group" aria-label="members">
      {#each candidates as c (memberKey(c.member))}
        <label class="cand">
          <input type="checkbox" bind:checked={c.checked} disabled={busy} />
          <span class="mono repo">{c.member.repo}</span>
          <span class="wl">{c.member.workload}</span>
          <span class="src" title={c.member.source.kind === 'pr' ? c.member.source.url : c.member.source.ref}>
            {sourceLabel(c.member.source)}
          </span>
          <span class="from">{c.discovered ? 'discovered' : 'manual'}</span>
        </label>
      {:else}
        <p class="empty">
          {#if discoveredFor !== null}No open PRs mention {discoveredFor}. Add members below.
          {:else}Discover PRs for the key, or add members below.{/if}
        </p>
      {/each}
    </div>

    <SandboxMemberForm {repos} taken={candidates.map((c) => memberKey(c.member))} disabled={busy} onadd={add} />

    <label class="toggle">
      <input type="checkbox" bind:checked={wake} disabled={busy} />
      <span>Wake after build</span>
      <span class="opt">scale deployments up once every member is built</span>
    </label>

    {#if error}<p class="err" role="alert"><Icon name="alert" size={13} />{error}</p>{/if}
  </div>
  <footer>
    <button class="btn ghost" onclick={onclose} disabled={busy}>Cancel</button>
    <button class="btn primary" onclick={create} disabled={!canCreate}>
      {creating ? 'Creating…' : chosen.length ? `Create with ${chosen.length} member${chosen.length === 1 ? '' : 's'}` : 'Create sandbox'}
    </button>
  </footer>
</div>

<style>
  .modal {
    width: min(620px, calc(100vw - 48px));
  }
  .row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }
  .lbl {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 12.5px;
    color: var(--ink-2);
  }
  .lbl.grow {
    flex: 1;
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
    grid-template-columns: auto minmax(0, 1fr) auto auto auto;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    padding: 0 8px;
    border-radius: var(--r-1);
    font-size: 13px;
    color: var(--ink-2);
    cursor: pointer;
  }
  .cand:hover {
    background: var(--bg-2);
  }
  .cand input {
    margin: 0;
    accent-color: var(--accent);
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
  .from {
    font-size: 11px;
    color: var(--muted);
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
