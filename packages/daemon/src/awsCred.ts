#!/usr/bin/env node
// devdock-aws-cred — the credential_process shim for ~/.aws/config:
//
//   [profile devspace]
//   credential_process = /path/to/node /path/to/dist/awsCred.js
//
// Every aws/devspace/docker process asks the daemon for the credential instead
// of running its own OIDC login — the daemon single-flights the mint, so
// parallel callers can never race a login port or open duplicate browser tabs.
// stdout is the credential_process JSON contract; everything else goes to
// stderr, which the aws CLI surfaces to the user on failure.
import { request } from 'node:http'

const port = process.env.DEVDOCK_PORT ?? '7717'
const host = process.env.DEVDOCK_HOST ?? '127.0.0.1'
const url = `http://${host}:${port}/aws/credential`

try {
  // Generous timeout: the daemon may be holding this open through a browser
  // sign-in it just triggered (its own interactive flow gives up at ~190s).
  const socketPath = process.env.DEVDOCK_SOCKET
  const result = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(
      {
        ...(socketPath ? { socketPath } : { hostname: host, port }),
        path: '/aws/credential',
        signal: AbortSignal.timeout(200_000),
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          text += chunk
        })
        res.on('error', reject)
        res.on('end', () => resolve({ status: res.statusCode ?? 500, text }))
      },
    )
    req.on('error', reject)
    req.end()
  })
  const body = JSON.parse(result.text) as { error?: string }
  if (result.status !== 200) {
    console.error(`devdock-aws-cred: ${body.error ?? `daemon answered ${result.status}`}`)
    process.exit(1)
  }
  process.stdout.write(JSON.stringify(body))
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err)
  console.error(
    `devdock-aws-cred: could not reach the devdock daemon at ${url} (${detail}) — is it running?`,
  )
  process.exit(1)
}
