import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = import.meta.dirname

export default defineConfig({
  resolve: {
    alias: {
      '@devdock/core': resolve(root, 'packages/core/src/index.ts'),
      '@devdock/mcp/client': resolve(root, 'packages/mcp/src/client.ts'),
      '@devdock/mcp/server': resolve(root, 'packages/mcp/src/server.ts'),
      '@devdock/mcp': resolve(root, 'packages/mcp/src/index.ts'),
      '@devdock/daemon': resolve(root, 'packages/daemon/src/index.ts'),
      '@devdock/cli': resolve(root, 'packages/cli/src/index.ts'),
    },
  },
})
