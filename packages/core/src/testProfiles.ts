export const PHP_TEST_PROFILES = ['php-7.1', 'php-8.1', 'php-8.5'] as const
export type PhpTestProfile = (typeof PHP_TEST_PROFILES)[number]

const TEST_MEMORY_GIB = 2
const TEST_MEMORY_BYTES = TEST_MEMORY_GIB * 1024 ** 3
export const TEST_MEMORY_LIMIT = `${TEST_MEMORY_GIB}g`
// Some BuildKit workers accept resource options without applying them. Check
// the effective cgroup memory and swap caps in each expensive RUN, including
// after a cache hit.
export function buildMemoryCheckScript(cgroupRoot = '/sys/fs/cgroup'): string {
  return [
    `cg="${cgroupRoot}";`,
    'if [ -r "$cg/memory.max" ]; then',
    '  limit=$(cat "$cg/memory.max" 2>/dev/null);',
    `  test "$limit" -gt 0 2>/dev/null && test "$limit" -le ${TEST_MEMORY_BYTES} ||`,
    `    { echo 'BuildKit must enforce a ${TEST_MEMORY_GIB} GiB build memory limit' >&2; exit 1; };`,
    '  if [ -r "$cg/memory.swap.max" ]; then',
    '    swap=$(cat "$cg/memory.swap.max" 2>/dev/null);',
    '    test "$swap" -eq 0 2>/dev/null ||',
    "      { echo 'BuildKit must enforce zero build swap' >&2; exit 1; };",
    '  fi;',
    'elif [ -r "$cg/memory/memory.limit_in_bytes" ]; then',
    '  limit=$(cat "$cg/memory/memory.limit_in_bytes" 2>/dev/null);',
    `  test "$limit" -gt 0 2>/dev/null && test "$limit" -le ${TEST_MEMORY_BYTES} ||`,
    `    { echo 'BuildKit must enforce a ${TEST_MEMORY_GIB} GiB build memory limit' >&2; exit 1; };`,
    '  if [ -r "$cg/memory/memory.memsw.limit_in_bytes" ]; then',
    '    memsw=$(cat "$cg/memory/memory.memsw.limit_in_bytes" 2>/dev/null);',
    `    test "$memsw" -gt 0 2>/dev/null && test "$memsw" -le ${TEST_MEMORY_BYTES} ||`,
    "      { echo 'BuildKit must enforce zero build swap' >&2; exit 1; };",
    '  fi;',
    'else',
    `  echo 'BuildKit must enforce a ${TEST_MEMORY_GIB} GiB build memory limit' >&2; exit 1;`,
    'fi;',
  ].join(' ')
}
const BUILD_MEMORY_CHECK = buildMemoryCheckScript()

const INSTALL = 'composer install --no-interaction --no-progress --prefer-dist'
const DOWNLOAD = '--no-plugins --no-scripts'
const PREPARE_TOOLS =
  'composer --working-dir=/opt/devtools require --no-interaction --no-progress --no-plugins --no-scripts phpunit/phpunit:6.5.14 mockery/mockery:0.9.11'

export function resolveTestProfile(
  declared: string | undefined,
  repo: string,
  composerPhp: string | undefined,
): PhpTestProfile {
  if (declared !== undefined) {
    const match = PHP_TEST_PROFILES.find((profile) => profile === declared)
    if (!match) throw new Error(`Unknown PHP test profile: ${declared}`)
    return match
  }
  const version = /^(?:[~^]|>=?\s*)?(7\.1|8\.1|8\.5)(?:\.\d+|\.\*)?$/.exec(
    typeof composerPhp === 'string' ? composerPhp.trim() : '',
  )?.[1]
  const inferred = PHP_TEST_PROFILES.find((profile) => profile === `php-${version}`)
  if (inferred) return inferred
  // These projects use broad Composer constraints on some refs.
  if (repo === 'cmc-student-view') return 'php-7.1'
  if (repo === 'acs-jobs-management') return 'php-8.1'
  throw new Error(`Choose a PHP test profile: ${PHP_TEST_PROFILES.join(', ')}`)
}

export function testCommand(profile: PhpTestProfile): string {
  return profile === 'php-7.1'
    ? 'php -d auto_prepend_file=/opt/devtools/bootstrap.php /opt/devtools/vendor/bin/phpunit'
    : 'php vendor/bin/phpunit'
}

/** The test source is a subdirectory of this build context. Its Dockerfile
 * and .dockerignore cannot replace the generated runner or its inputs. */
export function testDockerfile(profile: PhpTestProfile): string {
  const legacy = profile === 'php-7.1'
  const image = legacy ? 'php:7.1.33-cli-stretch' : `php:${profile.slice(4)}-cli-bookworm`
  const apt = legacy
    ? 'printf "%s\\n" "deb http://archive.debian.org/debian stretch main" > /etc/apt/sources.list && '
    : ''
  const install = legacy ? `${INSTALL} --no-dev` : INSTALL
  return [
    `FROM composer:${legacy ? '2.2' : '2'} AS composer`,
    `FROM ${image}`,
    'COPY --from=composer /usr/bin/composer /usr/local/bin/composer',
    `RUN ${BUILD_MEMORY_CHECK} \\`,
    `    ${apt}apt-get -o Acquire::Check-Valid-Until=false update \\`,
    '    && apt-get install -y --no-install-recommends git openssh-client unzip libicu-dev libzip-dev \\',
    '    && docker-php-ext-install -j2 bcmath intl pdo_mysql zip \\',
    '    && rm -rf /var/lib/apt/lists/*',
    `RUN ${BUILD_MEMORY_CHECK} curl -fsSL --retry 3 https://pecl.php.net/get/apcu-5.1.28.tgz -o /tmp/apcu.tgz && pecl install /tmp/apcu.tgz && docker-php-ext-enable apcu && rm /tmp/apcu.tgz`,
    'RUN printf "%s\\n" "memory_limit=512M" "apc.enable_cli=1" > "$PHP_INI_DIR/conf.d/99-devdock-test.ini"',
    'ENV COMPOSER_MEMORY_LIMIT=1G COMPOSER_MAX_PARALLEL_HTTP=4 COMPOSER_MAX_PARALLEL_PROCESSES=4',
    'ENV COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_HOME=/tmp/devdock-composer',
    'ENV GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=yes"',
    ...(legacy
      ? [
          `RUN ${BUILD_MEMORY_CHECK} mkdir -p /opt/devtools && ${PREPARE_TOOLS}`,
          'COPY bootstrap.php /opt/devtools/bootstrap.php',
        ]
      : []),
    'WORKDIR /workspace',
    'COPY source/ /workspace/',
    'RUN --mount=type=ssh --mount=type=secret,id=known_hosts,target=/etc/ssh/ssh_known_hosts \\',
    `    ${BUILD_MEMORY_CHECK} test -f composer.lock && ${install} ${DOWNLOAD} && rm -rf "$COMPOSER_HOME"`,
    'RUN chown -R www-data:www-data /workspace',
    'USER www-data',
    'ENV APP_ENV=testing COMPOSER_DISABLE_NETWORK=1',
    // Run the repository's install callbacks offline, with no credential mount.
    `RUN --network=none ${BUILD_MEMORY_CHECK} ${install}${legacy ? ' && composer dump-autoload --dev --no-plugins --no-scripts' : ''}`,
    'ENTRYPOINT []',
    '',
  ].join('\n')
}

export const LEGACY_TEST_BOOTSTRAP = `<?php
require_once '/workspace/vendor/autoload.php';
require_once '/opt/devtools/vendor/autoload.php';
`
