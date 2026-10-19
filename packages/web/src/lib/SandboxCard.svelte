<script lang="ts">
  import type { SandboxView } from './api'
  import Icon from './Icon.svelte'
  import {
    type CardAction,
    cardAction,
    cardSentence,
    memberKey,
    builtLabel,
    relativeTime,
  } from './sandboxUi'

  // One sandbox as a snapshot card: ribbon, key, one sentence, what it shows,
  // the stable link, and one primary action. The daemon's /s/:key page renders
  // the same shape server-side.
  let {
    sandbox,
    now,
    busy = false,
    onopen,
    onaction,
  }: {
    sandbox: SandboxView
    now: number
    busy?: boolean
    /** Open the sandbox's page in the dashboard (null for the personal one). */
    onopen: (key: string | null) => void
    onaction: (sandbox: SandboxView, action: 'wake' | 'restore' | 'evict') => void
  } = $props()

  const action = $derived<CardAction>(cardAction(sandbox))
  const expired = $derived(sandbox.ribbon === 'expired' || sandbox.ribbon === 'expired restorable')
  const ribbonMeta = $derived(
    sandbox.personal
      ? sandbox.slot ?? ''
      : sandbox.snapshot
        ? `snapshot ${relativeTime(sandbox.snapshot.at, now)} ago`
        : sandbox.slot ?? '',
  )
  let copied = $state(false)
  async function copyLink() {
    await navigator.clipboard.writeText(sandbox.link)
    copied = true
    setTimeout(() => (copied = false), 1500)
  }
  function primary() {
    if (action === 'open' && sandbox.personal) return onopen(null)
    if (action === 'open') return window.open(sandbox.urls[0], '_blank', 'noreferrer')
    if (action === 'logs') return onopen(sandbox.key)
    if (action) onaction(sandbox, action)
  }
</script>

<article class="card" class:expired class:personal={sandbox.personal}>
  <div class="rib {sandbox.ribbon.split(' ')[0]}">
    <span>{sandbox.personal ? 'personal' : sandbox.ribbon}</span>
    <span class="r">{ribbonMeta}</span>
  </div>
  <div class="hd">
    <button class="k" title="Open {sandbox.key} in the dashboard" onclick={() => onopen(sandbox.personal ? null : sandbox.key)}>{sandbox.key}</button>
    {#if sandbox.title}<span class="n" title={sandbox.title}>{sandbox.title}</span>{/if}
  </div>
  <p class="one" class:err={!!sandbox.error}>{cardSentence(sandbox, now)}</p>
  {#if sandbox.snapshot}
    <div class="shows">
      <div class="sh"><span>shows</span><span class="ago">by {sandbox.snapshot.actor}</span></div>
      {#each sandbox.snapshot.members as m (memberKey(m))}
        <div class="ln">
          <span class="repo" title="{m.repo} {m.workload}">{m.repo} <span class="wl">{m.workload}</span></span>
          <span class="h" title={m.sha}>{builtLabel(m.branch, m.sha)}</span>
          {#if m.pr}<a class="pr" href={m.pr.url} target="_blank" rel="noreferrer" title={m.pr.url}>PR #{m.pr.number}</a>{/if}
          {#if m.dirtyFiles.length}<span class="dirty" title={m.dirtyFiles.join('\n')}>+{m.dirtyFiles.length} files</span>{/if}
        </div>
      {/each}
    </div>
  {:else if !sandbox.personal}
    <div class="shows">
      <div class="sh"><span>shows</span></div>
      {#each sandbox.members as m (memberKey(m))}
        <div class="ln">
          <span class="repo" title="{m.repo} {m.workload}">{m.repo} <span class="wl">{m.workload}</span></span>
          <span class="h" title={m.deployedSha}>{builtLabel(m.branch, m.deployedSha) || '-'}</span>
          <span class="cmp">{m.build.state === 'idle' ? (m.deployedSha ? '' : 'not built') : m.build.state}</span>
        </div>
      {:else}
        <div class="ln"><span class="repo">no members</span></div>
      {/each}
    </div>
  {/if}
  <div class="ft">
    {#if !sandbox.personal}
      <a class="lk" href={sandbox.link} title={sandbox.link}>{sandbox.link.replace(/^https?:\/\//, '')}</a>
      <button class="btn ghost icon sm" title="Copy stable link" aria-label="Copy stable link" onclick={copyLink}>
        <Icon name={copied ? 'check' : 'copy'} size={11} />
      </button>
    {/if}
    {#if action}
      <button class="btn sm" class:primary={action !== 'logs'} disabled={busy} onclick={primary}>
        {#if action === 'open'}Open{:else if action === 'wake'}Wake{:else if action === 'restore'}Restore
        {:else if action === 'evict'}Evict and restore{:else}Build logs{/if}
      </button>
    {/if}
  </div>
</article>

<style>
  .card {
    display: flex;
    flex-direction: column;
    min-width: 0;
    border: 1px solid var(--line-strong);
    border-radius: var(--r-3);
    background: var(--bg-1);
    overflow: hidden;
  }
  .card.expired {
    border-style: dashed;
  }
  .card.personal {
    grid-column: 1 / -1;
  }
  .rib {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 12px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    background: var(--bg-2);
    color: var(--ink-2);
  }
  .rib .r {
    margin-left: auto;
    font-family: var(--mono);
    font-size: 11.5px;
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
    color: var(--muted);
  }
  .rib.awake {
    background: color-mix(in srgb, var(--ok) 14%, transparent);
    color: var(--ok);
  }
  .rib.building {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
  }
  .rib.expired {
    background: transparent;
    color: var(--deployed);
  }
  .rib.failed {
    background: color-mix(in srgb, var(--danger) 14%, transparent);
    color: var(--danger);
  }
  .hd {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
    padding: 12px 12px 4px;
  }
  .k {
    padding: 0;
    border: 0;
    background: none;
    color: var(--ink);
    font-family: var(--mono);
    font-size: 17px;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }
  .k:hover {
    color: var(--accent);
  }
  .n {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-2);
    font-size: 13px;
  }
  .one {
    margin: 0;
    padding: 0 12px 10px;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--ink-2);
  }
  .one.err {
    color: var(--danger);
    overflow-wrap: anywhere;
  }
  .shows {
    margin: 0 12px;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: var(--r-2);
    background: var(--bg-0);
    font-family: var(--mono);
    font-size: 12px;
  }
  .sh {
    display: flex;
    margin-bottom: 6px;
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .sh .ago {
    margin-left: auto;
    text-transform: none;
    letter-spacing: 0;
  }
  .ln {
    display: flex;
    gap: 10px;
    padding: 2px 0;
    white-space: nowrap;
  }
  .repo {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .wl {
    color: var(--muted);
  }
  .h {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--ink-2);
  }
  .pr {
    color: var(--accent);
    text-decoration: none;
  }
  .pr:hover {
    text-decoration: underline;
  }
  .dirty {
    color: var(--deployed);
  }
  .cmp {
    margin-left: auto;
    color: var(--muted);
  }
  .ft {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: auto;
    padding: 12px;
  }
  .lk {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--accent);
    text-decoration: none;
  }
  .lk:hover {
    text-decoration: underline;
  }
  .ft .btn:last-child {
    margin-left: auto;
  }
</style>
