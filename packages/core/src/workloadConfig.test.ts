import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareWorkloadConfig, workloadConfigPath } from './workloadConfig.js'
import { scopeRepo } from './workloads.js'
import type { Repo } from './types.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture(): Repo {
  const path = mkdtempSync(join(tmpdir(), 'devdock-workloads-'))
  dirs.push(path)
  execFileSync('git', ['init', '-q', path])
  writeFileSync(join(path, 'devspace.yaml'), 'version: v2beta1\nname: service\n')
  return {
    id: 'service',
    name: 'service',
    path,
    configPath: join(path, 'devspace.yaml'),
    ports: [],
    session: 'devdock-service',
  }
}
describe('workload config isolation', () => {
  it('uses distinct cache filenames without copying source or changing git status', () => {
    const base = fixture()
    const api = scopeRepo(base, 'api')
    const worker = scopeRepo(base, 'worker')
    const before = execFileSync('git', ['status', '--porcelain'], {
      cwd: base.path,
      encoding: 'utf8',
    })
    prepareWorkloadConfig(api)
    prepareWorkloadConfig(worker)
    prepareWorkloadConfig(api)
    expect(workloadConfigPath(api)).not.toEqual(workloadConfigPath(worker))
    expect(readlinkSync(workloadConfigPath(api))).toBe('devspace.yaml')
    writeFileSync(base.configPath, 'updated source')
    expect(readFileSync(workloadConfigPath(api), 'utf8')).toBe('updated source')
    expect(readFileSync(workloadConfigPath(worker), 'utf8')).toBe('updated source')
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: base.path, encoding: 'utf8' }),
    ).toBe(before)
  })
  it('refuses to overwrite an existing file', () => {
    const repo = scopeRepo(fixture(), 'api')
    writeFileSync(workloadConfigPath(repo), 'user file')
    expect(() => prepareWorkloadConfig(repo)).toThrow()
    expect(readFileSync(workloadConfigPath(repo), 'utf8')).toBe('user file')
  })
  it('leaves standalone configs untouched', () => {
    const repo = fixture()
    prepareWorkloadConfig(repo)
    expect(() => readlinkSync(workloadConfigPath(repo))).toThrow()
  })
})
