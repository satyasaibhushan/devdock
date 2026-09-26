<script lang="ts">
  import { type InstanceView, type MovePlan, fetchMovePlan } from './api'
  import { instanceSymbol } from './globalRepos'
  import Icon from './Icon.svelte'

  // Confirmation for moving a deployment to another machine. The daemon plans
  // the move (who releases, what runs after); this only previews that plan so
  // the user sees both checkouts before anything changes hands.
  let {
    repo,
    workload,
    to,
    owner,
    busy = false,
    onconfirm,
    oncancel,
  }: {
    repo: string
    workload?: string
    to: InstanceView
    owner?: InstanceView
    busy?: boolean
    onconfirm: () => void
    oncancel: () => void
  } = $props()

  let plan = $state<MovePlan | null>(null)
  let error = $state<string | null>(null)

  $effect(() => {
    let cancelled = false
    fetchMovePlan(repo, workload, to.id)
      .then((p) => { if (!cancelled) plan = p })
      .catch((e) => { if (!cancelled) error = e instanceof Error ? e.message : String(e) })
    return () => { cancelled = true }
  })

  const label = $derived(`${repo}${workload ? ` (${workload})` : ''}`)
  const short = (commit: string | null) => commit?.slice(0, 7) ?? 'unknown'
  const followUp = $derived.by(() => {
    if (!plan) return ''
    if (plan.followUp === 'start') return `start on ${to.name}`
    if (plan.followUp === 'build_start') return `build + start on ${to.name} (different revision)`
    return `nothing runs; deploy or start it from ${to.name} next`
  })

  function onkey(e: KeyboardEvent) {
    if (e.key === 'Escape' && !busy) oncancel()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && plan && !busy) onconfirm()
  }
</script>

<svelte:window onkeydown={onkey} />

<div class="backdrop" role="button" tabindex="-1" aria-label="cancel" onclick={() => !busy && oncancel()} onkeydown={() => {}}></div>
<div class="modal" role="dialog" aria-modal="true" aria-label="Move {label} to {to.name}">
  <header>
    <h3>Move to {to.name}?</h3>
    <code>{label}</code>
  </header>
  <div class="body">
    {#if error}
      <p class="err" role="alert">{error}</p>
    {:else if !plan}
      <p class="hint">Reading both checkouts…</p>
    {:else}
      <div class="plan">
        <div class="row">
          <span class="k">From</span>
          <span class="machine"><span class="sym">{instanceSymbol(owner)}</span>{owner?.name ?? 'unlinked owner'}</span>
          {#if plan.from}
            <span class="rev"><Icon name="branch" size={12} /><span class="bname">{plan.from.branch ?? 'detached'}</span><code>@{short(plan.from.commit)}</code>{#if plan.from.dirty}<span class="flag">modified</span>{/if}</span>
          {:else}
            <span class="rev muted">{plan.ownerOnline ? 'checkout unknown' : 'unreachable'}</span>
          {/if}
        </div>
        <div class="row">
          <span class="k">To</span>
          <span class="machine"><span class="sym">{instanceSymbol(to)}</span>{to.name}</span>
          <span class="rev"><Icon name="branch" size={12} /><span class="bname">{plan.target.branch ?? 'detached'}</span><code>@{short(plan.target.commit)}</code>{#if plan.target.dirty}<span class="flag">modified</span>{/if}</span>
        </div>
      </div>
      {#if plan.from && !plan.sameRevision}
        <p class="note warn"><Icon name="alert" size={13} />The target checkout is at a different revision.</p>
      {/if}
      <p class="hint">
        {plan.ownerOnline
          ? `${owner?.name ?? 'The owner'} gives up the deployment${plan.live ? ' and stops its dev session' : ''}; the pods keep running.`
          : `${owner?.name ?? 'The owner'} is unreachable, so ${to.name} takes the deployment over. If it comes back with a dev session still running, DevDock there stops it.`}
        Then: <b>{followUp}</b>.
      </p>
    {/if}
  </div>
  <footer>
    <button class="btn ghost" onclick={oncancel} disabled={busy}>Cancel</button>
    <button class="btn primary" onclick={onconfirm} disabled={busy || !plan}>
      {busy ? 'Moving…' : `Move to ${to.name}`}
    </button>
  </footer>
</div>

<style>
  .modal {
    width: min(560px, calc(100vw - 48px));
  }
  .plan {
    display: grid;
    gap: 6px;
    padding: 10px 12px;
    background: var(--bg-0);
    border: 1px solid var(--line);
    border-radius: var(--r-2);
    font-size: 13px;
  }
  .row {
    display: grid;
    grid-template-columns: 38px 150px minmax(0, 1fr);
    align-items: center;
    gap: 10px;
  }
  .k {
    color: var(--muted);
    font-size: 12px;
  }
  .machine {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sym {
    color: var(--accent);
  }
  .rev {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    color: var(--ink-2);
    font-family: var(--mono);
    font-size: 12.5px;
    white-space: nowrap;
  }
  /* A long branch name gives way; the commit and the dirty flag always show. */
  .bname {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rev code,
  .flag {
    flex: none;
  }
  .rev code {
    color: var(--muted);
  }
  .rev.muted {
    color: var(--muted);
    font-family: var(--sans);
  }
  .flag {
    color: var(--warn);
    font-family: var(--sans);
    font-size: 12px;
  }
  .note {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 0;
    font-size: 13px;
  }
  .note.warn {
    color: var(--warn);
  }
</style>
