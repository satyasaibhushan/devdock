<script lang="ts">
  import { linkInstance, unlinkInstance, type InstanceView } from './api'
  import { instanceSymbol } from './globalRepos'
  import Icon from './Icon.svelte'
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
  const shortName = (name: string) => name.replace('.local', '').replace('-mark-one', '')
  const authLine = (item: InstanceView) =>
    item.online
      ? `Kubernetes: ${item.auth?.phase ?? 'unknown'} · AWS: ${item.aws?.fresh ? 'ready' : item.aws?.configured ? 'refresh on demand' : 'not configured'}`
      : 'Offline. Deployment ownership retained.'
</script>

<div class="instances">
  <div class="strip" aria-label="Connected machines">
    {#each instances as item (item.id)}
      <button class="chip" class:offline={!item.online} title="{item.name}: {item.online ? 'online' : 'offline'}. Connection details."
        onclick={() => expanded = !expanded} aria-expanded={expanded}>
        <span class="symbol">{instanceSymbol(item, instances)}</span>
        <span class="cname">{shortName(item.name)}</span>
        <span class="dot" class:online={item.online}></span>
      </button>
    {/each}
    <button class="manage" title="Manage instances and authentication" aria-label="Manage instances" onclick={() => expanded = !expanded} aria-expanded={expanded}><Icon name="chevron-down" size={12} /></button>
  </div>
  {#if expanded}
    <section class="panel" aria-label="Connected instances">
      <div class="heading"><b>Instances</b><button class="btn sm" class:primary={!linking} onclick={() => linking = !linking}><Icon name="plus" size={11} />Link machine</button></div>
      <div class="list">
        {#each instances as item (item.id)}
          <article>
            <div class="row">
              <div class="name">
                <span class="symbol">{instanceSymbol(item, instances)}</span>
                <span class="dot" class:online={item.online}></span>
                <span class="nm">{item.name}</span>
                <small>{item.local ? 'this machine' : 'SSH'}</small>
              </div>
              {#if !item.local}<button class="btn sm quiet" onclick={() => unlink(item.id)}>Unlink</button>{/if}
            </div>
            <div class="meta">{authLine(item)}</div>
          </article>
        {/each}
      </div>
      {#if linking}
        <form onsubmit={(event) => { event.preventDefault(); void link() }}>
          <label>SSH alias<input class="field" bind:value={host} placeholder="devbox" required /></label>
          <label>Daemon socket or loopback port<input class="field mono" bind:value={endpoint} placeholder="/run/user/1000/devdock/control.sock" required /></label>
          <label class="check"><input type="checkbox" bind:checked={terminals} /> Allow remote terminals</label>
          <p>Terminals grant the SSH account's shell access. Keep disabled for restricted agent connections. Credentials are never copied by linking.</p>
          <div class="formfoot"><button class="btn primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect through SSH'}</button></div>
        </form>
      {/if}
      {#if error}<p class="err" role="alert">{error}</p>{/if}
    </section>
  {/if}
</div>

<style>
  .instances {
    position: relative;
    font-size: 13px;
    min-width: 0;
    flex: 0 1 auto;
  }
  .strip {
    display: flex;
    align-items: center;
    min-width: 0;
    height: 28px;
    padding: 0 2px;
    border: 1px solid var(--line-strong);
    border-radius: var(--r-2);
    background: var(--bg-2);
    white-space: nowrap;
  }
  .chip,
  .manage {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    height: 22px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--r-1);
    background: transparent;
    color: var(--ink-2);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .chip:hover,
  .manage:hover,
  .chip[aria-expanded='true'],
  .manage[aria-expanded='true'] {
    background: var(--bg-3);
    color: var(--ink);
  }
  .chip.offline .cname {
    color: var(--muted);
  }
  .chip + .chip {
    /* Hairline divider between machines. */
    margin-left: 2px;
  }
  .manage {
    padding: 0 5px;
    color: var(--muted);
  }
  .symbol {
    color: var(--accent);
    font-size: 14px;
    line-height: 1;
  }
  .cname {
    max-width: 140px;
    min-width: 24px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .manage {
    flex: none;
  }
  small,
  .meta {
    color: var(--muted);
    font-size: 12px;
  }
  .dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--stopped);
    flex: none;
  }
  .dot.online {
    background: var(--ok);
  }
  .panel {
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    width: min(460px, 88vw);
    max-height: 75vh;
    overflow: auto;
    z-index: 60;
    background: var(--bg-1);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-3);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
  }
  .heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
  }
  .heading b {
    font-size: 13px;
    font-weight: 600;
  }
  .list {
    padding: 4px 0;
  }
  article {
    padding: 8px 14px;
  }
  article + article {
    border-top: 1px solid var(--line);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .name {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }
  .nm {
    color: var(--ink);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    margin-top: 4px;
  }
  form {
    display: grid;
    gap: 10px;
    border-top: 1px solid var(--line);
    padding: 12px 14px 14px;
    background: var(--bg-0);
  }
  label {
    display: grid;
    gap: 5px;
    color: var(--ink-2);
  }
  .field.mono {
    font-family: var(--mono);
    font-size: 13px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .check input {
    accent-color: var(--accent);
    margin: 0;
  }
  p {
    color: var(--muted);
    line-height: 1.5;
    margin: 0;
    font-size: 12.5px;
  }
  .formfoot {
    display: flex;
    justify-content: flex-end;
  }
  .err {
    color: var(--danger);
    padding: 8px 14px 12px;
  }
</style>
