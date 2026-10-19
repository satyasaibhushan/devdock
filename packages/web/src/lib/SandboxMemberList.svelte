<script lang="ts">
  import type { SandboxMember } from './api'
  import Icon from './Icon.svelte'
  import { memberBuildState, memberKey, memberStale, shortSha } from './sandboxUi'

  let { members, selectedKey, onselect, onadd }: {
    members: SandboxMember[]
    selectedKey: string | null
    onselect: (key: string) => void
    onadd: () => void
  } = $props()
</script>

<nav aria-label="Sandbox members">
  <div class="heading">Members <span>{members.length}</span></div>
  {#each members as member (memberKey(member))}
    {@const state = memberBuildState(member)}
    <button class="row" class:current={memberKey(member) === selectedKey}
      aria-pressed={memberKey(member) === selectedKey}
      title="Show logs for {member.repo} {member.workload}"
      onclick={() => onselect(memberKey(member))}>
      <span class="name">{member.repo}</span>
      <span class="workload">{member.workload || 'default'}</span>
      <span class="state {state}">{state}</span>
      <span class="hint" class:stale={memberStale(member)}>
        {#if memberStale(member)}{member.deployedSha ? 'Behind head' : 'Not deployed'}
        {:else if member.merged}Merged
        {:else}Deployed{/if}
        {#if member.deployedSha}<span title={member.deployedSha}>{shortSha(member.deployedSha)}</span>{/if}
      </span>
    </button>
  {:else}
    <p class="empty">No members yet.<br />Add a repo to this sandbox.</p>
  {/each}
  <button class="add" onclick={onadd}><Icon name="plus" size={12} />Add member</button>
</nav>

<style>
  nav { height: 100%; overflow-y: auto; padding: 4px 6px 8px; }
  .heading { display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 6px; color: var(--muted); font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; }
  .heading span { font-family: var(--mono); font-weight: 400; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 4px 7px; width: 100%; padding: 8px 8px 8px 10px; border: 0; border-radius: var(--r-1); background: none; color: var(--ink-2); text-align: left; }
  .row:hover { background: var(--bg-2); }
  .row.current { background: var(--bg-3); color: var(--ink); box-shadow: inset 2px 0 0 var(--accent); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 13px; }
  .workload { font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .state { padding: 1px 5px; border-radius: var(--r-1); background: color-mix(in srgb, currentColor 12%, transparent); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ok); }
  .state.stale { color: var(--warn); }
  .state.building, .state.queued { color: var(--accent); }
  .state.failed { color: var(--danger); }
  .hint { grid-column: 1 / -1; display: flex; gap: 6px; font-size: 11.5px; color: var(--muted); }
  .hint.stale { color: var(--warn); }
  .hint span { font-family: var(--mono); }
  .empty { margin: 8px 10px 12px; color: var(--muted); font-size: 13px; line-height: 1.6; }
  .add { display: flex; align-items: center; gap: 6px; margin-top: 4px; padding: 6px 10px; border: 0; border-radius: var(--r-1); color: var(--muted); background: none; font-size: 12px; }
  .add:hover { background: var(--bg-2); color: var(--ink); }
</style>
