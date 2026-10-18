import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Service } from '@devdock/core'
import { expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { attachWs } from './wsServer.js'

it('pushes sandbox changes on the event stream and removes the listener on close', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-ws-'))
  const service = new Service(
    { stateFile: join(root, 'state.json') },
    { runner: async () => ({ code: 0, stdout: '', stderr: '' }) },
  )
  const server = createServer()
  const wss = attachWs(server, service)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test address')
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/events`)
  try {
    await once(ws, 'open')
    const message = once(ws, 'message')
    service.events.emit('sandbox', { key: 'SULF-1', state: 'expired' })
    expect(JSON.parse(String((await message)[0]))).toEqual({
      type: 'sandbox',
      sandbox: { key: 'SULF-1', state: 'expired' },
    })
    const serverSocket = [...wss.clients][0]
    if (!serverSocket) throw new Error('missing server socket')
    const serverClosed = once(serverSocket, 'close')
    const closed = once(ws, 'close')
    ws.close()
    await closed
    await serverClosed
    expect(service.events.listenerCount('sandbox')).toBe(0)
  } finally {
    ws.terminate()
    wss.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})
