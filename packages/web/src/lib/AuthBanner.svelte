<script lang="ts">
  // Kubernetes auth indicator (header) — visible only when something needs the
  // user: login required (one shared browser sign-in for all workloads),
  // sign-in in progress, or an auth error. Silent when ok or when the cluster
  // doesn't use oidc-login at all.
  import { type AuthState, clearAuthCache, startAuthLogin } from './api.js'

  let {
    auth,
    onchanged,
  }: {
    auth: AuthState
    /** Parent refreshes its /auth snapshot (and toasts failures). */
    onchanged: (next: AuthState) => void
  } = $props()

  let busy = $state(false)

  const visible = $derived(auth.oidc && auth.phase !== 'ok' && auth.phase !== 'unknown')

  async function login() {
    busy = true
    try {
      onchanged(await startAuthLogin())
    } catch {
      // next poll shows the real state
    } finally {
      busy = false
    }
  }

  async function clearCache() {
    busy = true
    try {
      onchanged(await clearAuthCache())
    } catch {
      // next poll shows the real state
    } finally {
      busy = false
    }
  }
</script>

{#if visible}
  <div
    class="auth {auth.phase}"
    title={auth.message ?? 'kubernetes auth'}
    role="status"
  >
    {#if auth.phase === 'logging_in'}
      <span class="spin" aria-hidden="true"></span>
      <span class="msg">{auth.message ?? 'complete the Google sign-in in your browser…'}</span>
    {:else}
      <span class="dot" aria-hidden="true"></span>
      <span class="msg">
        {auth.message ??
          (auth.phase === 'error' ? 'kubernetes auth error' : 'kubernetes login required')}
      </span>
      <button class="act" onclick={login} disabled={busy}>log in</button>
      <button
        class="act ghost"
        onclick={clearCache}
        disabled={busy}
        title="rm -r ~/.kube/cache/oidc-login — force a clean login"
      >
        clear cache
      </button>
    {/if}
  </div>
{/if}

<style>
  .auth {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 520px;
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--panel2);
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink);
  }
  .auth.login_required,
  .auth.error {
    border-color: color-mix(in srgb, var(--warn, #e2b93b) 55%, var(--line));
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--warn, #e2b93b);
    flex: none;
  }
  .msg {
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .act {
    font-family: var(--mono);
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 6px;
    border: 1px solid var(--accent);
    background: transparent;
    color: var(--accent);
    cursor: pointer;
    flex: none;
  }
  .act:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .act.ghost {
    border-color: var(--line);
    color: var(--muted);
  }
  .act:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .spin {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 2px solid var(--line);
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
