<script lang="ts">
  import { fetchInstances, linkInstance, unlinkInstance, selectInstance, selectedInstance, type InstanceView } from './api'
  let instances = $state<InstanceView[]>([])
  let expanded = $state(false)
  let linking = $state(false)
  let host = $state('')
  let endpoint = $state('')
  let terminals = $state(false)
  let busy = $state(false)
  let error = $state('')
  const active = $derived(instances.find((item) => item.local ? !selectedInstance : item.id === selectedInstance))
  async function refresh() {
    try { instances = await fetchInstances() } catch { error = 'Instance directory unavailable' }
  }
  $effect(() => { void refresh(); const timer = setInterval(refresh, 15_000); return () => clearInterval(timer) })
  async function link() {
    busy = true; error = ''
    try { await linkInstance(host, endpoint, terminals); linking = false; await refresh() }
    catch (e) { error = e instanceof Error ? e.message : 'Link failed' }
    finally { busy = false }
  }
  async function unlink(id: string) {
    if (!confirm('Disconnect this instance? Its deployments keep running.')) return
    try { await unlinkInstance(id); if (selectedInstance === id) selectInstance(''); await refresh() }
    catch (e) { error = e instanceof Error ? e.message : 'Unlink failed' }
  }
</script>

<div class="instances">
  <button class="toggle" onclick={() => expanded = !expanded} aria-expanded={expanded}>
    <span class="dot" class:online={active?.online}></span>
    {active?.name ?? (selectedInstance ? 'Remote instance' : 'This machine')}
    <span class="count">{instances.length} instances</span>
  </button>
  {#if expanded}
    <section class="panel" aria-label="Connected instances">
      <div class="heading"><b>Instances</b><button onclick={() => linking = !linking}>Link machine</button></div>
      {#each instances as item (item.id)}
        <article>
          <div class="row">
            <button class="name" onclick={() => selectInstance(item.local ? '' : item.id)}>
              <span class="dot" class:online={item.online}></span>{item.name}
              <small>{item.local ? 'this machine' : 'SSH'}</small>
            </button>
            {#if !item.local}<button class="unlink" onclick={() => unlink(item.id)}>Unlink</button>{/if}
          </div>
          <div class="meta">{item.online ? `Kubernetes: ${item.auth?.phase ?? 'unknown'} · AWS: ${item.aws?.fresh ? 'ready' : item.aws?.configured ? 'refresh on demand' : 'not configured'}` : 'Offline. Deployment ownership retained.'}</div>
          {#each item.repos.filter((repo) => repo.status !== 'STOPPED') as repo (repo.repo.id)}
            <button class="deployment" onclick={() => selectInstance(item.local ? '' : item.id, repo.repo.id)}><span>{repo.repo.id}</span><small>{repo.status}</small></button>
          {/each}
        </article>
      {/each}
      {#if linking}
        <form onsubmit={(event) => { event.preventDefault(); void link() }}>
          <label>SSH alias<input bind:value={host} placeholder="devbox" required /></label>
          <label>Daemon socket or loopback port<input bind:value={endpoint} placeholder="/run/user/1000/devdock/control.sock" required /></label>
          <label class="check"><input type="checkbox" bind:checked={terminals} /> Allow remote terminals</label>
          <p>Terminals grant the SSH account's shell access. Keep disabled for restricted agent connections. Credentials are never copied by linking.</p>
          <button disabled={busy}>{busy ? 'Connecting…' : 'Connect through SSH'}</button>
        </form>
      {/if}
      {#if error}<p role="alert">{error}</p>{/if}
    </section>
  {/if}
</div>

<style>
  .instances { position: relative; font-size: 12px; }
  button { color: var(--ink); background: none; border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px; cursor: pointer; font: inherit; }
  button:hover { border-color: var(--accent); }
  .toggle, .row, .name, .heading { display: flex; align-items: center; gap: 8px; }
  .count, small, .meta { color: var(--muted); font-size: 11px; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  .dot.online { background: var(--accent); }
  .panel { position: absolute; top: calc(100% + 12px); left: 0; width: min(480px, 88vw); max-height: 75vh; overflow: auto; padding: 16px; z-index: 60; background: var(--bg, #101419); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 16px 48px #0008; }
  .heading, .row { justify-content: space-between; }
  article { border-top: 1px solid var(--line); margin-top: 12px; padding-top: 12px; }
  .name { border: 0; padding-left: 0; }
  .unlink { color: var(--muted); }
  .meta { margin: 6px 0; }
  .deployment { display: flex; justify-content: space-between; width: 100%; margin-top: 5px; gap: 10px; text-align: left; }
  form { display: grid; gap: 10px; border-top: 1px solid var(--line); margin-top: 15px; padding-top: 15px; }
  label { display: grid; gap: 5px; }
  input { padding: 8px; color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 5px; font: inherit; }
  .check { display: flex; align-items: center; }
  p { color: var(--muted); line-height: 1.5; margin: 0; }
</style>
