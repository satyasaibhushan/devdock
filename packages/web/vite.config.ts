import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

const DAEMON = 'http://127.0.0.1:7717'

// Dev server proxies HTTP + WS to the always-on daemon (spec §17 phase 1: localhost).
export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5273,
    proxy: {
      '/repos': { target: DAEMON, ws: true, changeOrigin: true },
      '/health': { target: DAEMON, changeOrigin: true },
      '/events': { target: DAEMON, ws: true, changeOrigin: true },
    },
  },
})
