import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

// DEVDOCK_DAEMON points the dev server at another daemon (a fixture or a
// remote one) without touching the always-on local instance.
const DAEMON = process.env.DEVDOCK_DAEMON ?? 'http://127.0.0.1:7717'

// The daemon's access gate accepts browser traffic only when Origin matches its
// own Host, so the proxy presents itself as a same-origin client.
const upstream = { target: DAEMON, changeOrigin: true, headers: { origin: DAEMON } }
const upstreamWs = { ...upstream, ws: true }

// Dev server proxies HTTP + WS to the always-on daemon (spec §17 phase 1: localhost).
export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5273,
    proxy: {
      '/repos': upstreamWs,
      '/health': upstream,
      '/events': upstreamWs,
      '/terminals': upstreamWs,
      '/namespace': upstream,
      '/auth': upstream,
      '/instances': upstreamWs,
      '/operations': upstream,
      '/replicas': upstream,
    },
  },
})
