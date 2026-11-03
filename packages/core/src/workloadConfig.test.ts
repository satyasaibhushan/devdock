import { execFileSync } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
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
  markPullSecretRefreshed,
  prepareWorkloadConfig,
  workloadConfigPath,
} from './workloadConfig.js'
import { scopeRepo } from './workloads.js'

// Keep pull-secret stamps out of the real ~/.devdock.
process.env.DEVDOCK_STATE_DIR = mkdtempSync(join(tmpdir(), 'devdock-state-'))

const dirs: string[] = []
const deps = mkdtempSync(join(tmpdir(), 'devdock-deps-'))
process.env.DEVDOCK_DEVSPACE_DEPENDENCIES = deps
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
  it('writes the repo config with the devdock profile, replacing its old alias', () => {
    const repo = fixture()
    writeFileSync(repo.configPath, uiConfig)
    const alias = workloadConfigPath(repo)
    symlinkSync('devspace.yaml', alias)
    prepareWorkloadConfig(repo)
    expect(lstatSync(alias).isSymbolicLink()).toBe(false)
    const doc = parseYaml(readFileSync(alias, 'utf8'))
    // No local checkout of the guidelines: DevSpace keeps fetching it.
    expect(doc.imports[0].git).toBe('git@github.com:vmockinc/guidelines.git')
    expect(doc.name).toBe('web')
    expect(doc.profiles.map((p: { name: string }) => p.name)).toEqual(['devdock'])
    expect(doc.functions.docker_login_to_ecr).toContain('ecr-login.stamp')
    prepareWorkloadConfig(repo) // regenerating its own file is fine
    expect(devdockConfigPath(repo)).toBe(alias)
    expect(devspaceCommand(repo, 'deploy')).toContain(
      `DEVSPACE_CONFIG='${alias}' devspace deploy -p devdock`,
    )
    expect(devspaceCommand(repo, 'deploy -p persistent -p sandbox')).not.toContain('-p devdock')
  })
  it('reads the guidelines from the local checkout when there is one', () => {
    const repo = fixture()
    writeFileSync(repo.configPath, uiConfig.replace('/ui', '/non-ui'))
    const local = join(deps, 'git-github-com-vmockinc-guidelines-git-master', 'devspace', 'non-ui')
    mkdirSync(local, { recursive: true })
    writeFileSync(
      join(local, 'devspace.yaml'),
      `version: v2beta1\nfunctions:\n  prepare_local_env: |-\n    file="$1"\n    sed -i '' -r "s~a~b~" $file\n`,
    )
    prepareWorkloadConfig(repo)
    const doc = parseYaml(readFileSync(workloadConfigPath(repo), 'utf8'))
    expect(doc.imports).toEqual([{ path: local }])
    // GNU-safe copy of the template's env rewrite (sandbox builds run sync-env).
    expect(doc.functions.prepare_local_env).toBe(
      'file="$1"\nsed -i.devdock-bak -r "s~a~b~" $file\nrm -f "$1.devdock-bak"',
    )
    // non-ui has no image tuning yet, so there is no profile to activate.
    expect(doc.profiles).toBeUndefined()
    expect(devspaceCommand(repo, 'dev')).not.toContain('-p devdock')
    expect(devspaceCommand(repo, 'dev')).toContain('DEVSPACE_CONFIG=')
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
      '--cache-from=type=registry,ref=${AWS_ECR_DEVSPACE_REPO}:ns-web',
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

describe('overlay speedups', () => {
  const template = `version: v2beta1
pullSecrets:
  ecr-secret:
    registry: r
deployments:
  default:
    helm:
      chart:
        git: git+ssh://git@github.com/vmockinc/helm-charts
  web:
    helm:
      chart:
        git: git+ssh://git@github.com/vmockinc/helm-charts
`
  function uiRepo(extra = ''): Repo {
    const repo = fixture()
    writeFileSync(
      repo.configPath,
      `version: v2beta1\nname: web\nimports:\n  - git: git@github.com:vmockinc/guidelines.git\n    branch: master\n    subPath: ./devspace/ui\n${extra}`,
    )
    const local = join(deps, 'git-github-com-vmockinc-guidelines-git-master', 'devspace', 'ui')
    mkdirSync(local, { recursive: true })
    writeFileSync(join(local, 'devspace.yaml'), template)
    const charts = join(deps, 'gitssh-git-github-com-vmockinc-helm-charts-master', 'service')
    mkdirSync(charts, { recursive: true })
    writeFileSync(join(charts, 'Chart.yaml'), 'name: service\n')
    return repo
  }
  const profile = (repo: Repo, name: string) =>
    parseYaml(readFileSync(workloadConfigPath(repo), 'utf8')).profiles.find(
      (p: { name: string }) => p.name === name,
    )

  it('uses the local chart for template deployments the repo does not redefine', () => {
    const repo = uiRepo('deployments:\n  web:\n    helm:\n      chart:\n        name: ./own\n')
    prepareWorkloadConfig(repo)
    const paths = profile(repo, 'devdock').patches.map((p: { path: string }) => p.path)
    expect(paths).toContain('deployments.default.helm.chart')
    expect(paths).not.toContain('deployments.web.helm.chart')
  })
  it('lets the UI shell open before the initial sync finishes', () => {
    const repo = uiRepo(
      'dev:\n  common:\n    sync:\n      - path: ./:/app\n      - path: ../x:/x\n',
    )
    prepareWorkloadConfig(repo)
    expect(profile(repo, 'devdock').patches).toEqual(
      expect.arrayContaining([
        { op: 'add', path: 'dev.common.sync[0].waitInitialSync', value: false },
        { op: 'add', path: 'dev.common.sync[1].waitInitialSync', value: false },
      ]),
    )
  })
  it('reuses the pull secret for dev and purge only after a recent deploy', () => {
    const repo = { ...uiRepo(), namespace: 'team' }
    prepareWorkloadConfig(repo)
    expect(profile(repo, 'devdock-cached-pull-secret').patches).toEqual([
      { op: 'replace', path: 'pullSecrets', value: {} },
    ])
    expect(devspaceCommand(repo, 'dev')).not.toContain('devdock-cached-pull-secret')
    markPullSecretRefreshed(repo)
    expect(devspaceCommand(repo, 'dev')).toContain('-p devdock-cached-pull-secret')
    expect(devspaceCommand(repo, 'purge')).toContain('-p devdock-cached-pull-secret')
    expect(devspaceCommand(repo, 'deploy')).not.toContain('devdock-cached-pull-secret')
    expect(devspaceCommand({ ...repo, namespace: 'other' }, 'dev')).not.toContain(
      'devdock-cached-pull-secret',
    )
  })
})
