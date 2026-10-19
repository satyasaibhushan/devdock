<script lang="ts">
  import type { RepoState, SandboxMemberInput } from './api'
  import { memberSource } from './sandboxUi'

  let {
    repos,
    taken = [],
    disabled = false,
    onadd,
  }: {
    repos: RepoState[]
    /** repo:workload keys already in the sandbox, refused before the daemon sees them. */
    taken?: string[]
    disabled?: boolean
    onadd: (member: SandboxMemberInput) => void
  } = $props()

  let repo = $state('')
  let workload = $state('')
  let source = $state('')
  let error = $state('')

  // Replicas are not sandbox members; the daemon validates against parents.
  const parents = $derived(repos.filter((r) => !r.repo.parentId))
  const picked = $derived(parents.find((r) => r.repo.id === repo)?.repo)
  const workloads = $derived.by(() => {
    if (!picked) return []
    if (picked.workloads?.length) return picked.workloads
    return [picked.workloadType ?? (picked.codeArea === 'frontend' ? 'ui' : 'api')]
  })
  // The chosen workload if the repo still offers it, else the repo default.
  const activeWorkload = $derived(
    workloads.includes(workload) ? workload : (picked?.defaultWorkload ?? workloads[0] ?? ''),
  )

  function submit(event: SubmitEvent) {
    event.preventDefault()
    error = ''
    if (!repo || !activeWorkload) {
      error = 'Choose a repo'
      return
    }
    if (taken.includes(`${repo}:${activeWorkload}`)) {
      error = 'Already a member'
      return
    }
    try {
      onadd({ repo, workload: activeWorkload, source: memberSource(source) })
      source = ''
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }
</script>

<form class="member-form" onsubmit={submit}>
  <select class="sel mono" aria-label="Repo" bind:value={repo} {disabled}>
    <option value="" disabled>Choose repo</option>
    {#each parents as r (r.repo.id)}<option value={r.repo.id}>{r.repo.id}</option>{/each}
  </select>
  <select
    class="sel mono"
    aria-label="Workload"
    value={activeWorkload}
    onchange={(e) => (workload = e.currentTarget.value)}
    disabled={disabled || workloads.length < 2}
  >
    {#each workloads as type (type)}<option value={type}>{type}</option>{/each}
  </select>
  <input
    class="field mono"
    aria-label="PR URL or branch"
    placeholder="PR URL or branch"
    bind:value={source}
    {disabled}
  />
  <button class="btn" type="submit" disabled={disabled || !repo || !source.trim()}>Add</button>
  {#if error}<span class="err" role="alert">{error}</span>{/if}
</form>

<style>
  .member-form {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .member-form .sel {
    max-width: 200px;
  }
  .member-form .field {
    flex: 1 1 160px;
    min-width: 0;
    height: 26px;
  }
  .field.mono {
    font-family: var(--mono);
    font-size: 12.5px;
  }
  .err {
    flex-basis: 100%;
    font-size: 12.5px;
    color: var(--danger);
  }
</style>
