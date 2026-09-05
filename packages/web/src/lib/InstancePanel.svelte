<script lang="ts">
  import { linkInstance, unlinkInstance, type InstanceView } from './api'
  import { instanceSymbol } from './globalRepos'
  let { instances, onrefresh }: { instances: InstanceView[]; onrefresh: () => Promise<void> } = $props()
  let expanded = $state(false)
  let linking = $state(false)
  let host = $state('')
  let endpoint = $state('')
  let terminals = $state(false)
  let busy = $state(false)
  let error = $state('')
  async function link() {
    busy = true; error = ''
    try { await linkInstance(host, endpoint, terminals); linking = false; await onrefresh() }
    catch (e) { error = e instanceof Error ? e.message : 'Link failed' }
    finally { busy = false }
  }
  async function unlink(id: string) {
    if (!confirm('Disconnect this instance? Its deployments keep running.')) return
    try { await unlinkInstance(id); await onrefresh() }
    catch (e) { error = e instanceof Error ? e.message : 'Unlink failed' }
  }
</script>

<div class="instances">
  <div class="strip" aria-label="Connected machines">
    {#each instances as item (item.id)}
      <button class="chip" title="{item.name}: {item.online ? 'online' : 'offline'}. Connection details."
        onclick={() => expanded = !expanded} aria-expanded={expanded}>
        <span class="symbol">{instanceSymbol(item)}</span>
        {item.name.replace('.local', '').replace('-mark-one', '')}
        <span class="dot" class:online={item.online}></span>
      </button>
    {/each}
    <button class="manage" title="Manage instances and authentication" aria-label="Manage instances" onclick={() => expanded = !expanded} aria-expanded={expanded}>⌄</button>
  </div>
  {#if expanded}
    <section class="panel" aria-label="Connected instances">
      <div class="heading"><b>Instances</b><button onclick={() => linking = !linking}>Link machine</button></div>
      {#each instances as item (item.id)}
        <article>
          <div class="row">
            <div class="name">
              <span class="symbol">{instanceSymbol(item)}</span><span class="dot" class:online={item.online}></span>{item.name}
              <small>{item.local ? 'this machine' : 'SSH'}</small>
            </div>
            {#if !item.local}<button class="unlink" onclick={() => unlink(item.id)}>Unlink</button>{/if}
          </div>
          <div class="meta">{item.online ? `Kubernetes: ${item.auth?.phase ?? 'unknown'} · AWS: ${item.aws?.fresh ? 'ready' : item.aws?.configured ? 'refresh on demand' : 'not configured'}` : 'Offline. Deployment ownership retained.'}</div>
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
  .strip, .chip, .row, .name, .heading { display: flex; align-items: center; gap: 8px; }
  .strip { gap: 2px; padding: 3px; border: 1px solid var(--line); border-radius: 7px; }
  .chip, .manage { border-color: transparent; }
  .symbol { color: var(--accent); font-size: 15px; }
  small, .meta { color: var(--muted); font-size: 11px; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  .dot.online { background: var(--accent); }
  .panel { position: absolute; top: calc(100% + 12px); left: 0; width: min(480px, 88vw); max-height: 75vh; overflow: auto; padding: 16px; z-index: 60; background: var(--bg, #101419); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 16px 48px #0008; }
  .heading, .row { justify-content: space-between; }
  article { border-top: 1px solid var(--line); margin-top: 12px; padding-top: 12px; }
  .name { border: 0; padding-left: 0; }
  .unlink { color: var(--muted); }
  .meta { margin: 6px 0; }
  form { display: grid; gap: 10px; border-top: 1px solid var(--line); margin-top: 15px; padding-top: 15px; }
  label { display: grid; gap: 5px; }
  input { padding: 8px; color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 5px; font: inherit; }
  .check { display: flex; align-items: center; }
  p { color: var(--muted); line-height: 1.5; margin: 0; }
</style>
