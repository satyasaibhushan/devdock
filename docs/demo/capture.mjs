// Records docs/demo/poster.png, demo.webm and demo.mp4 from the real web UI
// running against the fictional demo daemon (packages/daemon/demo).
//
//   pnpm --filter @devdock/web build
//   PLAYWRIGHT=/path/to/node_modules/playwright FFMPEG=ffmpeg node docs/demo/capture.mjs
//
// PLAYWRIGHT defaults to resolving `playwright` from the working directory.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PORT = 7799
const BASE = `http://127.0.0.1:${PORT}`
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg'
const require = createRequire(join(process.cwd(), 'noop.js'))
const { chromium } = require(process.env.PLAYWRIGHT ?? 'playwright')
const VIEWPORT = { width: 1440, height: 900 }

const daemon = spawn(
  join(ROOT, 'node_modules/.bin/tsx'),
  ['packages/daemon/demo/fixtureDaemon.ts'],
  {
    cwd: ROOT,
    env: { ...process.env, DEMO_PORT: String(PORT) },
    stdio: 'inherit',
  },
)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; ; i++) {
  if (
    await fetch(`${BASE}/health`).then(
      (r) => r.ok,
      () => false,
    )
  )
    break
  if (i > 50) throw new Error('demo daemon did not start')
  await sleep(200)
}

const browser = await chromium.launch()
try {
  // Poster: the sandbox grid in its seeded state, at 2x for README readability.
  const still = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 })
  await still.goto(`${BASE}/?repo=orders-api`)
  await still.getByRole('button', { name: 'Sandboxes', exact: true }).click()
  await still.getByText('SHOP-131').first().waitFor()
  await sleep(800)
  await still.screenshot({ path: join(OUT, 'poster.png') })
  await still.close()

  // Video: CDP screencast frames keep text crisp; each frame lasts until the next.
  const page = await browser.newPage({ viewport: VIEWPORT })
  const cdp = await page.context().newCDPSession(page)
  const frames = []
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    frames.push({ data, at: metadata.timestamp })
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  })
  await page.goto(`${BASE}/?repo=orders-api`)
  await page.locator('.xterm').waitFor()
  await sleep(1500)
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
  await sleep(4000)
  await page.getByRole('button', { name: 'Sandboxes', exact: true }).click()
  await sleep(2500)
  const card = (key) => page.locator('article.card', { hasText: key })
  await card('SHOP-157').getByRole('button', { name: 'Wake' }).click()
  await sleep(4000)
  await card('SHOP-131').getByRole('button', { name: 'Restore' }).click()
  await sleep(5000)
  await card('SHOP-131').getByRole('button', { name: 'SHOP-131' }).click()
  await sleep(3500)
  await page.getByRole('button', { name: 'Sleep' }).click()
  await sleep(4000)
  await cdp.send('Page.stopScreencast')
  await page.close()

  const dir = mkdtempSync(join(tmpdir(), 'devdock-demo-'))
  const list = frames.map((frame, i) => {
    const file = join(dir, `${String(i).padStart(5, '0')}.png`)
    writeFileSync(file, Buffer.from(frame.data, 'base64'))
    const next = frames[i + 1]?.at ?? frame.at + 1.5
    return `file '${file}'\nduration ${(next - frame.at).toFixed(3)}`
  })
  // The concat demuxer ignores the last duration unless the file is repeated.
  list.push(`file '${join(dir, `${String(frames.length - 1).padStart(5, '0')}.png`)}'`)
  writeFileSync(join(dir, 'frames.txt'), list.join('\n'))
  const input = ['-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt'), '-vf', 'fps=30']
  const encode = (args) => {
    const result = spawnSync(FFMPEG, [...input, ...args], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`ffmpeg failed: ${args.at(-1)}`)
  }
  encode([
    '-c:v',
    'libvpx-vp9',
    '-crf',
    '34',
    '-b:v',
    '0',
    '-row-mt',
    '1',
    '-an',
    join(OUT, 'demo.webm'),
  ])
  encode([
    '-c:v',
    'libx264',
    '-crf',
    '24',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-an',
    join(OUT, 'demo.mp4'),
  ])
  rmSync(dir, { recursive: true })
} finally {
  await browser.close()
  daemon.kill()
}
