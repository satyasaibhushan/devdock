import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { parse } from 'yaml'
import type { RunOptions, RunResult } from './exec.js'
import type { Repo } from './types.js'

type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>

/** Compare the reused tag against the branch's tracked Dockerfile and its external FROM images. */
export async function replicaImageWarnings(repo: Repo, printed: string, run: Runner) {
  const start = printed.search(/^version:/m)
  const config = parse(start > 0 ? printed.slice(start) : printed) as {
    vars?: Record<string, string | { value?: string; default?: string }>
    images?: Record<
      string,
      {
        image?: string
        tags?: string[]
        dockerfile?: string
        buildArgs?: Record<string, string>
      }
    >
  } | null
  const checkout = repo.root ?? repo.path
  const results = await Promise.all(
    Object.values(config?.images ?? {})
      .map(async (image) => {
        const tag = image.tags?.[0]
        if (typeof image.image !== 'string' || typeof tag !== 'string') return
        const reference = `${image.image}:${tag}`
        const dockerfile = resolve(repo.path, image.dockerfile ?? 'Dockerfile')
        const path = relative(checkout, dockerfile)
        if (path === '..' || path.startsWith('../') || isAbsolute(path)) return
        const dockerfileText = readFileSync(dockerfile, 'utf8')
        const variable = config?.vars?.AWS_DEVSPACE_PROFILE_NAME
        const profile =
          typeof variable === 'string' ? variable : (variable?.value ?? variable?.default)
        const built = await imageTimestamp(reference, profile, run)
        if (built === undefined) return

        const changed = await run('git', ['log', '-1', '--format=%ct', '--', path], {
          cwd: checkout,
          timeoutMs: 3_000,
        })
        if (changed.code === 0 && Number(changed.stdout.trim()) * 1000 > built) {
          return `Parent image ${reference} predates the branch's ${path}. Set ownImage=true to rebuild it.`
        }
        const bases = dockerfileBases(dockerfileText, image.buildArgs ?? {})
        const baseTimes = await Promise.all(bases.map((base) => imageTimestamp(base, profile, run)))
        const newerBase = bases.find((_, index) => (baseTimes[index] ?? 0) > built)
        if (newerBase) {
          return `Parent image ${reference} predates base image ${newerBase}. Set ownImage=true to rebuild it.`
        }
      })
      .map((result) => result.catch(() => undefined)),
  )
  return [...new Set(results.filter((message) => message !== undefined))]
}

function dockerfileBases(dockerfile: string, buildArgs: Record<string, string>): string[] {
  const vars = new Map<string, string>()
  const stages = new Set<string>()
  const bases = new Set<string>()
  for (const line of dockerfile.replace(/\\\r?\n/g, '').split(/\r?\n/)) {
    const arg = /^\s*ARG\s+(\w+)(?:=(.*))?\s*$/i.exec(line)
    if (arg?.[1]) vars.set(arg[1], buildArgs[arg[1]] ?? arg[2] ?? '')
    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line)
    if (!from?.[1]) continue
    const reference = from[1].replace(/\${(\w+)}|\$(\w+)/g, (_, a, b) => vars.get(a ?? b) ?? '')
    if (reference && reference !== 'scratch' && !stages.has(reference.toLowerCase()))
      bases.add(reference)
    if (from[2]) stages.add(from[2].toLowerCase())
  }
  return [...bases]
}

async function imageTimestamp(reference: string, profile: unknown, run: Runner) {
  // ECR metadata is available with the profile DevSpace used for this image,
  // including when the Docker daemon has yet to log into the registry.
  const ecr =
    /^(\d+)\.dkr\.ecr\.([\w-]+)\.amazonaws\.com\/([^:@]+)(?::([^@]+))?(?:@(sha256:[a-f\d]+))?$/.exec(
      reference,
    )
  if (ecr?.[1] && ecr[2] && ecr[3]) {
    const result = await run(
      'aws',
      [
        'ecr',
        'describe-images',
        '--registry-id',
        ecr[1],
        '--region',
        ecr[2],
        '--repository-name',
        ecr[3],
        '--image-ids',
        ecr[5] ? `imageDigest=${ecr[5]}` : `imageTag=${ecr[4] ?? 'latest'}`,
        '--query',
        'imageDetails[0].imagePushedAt',
        '--output',
        'json',
        ...(typeof profile === 'string' && profile ? ['--profile', profile] : []),
      ],
      { timeoutMs: 4_000, killProcessGroup: true },
    )
    if (result.code !== 0) return
    const timestamp: unknown = JSON.parse(result.stdout)
    if (typeof timestamp === 'number') return timestamp * 1000
    if (typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)))
      return Date.parse(timestamp)
    return
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]+$/.test(reference)) return
  const result = await run(
    'docker',
    ['buildx', 'imagetools', 'inspect', '--format', '{{json .Image.Created}}', reference],
    {
      timeoutMs: 4_000,
      killProcessGroup: true,
    },
  )
  if (result.code !== 0) return
  const timestamp: unknown = JSON.parse(result.stdout)
  if (typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)))
    return Date.parse(timestamp)
}
