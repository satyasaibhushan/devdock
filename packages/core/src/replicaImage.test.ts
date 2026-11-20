import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { replicaImageWarnings } from './replicaImage.js'

let path: string
beforeEach(() => {
  path = mkdtempSync(join(tmpdir(), 'devdock-replica-image-'))
  writeFileSync(
    join(path, 'Dockerfile'),
    'ARG PHP=php:8\nFROM ${PHP} AS build\nFROM build AS app\n',
  )
})
afterEach(() => rmSync(path, { force: true, recursive: true }))

const image = '1.dkr.ecr.us-east-1.amazonaws.com/app'
const effective = `version: v2beta1
vars:
  AWS_DEVSPACE_PROFILE_NAME:
    value: devspace
images:
  app:
    image: ${image}
    tags: [parent]
`
const repo = () => ({
  path,
  configPath: join(path, 'devspace.yaml'),
  name: 'app-r1',
  id: 'app-r1',
  session: 'devdock-app-r1',
  ports: [],
})

it('warns when a tracked branch Dockerfile change postdates the reused image', async () => {
  const runner = vi.fn(async (cmd: string) => ({
    code: 0,
    stderr: '',
    stdout: cmd === 'git' ? '20' : '10',
  }))
  expect(await replicaImageWarnings(repo(), effective, runner)).toEqual([
    `Parent image ${image}:parent predates the branch's Dockerfile. Set ownImage=true to rebuild it.`,
  ])
  expect(runner.mock.calls.map(([cmd]) => cmd)).toEqual(['aws', 'git'])
})

it('warns when the Dockerfile references a newer base image', async () => {
  const runner = vi.fn(async (cmd: string) => ({
    code: 0,
    stderr: '',
    stdout: cmd === 'git' ? '5' : cmd === 'aws' ? '10' : '"1970-01-01T00:00:20Z"',
  }))
  expect(await replicaImageWarnings(repo(), effective, runner)).toEqual([
    `Parent image ${image}:parent predates base image php:8. Set ownImage=true to rebuild it.`,
  ])
  expect(runner.mock.calls.map(([cmd]) => cmd)).toEqual(['aws', 'git', 'docker'])
})

it('uses image metadata as best effort for registries without access', async () => {
  const runner = vi.fn(async () => ({ code: 1, stderr: 'forbidden', stdout: '' }))
  expect(await replicaImageWarnings(repo(), effective, runner)).toEqual([])
})
