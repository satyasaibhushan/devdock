<script lang="ts">
  import { onDestroy } from 'svelte'
  import Icon from './Icon.svelte'

  let { url }: { url: string } = $props()
  let copied = $state('')
  let error = $state('')
  let timer: ReturnType<typeof setTimeout> | undefined
  onDestroy(() => clearTimeout(timer))

  async function copy() {
    const value = url
    error = ''
    try {
      await navigator.clipboard.writeText(value)
      copied = value
      clearTimeout(timer)
      timer = setTimeout(() => (copied = ''), 1500)
    } catch {
      error = 'Could not copy the URL'
    }
  }
</script>

<span class="chip">
  <a href={url} target="_blank" rel="noreferrer" title={url}>
    <span class="url">{url.replace(/^https?:\/\//, '')}</span>
    <Icon name="external" size={11} />
  </a>
  <button class="copy" title="Copy URL" aria-label="Copy {url}" onclick={copy}>
    <Icon name={copied === url ? 'check' : 'copy'} size={11} />
  </button>
</span>
{#if error}<span class="error" role="alert">{error}</span>{/if}

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    height: 24px;
    background: var(--bg-2);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-1);
    overflow: hidden;
  }
  .chip a {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    height: 100%;
    padding: 0 8px;
    color: var(--accent);
    text-decoration: none;
    font-family: var(--mono);
    font-size: 12px;
  }
  .chip a:hover {
    background: var(--bg-3);
  }
  .url {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 320px;
  }
  .copy {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 100%;
    border: 0;
    border-left: 1px solid var(--line-strong);
    background: transparent;
    color: var(--muted);
    padding: 0;
  }
  .copy:hover {
    color: var(--ink);
    background: var(--bg-3);
  }
  .error {
    color: var(--danger);
  }
</style>
