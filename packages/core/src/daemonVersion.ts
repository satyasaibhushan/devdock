import type { RunOptions, RunResult } from './exec.js'

export interface DaemonBuild {
  sha: string
  builtAt: string
  repoPath: string
}

export interface DaemonVersion {
  sha: string
  builtAt: string
  mainSha?: string
  commitsBehind?: number
  warning?: string
}

export async function daemonVersion(
  build: DaemonBuild,
  run: (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>,
): Promise<DaemonVersion> {
  const version: DaemonVersion = { sha: build.sha, builtAt: build.builtAt }
  const git = async (...args: string[]) => {
    const result = await run('git', ['-C', build.repoPath, ...args], { timeoutMs: 2_000 }).catch(
      () => undefined,
    )
    return result?.code === 0 ? result.stdout.trim() : undefined
  }
  const mainSha =
    (await git('rev-parse', '--verify', 'refs/remotes/origin/main')) ??
    (await git('rev-parse', '--verify', 'refs/heads/main'))
  if (!mainSha) return version
  version.mainSha = mainSha
  const distance = await git('rev-list', '--count', `${build.sha}..${mainSha}`)
  if (distance === undefined || !/^\d+$/.test(distance)) return version
  const behind = Number(distance)
  version.commitsBehind = behind
  if (behind > 0) {
    version.warning = `Daemon is ${behind} commit${behind === 1 ? '' : 's'} behind main. Run the DevDock install script.`
  }
  return version
}
