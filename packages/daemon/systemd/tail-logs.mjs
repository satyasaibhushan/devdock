#!/usr/bin/env node
import WebSocket from 'ws'

const [repo, workload = 'api'] = process.argv.slice(2)
const runtime = process.env.XDG_RUNTIME_DIR
if (!repo || !runtime) {
  console.error('Usage: devdock-logs <repo> [workload], with XDG_RUNTIME_DIR set')
  process.exit(2)
}
const path = `/repos/${encodeURIComponent(repo)}/logs?workload=${encodeURIComponent(workload)}`
const ws = new WebSocket(`ws+unix://${runtime}/devdock/control.sock:${path}`)
ws.on('message', (data) => process.stdout.write(`${data.toString()}\n`))
ws.on('error', (error) => {
  console.error(error.message)
  process.exitCode = 1
})
process.on('SIGINT', () => ws.close())
process.on('SIGTERM', () => ws.close())
