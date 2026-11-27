import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

// Static contract for the StartOS package (self-host/startos) and its non-publishing CI
// candidate. Nothing here starts containers or StartOS; CI's smoke run does the former.

const repoRoot = resolve(__dirname, '../../../../..')
const pkg = resolve(repoRoot, 'self-host/startos')
const read = (path: string) => {
  const full = resolve(repoRoot, path)
  expect(existsSync(full), `missing ${path}`).toBe(true)
  return readFileSync(full, 'utf8')
}

const manifest = () => read('self-host/startos/startos/manifest/index.ts')
const main = () => read('self-host/startos/startos/main.ts')
const utils = () => read('self-host/startos/startos/utils.ts')
const smoke = () => read('scripts/startos-candidate-smoke.sh')
const workflow = () => read('.github/workflows/ci-startos-candidate.yml')

function imageRef(name: string): string {
  const match = manifest().match(new RegExp(`export const ${name} =\\s*'([^']+)'`))
  expect(match, `${name} declared`).not.toBeNull()
  return match![1]
}

function upstreamVersion(): string {
  const match = read('self-host/startos/startos/versions/current.ts').match(/version: '([^':]+):(\d+)'/)
  expect(match).not.toBeNull()
  return match![1]
}

const PINNED = /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/

describe('StartOS package manifest', () => {
  it('declares the wrapper layout Start9 requires', () => {
    for (const file of [
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'Makefile',
      'LICENSE',
      'README.md',
      'instructions.md',
      'UPDATING.md',
      'icon.svg',
      'assets/.gitkeep',
    ]) {
      expect(existsSync(resolve(pkg, file)), file).toBe(true)
    }
    expect(statSync(resolve(pkg, 'icon.svg')).size).toBeLessThanOrEqual(40 * 1024)
    expect(read('self-host/startos/LICENSE')).toBe(read('LICENSE'))
    expect(JSON.parse(read('self-host/startos/package.json')).dependencies['@start9labs/start-sdk']).toMatch(
      /^\d+\.\d+\.\d+$/,
    )
    expect(read('self-host/startos/Makefile')).toContain('ARCHES := x86 arm')
  })

  it('pins every image by tag and multi-arch index digest for x86_64 and aarch64', () => {
    for (const name of ['serverImage', 'webImage', 'postgresImage', 'routerImage']) {
      expect(imageRef(name)).toMatch(PINNED)
    }
    expect(manifest().match(/arch: \['x86_64', 'aarch64'\]/g)).toHaveLength(4)
    expect(manifest()).not.toMatch(/:latest\b/)
  })

  it('uses released SilentSuite images whose tag equals the package upstream version', () => {
    const tag = `v${upstreamVersion()}`
    expect(imageRef('serverImage')).toMatch(new RegExp(`^ghcr\\.io/silent-suite/silentsuite-server:${tag}@`))
    expect(imageRef('webImage')).toMatch(new RegExp(`^ghcr\\.io/silent-suite/silentsuite-web-selfhost:${tag}@`))
    expect(imageRef('postgresImage')).toMatch(/^postgres:16\.\d+-alpine@/)
  })

  it('names the license and keeps descriptions within the store limits', () => {
    expect(manifest()).toContain("license: 'AGPL-3.0-only'")
    const i18n = read('self-host/startos/startos/manifest/i18n.ts')
    const [shortBlock, longBlock] = i18n.split('export const long')
    for (const [, text] of shortBlock.matchAll(/[a-z]{2}_[A-Z]{2}: '([^']*)'/g)) {
      expect(text.length).toBeLessThanOrEqual(120)
    }
    for (const [, text] of longBlock.matchAll(/[a-z]{2}_[A-Z]{2}:\s*["']([^"']*)["']/g)) {
      expect(text.length).toBeLessThanOrEqual(2000)
    }
  })
})

describe('StartOS package secrets', () => {
  // secrets.ts belongs to the StartOS wrapper, whose tsconfig extends the (here uninstalled)
  // SDK, so it is exercised in a plain Node child process with built-in type stripping.
  type SecretsResult = {
    ownerLength: number
    hexLength: number
    fresh: { ownerPassword: string; registrationSigning: string; dbPassword: string }
    roundTrip: boolean
    throws: Record<string, boolean>
  }
  const result = (): SecretsResult => {
    const url = pathToFileURL(resolve(pkg, 'startos/secrets.ts')).href
    const script = `
      const s = await import(${JSON.stringify(url)})
      let counter = 0
      const random = ({ charset, len }) => {
        counter += 1
        const alphabet = charset === 'a-f,0-9' ? '0123456789abcdef'
          : 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
        return Array.from({ length: len }, (_, i) => alphabet[(i * 7 + counter) % alphabet.length]).join('')
      }
      const throws = (value) => { try { s.validateSecrets(value); return false } catch { return true } }
      const fresh = s.newSecrets(random)
      const cases = { undefined: throws(undefined), empty: throws({}), upperHex: throws({ ...fresh, dbPassword: fresh.dbPassword.toUpperCase() }) }
      for (const key of ['ownerPassword', 'registrationSigning', 'dbPassword']) {
        const partial = { ...fresh }; delete partial[key]
        cases['missing-' + key] = throws(partial)
        cases['short-' + key] = throws({ ...fresh, [key]: 'short' })
      }
      const roundTrip = JSON.stringify(s.validateSecrets({ ...fresh })) === JSON.stringify(fresh)
      process.stdout.write(JSON.stringify({ ownerLength: s.OWNER_PASSWORD_LENGTH, hexLength: s.HEX_SECRET_LENGTH, fresh, roundTrip, throws: cases }))
    `
    const out = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
      { encoding: 'utf8' },
    )
    return JSON.parse(out) as SecretsResult
  }

  it('generates three independent secrets of the required shapes', () => {
    const { ownerLength, hexLength, fresh } = result()
    expect(fresh.ownerPassword).toMatch(new RegExp(`^[A-Za-z0-9]{${ownerLength}}$`))
    expect(fresh.registrationSigning).toMatch(new RegExp(`^[0-9a-f]{${hexLength}}$`))
    expect(fresh.dbPassword).toMatch(new RegExp(`^[0-9a-f]{${hexLength}}$`))
    // The server requires an owner password of 32-256 characters distinct from the signing material.
    expect(ownerLength).toBeGreaterThanOrEqual(32)
    expect(hexLength).toBeGreaterThanOrEqual(32)
    expect(fresh.ownerPassword).not.toBe(fresh.registrationSigning)
  })

  it('returns restored or existing secrets unchanged', () => {
    expect(result().roundTrip).toBe(true)
  })

  it('fails closed on missing, partial or malformed stored secrets', () => {
    const { throws } = result()
    expect(Object.keys(throws)).toHaveLength(9)
    for (const [name, threw] of Object.entries(throws)) expect(threw, name).toBe(true)
  })

  it('generates secrets only on a fresh install and validates them on every other init', () => {
    const init = read('self-host/startos/startos/init/initializeService.ts')
    const install = init.slice(init.indexOf("if (kind === 'install')"), init.indexOf('return\n'))
    expect(install).toContain('await storeJson.write(effects, newSecrets(utils.getDefaultString))')
    expect(init.match(/newSecrets\(/g)).toHaveLength(1)
    expect(init).toContain('validateSecrets(await storeJson.read().once())')
  })

  it('makes the secret store owner-only on every init', () => {
    const init = read('self-host/startos/startos/init/initializeService.ts')
    expect(init).toContain('await chmod(sdk.volumes.startos.path, 0o700)')
    expect(init).toContain("await chmod(sdk.volumes.startos.subpath('store.json'), 0o600)")
    expect(init.match(/await makeStorePrivate\(\)/g)).toHaveLength(2)
  })

  it('keeps the secret store out of every subcontainer', () => {
    expect(main()).not.toMatch(/volumeId: 'startos'/)
    expect(utils()).not.toMatch(/volumeId: 'startos'/)
  })

  it('shows only the owner password, masked, in the action', () => {
    const action = read('self-host/startos/startos/actions/showInstallationPassword.ts')
    expect(action).toContain('const { ownerPassword } = await secretsFromStoreOnce()')
    expect(action).toContain('masked: true')
    expect(action).not.toMatch(/registrationSigning|dbPassword/)
  })
})

describe('StartOS package runtime wiring', () => {
  it('enforces password-checked TCP in PostgreSQL for new and restored clusters', () => {
    expect(utils()).toMatch(
      /postgresInitdbArgs = \[\s*'--auth-host=scram-sha-256',\s*'--auth-local=trust',?\s*\]/,
    )
    expect(main()).toContain("POSTGRES_INITDB_ARGS: postgresInitdbArgs.join(' ')")
    expect(main()).toContain("sdk.useEntrypoint(['-c', 'listen_addresses=127.0.0.1'])")
    expect(read('self-host/startos/startos/backups.ts')).toContain('initdbArgs: postgresInitdbArgs')
    expect(smoke()).toContain('INITDB_ARGS="--auth-host=scram-sha-256 --auth-local=trust"')
  })

  it('backs up the database as a dump plus the server data and the secret store, not the config', () => {
    const backups = read('self-host/startos/startos/backups.ts')
    expect(backups).toContain('sdk.Backups.withPgDump(')
    expect(backups).toContain(".addVolume('server')")
    expect(backups).toContain(".addVolume('startos')")
    expect(backups).not.toContain(".addVolume('config')")
  })

  it('gives the server writable data, a read-only config and read-only bootstrap scripts', () => {
    const source = main()
    const serverSub = source.slice(source.indexOf('const serverSub'), source.indexOf('const webSub'))
    expect(serverSub).toMatch(/volumeId: 'server',\s*subpath: null,\s*mountpoint: '\/data',\s*readonly: false/)
    expect(serverSub).toMatch(/volumeId: 'config',\s*subpath: null,\s*mountpoint: '\/etc\/etebase-server',\s*readonly: true/)
    expect(serverSub).toMatch(/mountAssets\(\{\s*subpath: 'bootstrap',\s*mountpoint: '\/bootstrap'/)
    expect(smoke()).toContain('-v "$server_data:/data" -v "$work/config:/etc/etebase-server:ro"')
  })

  it('passes the same server environment in the package and the CI smoke run', () => {
    const names = [
      'ETEBASE_EASY_CONFIG_PATH',
      'ETEBASE_OWNER_PASSWORD',
      'ETEBASE_REGISTRATION_TOKEN',
      'ETEBASE_DISABLE_DJANGO_ADMIN',
      'CORS_ALLOWED_ORIGINS',
      'ETEBASE_SECURE_SSL_REDIRECT',
      'TRUSTED_PROXY_IPS',
    ]
    const block = main().slice(main().indexOf("addDaemon('server'"), main().indexOf("addDaemon('web'"))
    const packageNames = [...block.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1])
    expect(packageNames).toEqual(names)
    for (const name of names) expect(smoke()).toContain(`-e ${name}=`)
    expect(block).toContain("ETEBASE_DISABLE_DJANGO_ADMIN: 'true'")
    expect(block).toContain("TRUSTED_PROXY_IPS: '127.0.0.1'")
  })

  it('reuses the Umbrel bootstrap scripts with only the loopback database host changed', () => {
    const umbrel = 'self-host/umbrel/silentsuite/data/bootstrap'
    expect(read('self-host/startos/assets/bootstrap/server-start.sh')).toBe(read(`${umbrel}/server-start.sh`))
    expect(read('self-host/startos/assets/bootstrap/init.sh')).toBe(
      read(`${umbrel}/init.sh`).replace('host = silentsuite_postgres_1', 'host = 127.0.0.1'),
    )
  })

  it('refuses the plaintext leg in the router and never exposes the Django admin', () => {
    const conf = read('self-host/startos/assets/router/default.conf')
    expect(conf).toMatch(/map \$http_x_forwarded_proto \$silentsuite_tls_leg \{\s*default 0;\s*https\s+1;\s*\}/)
    expect(conf).toContain('return 308 https://$host$request_uri;')
    expect(conf).toMatch(/if \(\$silentsuite_plain_action = refuse\) \{\s*return 403;/)
    expect(conf).toMatch(/location \/admin\/ \{\s*return 404;/)
    expect(conf).toContain('proxy_pass http://127.0.0.1:3735;')
    expect(conf).toContain('proxy_pass http://127.0.0.1:3000;')
    expect(conf).toContain('access_log off;')
    expect(conf).toContain('error_log /dev/null;')
  })

  it('treats only HTTP 200 as ready, never any response', () => {
    expect(main()).not.toContain('checkWebUrl')
    expect(utils()).toContain('return response.status === 200')
  })
})

describe('StartOS candidate CI workflow', () => {
  it('builds from the exact pull-request head without publishing or secrets', () => {
    const text = workflow()
    expect(text).toMatch(/^permissions:\n {2}contents: read$/m)
    expect(text).toContain('ref: ${{ github.event.pull_request.head.sha }}')
    expect(text).toContain('test "$(git rev-parse HEAD)" = "$HEAD_SHA"')
    expect(text).not.toMatch(/secrets\./)
    expect(text).not.toMatch(/s9pk publish|docker push|curl[^\n]*\| *(ba)?sh/)
    for (const [, ref] of text.matchAll(/uses: ([^\s]+)/g)) {
      expect(ref, ref).toMatch(/@[0-9a-f]{40}$/)
    }
  })

  it('pins start-cli by version and checksum and checks the packed manifests', () => {
    const text = workflow()
    expect(text).toMatch(/START_CLI_VERSION: "\d+\.\d+\.\d+"/)
    expect(text).toContain('releases/download/start-cli/v${START_CLI_VERSION}/start-cli_${ARCH}-linux')
    expect(text).toMatch(/sha256sum -c/)
    expect(text).toContain('git diff --exit-code')
    expect(text).toContain('s9pk inspect')
    expect(text).toContain('scripts/startos-candidate-smoke.sh')
  })
})
