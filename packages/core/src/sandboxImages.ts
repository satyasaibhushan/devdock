import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, readFileSync } from 'node:fs'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { cleanLine } from './logTailer.js'

export interface SandboxImage {
  image: string
  context?: string
  dockerfile?: string
  tags?: string[]
  buildArgs?: Record<string, string>
  target?: string
  buildKit?: { args?: string[]; [key: string]: unknown }
  [key: string]: unknown
}

const excluded = (name: string) =>
  name === '.git' || name === '.devspace' || /^\.devdock-.*\.yaml$/.test(name)

/** Hash a superset of Docker's context, including ignored/generated files. Extra
 * misses are safe; implementing a second, subtly different dockerignore isn't.
 * The only omitted files are explicitly excluded from Docker's context too. */
export async function sandboxImageKey(
  image: SandboxImage,
  cwd: string,
  architecture?: string,
): Promise<string> {
  // These can read files or credentials outside the hashed context. Fail closed
  // until their inputs can be fingerprinted, rather than reuse an unrelated image.
  if (
    image.custom !== undefined ||
    (image.buildKit?.args ?? []).some((arg) =>
      /^--(?:secret|ssh|build-context|build-arg)(?:=|$)/.test(arg),
    )
  )
    throw new Error('Unsupported external sandbox build inputs')
  if (Object.values(image.buildArgs ?? {}).some((value) => typeof value !== 'string'))
    throw new Error('Sandbox build args must have explicit values')
  const context = resolve(cwd, image.context ?? '.')
  const dockerfile = resolve(cwd, image.dockerfile ?? 'Dockerfile')
  validateSandboxDockerfile(await readFile(dockerfile, 'utf8'))
  const ignore = `${dockerfile}.dockerignore`
  for (const path of [join(context, '.dockerignore'), ...(existsSync(ignore) ? [ignore] : [])]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new Error('Sandbox ignore file must be local to the checkout')
    const rule = '\n**/.git\n**/.devspace\n**/.devdock-*.yaml\n'
    if (!existsSync(path) || !readFileSync(path, 'utf8').endsWith(rule)) appendFileSync(path, rule)
  }
  const ignoreContent = readFileSync(
    existsSync(ignore) ? ignore : join(context, '.dockerignore'),
    'utf8',
  )
  const omitEnv = excludesRootEnv(ignoreContent)
  const hash = createHash('sha256')
  const add = (value: unknown) => hash.update(JSON.stringify(value)).update('\0')
  const { tags, buildKit, context: _context, dockerfile: _dockerfile, ...settings } = image
  add(stable({ ...settings, dockerfile: relative(context, dockerfile), buildKit, architecture }))
  // Docker always reads the Dockerfile, even when .dockerignore excludes it.
  add(await readFile(dockerfile))
  async function walk(path: string): Promise<void> {
    const stat = await lstat(path)
    add([relative(context, path), stat.mode & 0o777])
    if (stat.isSymbolicLink()) {
      add(['link', await readlink(path)])
      return
    }
    if (stat.isDirectory()) {
      add('directory')
      for (const name of (await readdir(path)).sort())
        if (!excluded(name) && !(path === context && name === '.env' && omitEnv))
          await walk(join(path, name))
      return
    }
    if (!stat.isFile()) throw new Error(`Unsupported sandbox context entry: ${basename(path)}`)
    add('file')
    add(
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    )
  }
  await walk(context)
  return `sb-${hash.digest('hex')}`
}

/** Recognize only an exact root .env exclusion with no possible later override.
 * All other ignore patterns stay in the hashed superset. Backend env is injected
 * by Helm, so excluding it here permits reuse across namespace slots. */
function excludesRootEnv(ignore: string): boolean {
  let excluded = false
  for (const raw of ignore.split(/\r?\n/)) {
    const rule = raw.trim().replace(/^\//, '').replace(/\/$/, '')
    if (rule === '.env') excluded = true
    if (!rule.startsWith('!')) continue
    const include = rule.slice(1)
    if (
      include.includes('.env') ||
      include === '.' ||
      include === '' ||
      include.split('/').includes('..') ||
      /[*?\[\]\\]/.test(include)
    )
      excluded = false
  }
  return excluded
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    )
  return value
}

export function sandboxCacheTag(repo: string, workload: string): string {
  return `sb-cache-${createHash('sha256').update(`${repo}:${workload}`).digest('hex').slice(0, 24)}`
}

export function sandboxRestart(
  awake: boolean,
  previous: string | undefined,
  image: string,
): boolean {
  // A changed image rolls through Helm. An unchanged image still needs a restart
  // to pick up env/config changes that do not change the pod template.
  return awake && previous === image
}

/** Only successful builds are shared, and only while their callers are active. */
export class SandboxImageBuilds {
  private builds = new Map<string, Promise<void>>()
  async deploy(
    key: string,
    exists: () => Promise<boolean>,
    deploy: (skip: boolean) => Promise<void>,
  ): Promise<void> {
    const prior = this.builds.get(key)
    if (prior) {
      await prior
      await deploy(true)
      return
    }
    const task = Promise.resolve().then(async () => deploy(await exists()))
    this.builds.set(key, task)
    try {
      await task
    } finally {
      if (this.builds.get(key) === task) this.builds.delete(key)
    }
  }
}

export async function parallelMembers<T>(
  members: T[],
  work: (member: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const errors: unknown[] = []
  await Promise.all(
    Array.from({ length: Math.min(2, members.length) }, async () => {
      while (next < members.length) {
        const member = members[next++] as T
        try {
          await work(member)
        } catch (error) {
          errors.push(error)
        }
      }
    }),
  )
  if (errors.length)
    throw new AggregateError(
      errors,
      errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; '),
    )
}

/** ECR reads run inside DevSpace so AWS vars and profile selection match its login pipeline. */
export const sandboxImagePipeline = `
profileArg=
profiles=$(aws configure list-profiles) || exit 1
if [ "$(printf '%s\\n' "$profiles" | grep -c "\${AWS_DEVSPACE_PROFILE_NAME}")" -eq 1 ]; then
  profileArg=" --profile \${AWS_DEVSPACE_PROFILE_NAME}"
fi
code=0
result=$(aws ecr describe-images --region "\${AWS_REGION}" $profileArg --registry-id "\${SANDBOX_REGISTRY}" --repository-name "\${SANDBOX_REPOSITORY}" --image-ids "imageTag=\${SANDBOX_TAG}" --query 'imageDetails[0].imageDigest' --output text --no-cli-pager 2>&1) || code=$?
if [ "$code" -eq 0 ]; then
  echo "SANDBOX_IMAGE=$result"
elif printf '%s' "$result" | grep -q '(ImageNotFoundException)'; then
  echo SANDBOX_IMAGE=missing
else
  echo "Sandbox ECR lookup failed for \${SANDBOX_REPOSITORY}:\${SANDBOX_TAG}" >&2
  exit "$code"
fi
`

export function ecrQuery(image: string, tag: string): Record<string, string> {
  const match = /^(\d+)\.dkr\.ecr\.([\w-]+)\.amazonaws\.com\/(.+)$/.exec(image)
  if (!match) throw new Error('Sandbox images must use ECR')
  return {
    SANDBOX_REGISTRY: match[1] as string,
    AWS_REGION: match[2] as string,
    SANDBOX_REPOSITORY: match[3] as string,
    SANDBOX_TAG: tag,
  }
}

export function imageDigest(output: string): string | undefined {
  const result = /\bSANDBOX_IMAGE=(missing|sha256:[a-f0-9]{64})\s*$/m.exec(
    output.split('\n').map(cleanLine).join('\n'),
  )?.[1]
  if (!result) throw new Error('Invalid sandbox ECR response')
  return result === 'missing' ? undefined : result
}

/** DevSpace may prefix pipeline output with log levels and ANSI sequences. */
export function sandboxArchitecture(output: string): string {
  const architecture = /\bSANDBOX_ARCH=([a-z0-9]+\/[a-z0-9_]+)\s*$/m.exec(
    output.split('\n').map(cleanLine).join('\n'),
  )?.[1]
  if (!architecture) throw new Error('Cannot determine sandbox Docker builder architecture')
  return architecture
}

/** Resolve FROM args and pin mutable base tags before hashing/building. */
export async function pinSandboxBases(
  dockerfile: string,
  args: Record<string, string>,
  digest: (image: string, tag: string) => Promise<string | undefined>,
): Promise<string> {
  validateSandboxDockerfile(dockerfile)
  const vars: Record<string, string> = {}
  const stages = new Set<string>()
  const lines = dockerfile.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const arg = /^\s*ARG\s+(\w+)(?:=(.*))?\s*$/i.exec(line)
    if (arg) vars[arg[1] as string] = args[arg[1] as string] ?? arg[2] ?? ''
    const from = /^(\s*FROM\s+)(\S+)(.*)$/i.exec(line)
    if (!from) continue
    const source = (from[2] as string).replace(
      /\$\{(\w+)\}|\$(\w+)/g,
      (_, a: string, b: string) => vars[a ?? b] ?? '',
    )
    if (source.startsWith('--')) throw new Error('Unsupported sandbox FROM flags')
    const stage = /^\s+AS\s+(\S+)\s*$/i.exec(from[3] as string)?.[1]
    if (!stages.has(source.toLowerCase()) && source !== 'scratch' && !source.includes('@sha256:')) {
      const colon = source.lastIndexOf(':')
      const image = colon > source.lastIndexOf('/') ? source.slice(0, colon) : source
      const tag = colon > source.lastIndexOf('/') ? source.slice(colon + 1) : 'latest'
      const found = await digest(image, tag)
      if (!found) throw new Error(`Sandbox base image not found: ${image}:${tag}`)
      lines[i] = `${from[1]}${image}@${found}${from[3]}`
    }
    if (stage) stages.add(stage.toLowerCase())
  }
  return lines.join('\n')
}

/** These sources bypass the hashed context and pinned FROM images. */
function validateSandboxDockerfile(dockerfile: string): void {
  if (/^#\s*escape\s*=\s*`/im.test(dockerfile))
    throw new Error('Unsupported sandbox Dockerfile escape directive')
  const stages = new Set<string>()
  for (const line of dockerfile.replace(/\\\r?\n/g, '').split(/\r?\n/)) {
    const instruction = /^\s*(\w+)\s+(.*)$/.exec(line)
    if (!instruction) continue
    const command = instruction[1]?.toUpperCase()
    const body = instruction[2] ?? ''
    if (command === 'COPY' || command === 'RUN') {
      const sources =
        command === 'COPY'
          ? [...body.matchAll(/--from(?:=|\s+)([^\s]+)/gi)].map((m) => m[1] ?? '')
          : [...body.matchAll(/--mount(?:=|\s+)([^\s]+)/gi)].flatMap((m) =>
              [...(m[1] ?? '').matchAll(/\bfrom=([^,]+)/gi)].map((v) => v[1] ?? ''),
            )
      for (const source of sources)
        if (!stages.has(source.toLowerCase()))
          throw new Error(`Unsupported external sandbox ${command} source: ${source}`)
    }
    if (command === 'ADD' && /(?:https?:\/\/|git:\/\/|ssh:\/\/|git@)/i.test(body))
      throw new Error('Unsupported remote sandbox ADD source')
    if (command === 'FROM') {
      const stage = /\s+AS\s+(\S+)\s*$/i.exec(body)?.[1]
      if (stage) stages.add(stage.toLowerCase())
    }
  }
}
