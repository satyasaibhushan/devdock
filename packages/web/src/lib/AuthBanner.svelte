<script lang="ts">
  // Kubernetes auth indicator (header) — visible only when something needs the
  // user: login required (one explicit shared sign-in for all workloads),
  // sign-in in progress, or an auth error. Silent when ok or when the cluster
  // doesn't use oidc-login at all. A pending AWS sign-in shows its own pill
  // (the daemon never opens a browser, so this link is the only way in).
  import { type AuthState, clearAuthCache, startAuthLogin } from './api.js'
  import Icon from './Icon.svelte'

  let {
    instance = '',
    auth,
    onchanged,
  }: {
    instance?: string
    auth: AuthState
    /** Parent refreshes its /auth snapshot (and toasts failures). */
    onchanged: (next: AuthState) => void
  } = $props()

  let busy = $state(false)

  const visible = $derived(auth.oidc && auth.phase !== 'ok' && auth.phase !== 'unknown')

  async function login() {
    busy = true
    try {
      onchanged(await startAuthLogin(instance))
    } catch {
      // next poll shows the real state
    } finally {
      busy = false
    }
  }

  async function clearCache() {
    busy = true
    try {
      onchanged(await clearAuthCache(instance))
    } catch {
      // next poll shows the real state
    } finally {
      busy = false
    }
  }
</script>

{#if auth.awsLoginUrl}
  <div class="auth login_required" title="AWS refresh token expired" role="status">
    <Icon name="alert" size={13} />
    <span class="msg">AWS sign-in required</span>
    <a class="btn sm" href={auth.awsLoginUrl} target="_blank" rel="noreferrer">Open sign-in<Icon name="external" size={11} /></a>
  </div>
{/if}
{#if visible}
  <div
    class="auth {auth.phase}"
    title={auth.message ?? 'kubernetes auth'}
    role="status"
  >
    {#if auth.phase === 'logging_in'}
      <span class="spin" aria-hidden="true"></span>
      <span class="msg">{auth.message ?? 'preparing sign-in…'}</span>
      {#if auth.loginUrl}
        <a class="btn sm" href={auth.loginUrl} target="_blank" rel="noreferrer">Open sign-in<Icon name="external" size={11} /></a>
      {/if}
    {:else}
      <Icon name="alert" size={13} />
      <span class="msg">
        {auth.message ??
          (auth.phase === 'error' ? 'kubernetes auth error' : 'kubernetes login required')}
      </span>
      <button class="btn sm primary" onclick={login} disabled={busy}>Log in</button>
      <button
        class="btn sm quiet"
        onclick={clearCache}
        disabled={busy}
        title="rm -r ~/.kube/cache/oidc-login — force a clean login"
      >
        Clear cache
      </button>
    {/if}
  </div>
{/if}

<style>
  /* Compact warning chip: never wraps, the message ellipsises first so the
     actions stay reachable at narrow widths. */
  .auth {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 6px 0 10px;
    border-radius: var(--r-2);
    border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
    background: color-mix(in srgb, var(--warn) 10%, transparent);
    color: var(--warn);
    font-size: 12px;
    white-space: nowrap;
    min-width: 0;
    flex: 0 1 auto;
  }
  .auth.error {
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    color: var(--danger);
  }
  .auth.logging_in {
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    color: var(--accent);
  }
  .msg {
    color: var(--ink-2);
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 220px;
    min-width: 36px;
    flex: 0 1 auto;
  }
  .auth .btn {
    flex: none;
  }
  .auth a.btn {
    text-decoration: none;
  }
  .spin {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 2px solid color-mix(in srgb, var(--accent) 30%, transparent);
    border-top-color: var(--accent);
    animation: rot 0.8s linear infinite;
    flex: none;
  }
  @keyframes rot {
    to {
      transform: rotate(360deg);
    }
  }
</style>
