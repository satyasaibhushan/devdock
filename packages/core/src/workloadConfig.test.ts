import { execFileSync } from 'node:child_process'
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { devspaceCommand } from './supervisor.js'
import type { Repo } from './types.js'
import {
  devdockConfigPath,
  guidelinesTemplate,
  prepareWorkloadConfig,
  workloadConfigPath,
} from './workloadConfig.js'
import { scopeRepo } from './workloads.js'

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

describe('tuned overlay', () => {
  const uiConfig = `version: v2beta1
name: web
imports:
  - git: git@github.com:vmockinc/guidelines.git
    branch: master
    subPath: ./devspace/ui
`
  it('recognizes the shared guidelines templates only', () => {
    expect(guidelinesTemplate(uiConfig)).toBe('ui')
    expect(guidelinesTemplate(uiConfig.replace('/ui', '/non-ui'))).toBe('non-ui')
    expect(guidelinesTemplate(uiConfig.replace('vmockinc', 'someone'))).toBeUndefined()
    expect(guidelinesTemplate('name: x')).toBeUndefined()
  })
  it('writes an importing overlay with the devdock profile, replacing its old alias', () => {
    const repo = fixture()
    writeFileSync(repo.configPath, uiConfig)
    const alias = workloadConfigPath(repo)
    symlinkSync('devspace.yaml', alias)
    prepareWorkloadConfig(repo)
    expect(lstatSync(alias).isSymbolicLink()).toBe(false)
    const doc = parseYaml(readFileSync(alias, 'utf8'))
    expect(doc.imports).toEqual([{ path: './devspace.yaml' }])
    expect(doc.profiles[0].name).toBe('devdock')
    prepareWorkloadConfig(repo) // regenerating its own file is fine
    expect(devdockConfigPath(repo)).toBe(alias)
    expect(devspaceCommand(repo, 'deploy')).toContain(
      `DEVSPACE_CONFIG='${alias}' devspace deploy -p devdock`,
    )
    expect(devspaceCommand(repo, 'deploy -p persistent -p sandbox')).not.toContain('-p devdock')
  })
  it('seeds an own-image replica build from the parent cache', () => {
    const repo = fixture()
    writeFileSync(repo.configPath, `${uiConfig}vars:\n  DEVDOCK_CACHE_SEED: ns-web\n`)
    prepareWorkloadConfig(repo)
    const doc = parseYaml(readFileSync(workloadConfigPath(repo), 'utf8'))
    const build = doc.profiles[0].patches.find(
      (p: { path: string }) => p.path === 'images.app.buildKit',
    )
    expect(build.value.args).toContain(
      '--cache-from=type=registry,ref=${AWS_ECR_DEVSPACE_REPO}:ns-web-cache',
    )
  })
  it('never replaces a file it did not generate', () => {
    const repo = fixture()
    writeFileSync(repo.configPath, uiConfig)
    writeFileSync(workloadConfigPath(repo), 'user file')
    expect(() => prepareWorkloadConfig(repo)).toThrow()
    expect(readFileSync(workloadConfigPath(repo), 'utf8')).toBe('user file')
  })
  it('leaves untuned standalone repos on their own config', () => {
    const repo = fixture()
    expect(devdockConfigPath(repo)).toBeUndefined()
    expect(devspaceCommand(repo, 'deploy')).not.toContain('DEVSPACE_CONFIG')
  })
})
