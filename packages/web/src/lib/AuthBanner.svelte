<script lang="ts">
  // Sign-in indicator (header): one chip and one Sign in button for everything
  // the user must do, Kubernetes and AWS alike. Silent when both are fine. The
  // daemon never opens a browser, so the chip's link is the only way in; when
  // both flows are pending it offers one at a time, and the IdP session makes
  // the second one instant.
  import { type AuthState, clearAuthCache, startAuthLogin, startAwsLogin } from './api.js'
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

  const kube = $derived(auth.oidc && auth.phase !== 'ok' && auth.phase !== 'unknown')
  const awsLoginUrl = $derived(auth.aws?.loginUrl ?? auth.awsLoginUrl)
  const aws = $derived(auth.aws?.state === 'required' || awsLoginUrl !== undefined)
  const loginUrl = $derived(auth.loginUrl ?? awsLoginUrl)
  const pending = $derived(auth.phase === 'logging_in' || awsLoginUrl !== undefined)
  const message = $derived(
    kube && aws
      ? 'Kubernetes and AWS sign-in required'
      : aws
        ? 'AWS sign-in required'
        : (auth.message ??
          (auth.phase === 'error' ? 'kubernetes auth error' : 'kubernetes login required')),
  )
  const detail = $derived(
    [kube ? auth.message : undefined, aws ? auth.aws?.message : undefined]
      .filter((m) => m !== undefined)
      .join('\n'),
  )

  async function signIn() {
    busy = true
    try {
      // AWS first so the Kubernetes snapshot, the more detailed one, lands last.
      if (aws) onchanged(await startAwsLogin(instance))
      if (kube) onchanged(await startAuthLogin(instance))
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

{#if kube || aws}
  <div
    class="auth {pending ? 'logging_in' : kube ? auth.phase : 'login_required'}"
    title={detail || message}
    role="status"
  >
    {#if pending}
      <span class="spin" aria-hidden="true"></span>
      <span class="msg">{auth.phase === 'logging_in' ? (auth.message ?? 'preparing sign-in…') : message}</span>
      {#if loginUrl}
        <a class="btn sm" href={loginUrl} target="_blank" rel="noreferrer">Open sign-in<Icon name="external" size={11} /></a>
      {/if}
    {:else}
      <Icon name="alert" size={13} />
      <span class="msg">{message}</span>
      <button class="btn sm primary" onclick={signIn} disabled={busy}>Sign in</button>
      {#if kube}
        <button
          class="btn sm quiet"
          onclick={clearCache}
          disabled={busy}
          title="rm -r ~/.kube/cache/oidc-login — force a clean login"
        >
          Clear cache
        </button>
      {/if}
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
    font-size: 13px;
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
