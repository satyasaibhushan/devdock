import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { environmentWarning } from './environmentWarning.js'
import type { Repo } from './types.js'

const root = mkdtempSync(join(tmpdir(), 'devdock-env-'))
const repo = { path: join(root, '.devspace', 'api'), root } as Repo
afterEach(() => rmSync(root, { force: true, recursive: true }))

it('warns for missing configuration beside a template, without returning its values', () => {
  writeFileSync(join(root, '.env.example'), 'PRIVATE_VALUE=example')
  expect(environmentWarning(repo)).toContain('no regular .env file')
  mkdirSync(join(root, '.env'))
  expect(environmentWarning(repo)).toContain('no regular .env file')
  rmSync(join(root, '.env'), { recursive: true })
  writeFileSync(join(root, '.env'), 'PRIVATE_VALUE=actual')
  expect(environmentWarning(repo)).toBeUndefined()
})
