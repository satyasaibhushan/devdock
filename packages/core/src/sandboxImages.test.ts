import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type SandboxImage,
  SandboxImageBuilds,
  ecrQuery,
  imageDigest,
  parallelMembers,
  pinSandboxBases,
  sandboxCacheTag,
  sandboxImageKey,
  sandboxRestart,
} from './sandboxImages.js'

let root: string
const image: SandboxImage = {
  image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/devspace',
  dockerfile: 'Dockerfile',
  context: '.',
  buildArgs: { BUILD_MODE: 'dev' },
  target: 'app',
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sandbox-images-'))
  writeFileSync(join(root, 'Dockerfile'), 'FROM scratch AS app\nCOPY . .\n')
  writeFileSync(join(root, 'app.ts'), 'export const value = 1')
  writeFileSync(join(root, '.env'), 'HOST=slot1')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('sandbox image inputs', () => {
  it('is stable across checkouts and output tags, including generated config/cache noise', async () => {
    const first = await sandboxImageKey(image, root)
    mkdirSync(join(root, '.devspace'))
    writeFileSync(join(root, '.devspace', 'cache'), 'slot1')
    writeFileSync(join(root, '.git'), '/checkout-specific/path')
    writeFileSync(join(root, '.devdock-sandbox-api.yaml'), 'namespace: slot1')
    symlinkSync('.devdock-sandbox-api.yaml', join(root, '.devdock-123.yaml'))
    expect(await sandboxImageKey({ ...image, tags: ['other-slot'] }, root)).toBe(first)
    expect(readFileSync(join(root, '.dockerignore'), 'utf8')).toContain('**/.devdock-*.yaml')
  })
  it.each(['app.ts', 'Dockerfile', '.env', '.dockerignore'])(
    'changes with %s content',
    async (file) => {
      const before = await sandboxImageKey(image, root)
      writeFileSync(join(root, file), 'changed')
      expect(await sandboxImageKey(image, root)).not.toBe(before)
    },
  )
  it('covers args, target, permissions, extra context files, and Dockerfile-specific ignores', async () => {
    const before = await sandboxImageKey(image, root)
    expect(
      await sandboxImageKey({ ...image, buildArgs: { BUILD_MODE: 'production' } }, root),
    ).not.toBe(before)
    expect(await sandboxImageKey({ ...image, target: 'other' }, root)).not.toBe(before)
    writeFileSync(join(root, 'generated'), 'new file')
    const extra = await sandboxImageKey(image, root)
    expect(extra).not.toBe(before)
    writeFileSync(join(root, 'Dockerfile.dockerignore'), '.env\n')
    expect(await sandboxImageKey(image, root)).not.toBe(extra)
    expect(readFileSync(join(root, 'Dockerfile.dockerignore'), 'utf8')).toContain('**/.git')
  })
  it('pins mutable base tags, resolves args, and preserves references to earlier stages', async () => {
    const digest = vi.fn(async () => `sha256:${'a'.repeat(64)}`)
    const source =
      'ARG ACCOUNT=123456789012\nFROM ${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/base/node:latest AS builder\nFROM builder AS app\n'
    const pinned = await pinSandboxBases(source, {}, digest)
    expect(pinned).toContain(`base/node@sha256:${'a'.repeat(64)} AS builder`)
    expect(pinned).toContain('FROM builder AS app')
    expect(digest).toHaveBeenCalledTimes(1)
    expect(await pinSandboxBases(pinned, {}, digest)).toBe(pinned)
  })
  it('rejects missing bases and unsupported FROM flags', async () => {
    await expect(
      pinSandboxBases('FROM registry/base:latest', {}, async () => undefined),
    ).rejects.toThrow('not found')
    await expect(
      pinSandboxBases('FROM --platform=linux/amd64 base', {}, async () => undefined),
    ).rejects.toThrow('flags')
  })
  it('uses cache refs stable per repo/workload and validates ECR responses', () => {
    expect(sandboxCacheTag('app', 'api')).toBe(sandboxCacheTag('app', 'api'))
    expect(sandboxCacheTag('app', 'api')).not.toBe(sandboxCacheTag('app', 'worker'))
    expect(ecrQuery(image.image, 'tag')).toEqual({
      SANDBOX_REGISTRY: '123456789012',
      AWS_REGION: 'us-east-1',
      SANDBOX_REPOSITORY: 'devspace',
      SANDBOX_TAG: 'tag',
    })
    expect(imageDigest('SANDBOX_IMAGE=missing\n')).toBeUndefined()
    expect(imageDigest(`SANDBOX_IMAGE=sha256:${'a'.repeat(64)}\n`)).toBe(`sha256:${'a'.repeat(64)}`)
    expect(() => imageDigest('AccessDenied')).toThrow('Invalid')
    expect(() => ecrQuery('docker.io/app', 'tag')).toThrow('ECR')
  })
})

it.each([true, false])(
  'skips a build only when ECR confirms an existing image: %s',
  async (exists) => {
    const deploy = vi.fn(async (_skip: boolean) => {})
    await new SandboxImageBuilds().deploy('key', async () => exists, deploy)
    expect(deploy).toHaveBeenCalledWith(exists)
  },
)

it('deduplicates overlapping builds and deploys the waiting member with skip-build', async () => {
  const builds = new SandboxImageBuilds()
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = vi.fn(async (_skip: boolean) => gate)
  const second = vi.fn(async (_skip: boolean) => {})
  const exists = vi.fn(async () => false)
  const a = builds.deploy('same-key', exists, first)
  const b = builds.deploy('same-key', exists, second)
  await vi.waitFor(() => expect(first).toHaveBeenCalledWith(false))
  expect(second).not.toHaveBeenCalled()
  release()
  await Promise.all([a, b])
  expect(exists).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalledWith(true)
})

it('propagates failed shared builds and permits an explicit retry', async () => {
  const builds = new SandboxImageBuilds()
  const failure = async () => {
    throw new Error('build failed')
  }
  const a = builds.deploy('key', async () => false, failure)
  const b = builds.deploy('key', async () => false, failure)
  expect((await Promise.allSettled([a, b])).every((r) => r.status === 'rejected')).toBe(true)
  const retry = vi.fn(async () => {})
  await builds.deploy('key', async () => false, retry)
  expect(retry).toHaveBeenCalledWith(false)
})

it('limits concurrency to two and lets every member finish after failures', async () => {
  const finished: number[] = []
  let active = 0
  let maximum = 0
  const result = parallelMembers([0, 1, 2, 3], async (member) => {
    active++
    maximum = Math.max(maximum, active)
    await new Promise((r) => setTimeout(r, 1))
    active--
    finished.push(member)
    if (member === 0 || member === 2) throw new Error(`member ${member} failed`)
  })
  await expect(result).rejects.toMatchObject({ errors: [expect.any(Error), expect.any(Error)] })
  expect(finished.sort()).toEqual([0, 1, 2, 3])
  expect(maximum).toBe(2)
})

it.each([
  [true, 'repo:old', 'repo:new', false],
  [true, undefined, 'repo:new', false],
  [true, 'repo:same', 'repo:same', true],
  [false, 'repo:same', 'repo:same', false],
])('restarts awake=%s previous=%s next=%s: %s', (awake, previous, next, restart) => {
  expect(sandboxRestart(awake, previous, next)).toBe(restart)
})

it('reuses backend contexts across slots only when .env is certainly excluded', async () => {
  writeFileSync(join(root, '.dockerignore'), '.env\nbootstrap/cache\n!bootstrap/cache/.gitignore\n')
  const backend = await sandboxImageKey(image, root)
  writeFileSync(join(root, '.env'), 'HOST=other-slot')
  expect(await sandboxImageKey(image, root)).toBe(backend)
  writeFileSync(join(root, '.dockerignore'), '.env\n!.env\n')
  const ui = await sandboxImageKey(image, root)
  writeFileSync(join(root, '.env'), 'HOST=third-slot')
  expect(await sandboxImageKey(image, root)).not.toBe(ui)
})

it('refuses build flags that can read inputs outside the fingerprinted context', async () => {
  await expect(
    sandboxImageKey({ ...image, buildKit: { args: ['--secret=id=env,src=/elsewhere/env'] } }, root),
  ).rejects.toThrow('external')
})
