import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it.each([
  { signal: 'SIGINT' as const, code: 130, duringStart: false },
  { signal: 'SIGTERM' as const, code: 143, duringStart: true },
])('cancels the daemon run on $signal and exits $code', async ({ signal, code, duringStart }) => {
  let child: ChildProcess | undefined
  const requests: string[] = []
  const server = createServer((req, res) => {
    const path = `${req.method} ${req.url}`
    requests.push(path)
    res.setHeader('content-type', 'application/json')
    if (path === 'POST /repos/example/test') {
      if (duringStart) {
        child?.kill(signal)
        setTimeout(() => res.end('{"id":"test-run"}'), 50)
      } else res.end('{"id":"test-run"}')
    } else if (path === 'GET /tests/test-run') {
      if (!duringStart) child?.kill(signal)
    } else if (path === 'POST /tests/test-run/cancel') {
      res.end('{"state":"interrupted","exitCode":130}')
    } else {
      res.statusCode = 404
      res.end('{}')
    }
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
    const entry = fileURLToPath(new URL('./index.ts', import.meta.url))
    child = spawn(process.execPath, ['--import', 'tsx', entry, 'test', 'example'], {
      env: { ...process.env, DEVDOCK_URL: `http://127.0.0.1:${address.port}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (data) => {
      stderr += String(data)
    })
    expect(await once(child, 'close'), stderr).toEqual([code, null])
    expect(requests).toEqual([
      'POST /repos/example/test',
      ...(duringStart ? [] : ['GET /tests/test-run']),
      'POST /tests/test-run/cancel',
    ])
  } finally {
    child?.kill('SIGKILL')
    server.closeAllConnections()
    server.close()
  }
})
