import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// Static contract for the YunoHost package. Nothing here installs, fetches or starts anything;
// the fetch itself is exercised by scripts/yunohost-candidate-fetcher-test.sh in CI.

const repoRoot = resolve(__dirname, '../../../../..')
const packageDir = resolve(repoRoot, 'self-host/yunohost/silentsuite_ynh')
const umbrelCompose = resolve(repoRoot, 'self-host/umbrel/silentsuite/docker-compose.yml')
const workflowPath = resolve(repoRoot, '.github/workflows/ci-yunohost-candidate.yml')
// Vendored copy of the v0.5.20-beta release asset umbrel-images.json, byte for byte.
const imagesFixture = resolve(__dirname, 'fixtures/umbrel-images-v0.5.20-beta.json')
// GitHub's digest for that release asset (SHA256SUMS.txt only lists the Bridge binaries).
const IMAGES_ASSET_SHA256 = '2aa1302ba38e02bb18f8ec796e78e1ff2ba1684c62ec302ad0780db3d8860d3b'

function readRequired(path: string): string {
  expect(existsSync(path), `missing ${relative(repoRoot, path)}`).toBe(true)
  return readFileSync(path, 'utf8')
}
const pkg = (path: string) => readRequired(join(packageDir, path))

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

// Minimal reader for the TOML subset manifest.toml uses: [section] headers (indentation
// ignored), `dotted.key = value` with string/number/boolean values and string arrays that may
// span lines. Keys come back as "section.key". Anything else throws, so the test fails loudly
// instead of misreading. No TOML library is a dependency of apps/web.
function readManifest(text: string): { values: Map<string, unknown>; sections: string[] } {
  const values = new Map<string, unknown>()
  const sections: string[] = []
  let section = ''
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const header = /^\[([A-Za-z0-9_.]+)\]$/.exec(line)
    if (header) {
      section = header[1]
      sections.push(section)
      continue
    }
    const pair = /^([A-Za-z0-9_.]+)\s*=\s*(.+)$/.exec(line)
    if (!pair) throw new Error(`manifest.toml line ${i + 1} not understood: ${line}`)
    let raw = pair[2]
    if (raw.startsWith('[') && !raw.endsWith(']')) {
      while (!raw.trimEnd().endsWith(']')) {
        i++
        if (i >= lines.length) throw new Error('unterminated array in manifest.toml')
        const next = lines[i].trim()
        if (next && !next.startsWith('#')) raw += next
      }
    }
    raw = raw.replace(/,\s*\]$/, ']')
    values.set(section ? `${section}.${pair[1]}` : pair[1], JSON.parse(raw))
  }
  return { values, sections }
}

const manifest = () => readManifest(pkg('manifest.toml'))
const get = (key: string) => {
  const { values } = manifest()
  expect(values.has(key), `manifest.toml ${key}`).toBe(true)
  return values.get(key)
}

const scriptNames = ['_common.sh', 'install', 'upgrade', 'remove', 'backup', 'restore']
const scripts = () => scriptNames.map((name) => ({ name, text: pkg(`scripts/${name}`) }))

describe('YunoHost package manifest', () => {
  it('is a packaging v2 / helpers 2.1 manifest for one amd64 instance of 0.5.20-beta', () => {
    expect(get('packaging_format')).toBe(2)
    expect(get('id')).toBe('silentsuite')
    expect(get('version')).toBe('0.5.20-beta~ynh1')
    expect(get('integration.helpers_version')).toBe('2.1')
    expect(get('integration.architectures')).toEqual(['amd64'])
    expect(get('integration.multi_instance')).toBe(false)
  })

  it('installs postgresql, skopeo and umoci from apt before the database resource', () => {
    const { sections } = manifest()
    const packages = String(get('resources.apt.packages')).split(',').map((name) => name.trim())
    for (const name of ['postgresql', 'skopeo', 'umoci']) expect(packages).toContain(name)
    const apt = sections.indexOf('resources.apt')
    const database = sections.indexOf('resources.database')
    expect(apt).toBeGreaterThanOrEqual(0)
    expect(database).toBeGreaterThan(apt)
    expect(get('resources.database.type')).toBe('postgresql')
  })

  it('never passes the YunoHost auth header to the app', () => {
    for (const permission of ['main', 'api', 'owner']) {
      expect(get(`resources.permissions.${permission}.auth_header`), permission).toBe(false)
    }
  })

  it('keeps the native API public and protected, and the owner routes admin-only and protected', () => {
    expect(get('resources.permissions.api.allowed')).toBe('visitors')
    expect(get('resources.permissions.api.protected')).toBe(true)
    expect(get('resources.permissions.owner.allowed')).toBe('admins')
    expect(get('resources.permissions.owner.protected')).toBe(true)
    const ownerUrls = [get('resources.permissions.owner.url'), ...(get('resources.permissions.owner.additional_urls') as string[])]
    expect(ownerUrls).toEqual(expect.arrayContaining(['/api/v1/owner/', '/admin/']))
  })

  it('exempts from SSO exactly the native protocol paths that Umbrel exempts from its login', () => {
    // YunoHost permission URLs are path prefixes. Umbrel's PROXY_AUTH_WHITELIST mixes exact
    // paths and `prefix/*` rules. Both are compared as prefixes: drop a trailing `*`, make sure
    // the path ends in `/`, and de-duplicate (`/api/v1/collection/` and `/api/v1/collection/*`
    // become one entry). The YunoHost side is therefore at most as broad as a prefix of each
    // Umbrel path; exact Umbrel auth paths become prefixes, which only adds sub-paths the
    // server does not route.
    const asPrefixes = (urls: string[]) =>
      [...new Set(urls.map((url) => url.trim().replace(/\*$/, '').replace(/\/*$/, '/')))].sort()
    const compose = parse(readRequired(umbrelCompose)) as { services: Record<string, any> }
    const whitelist = String(compose.services.app_proxy.environment.PROXY_AUTH_WHITELIST).split(',').filter(Boolean)
    const api = [get('resources.permissions.api.url') as string, ...(get('resources.permissions.api.additional_urls') as string[])]
    expect(asPrefixes(api)).toEqual(asPrefixes(whitelist))
    for (const url of asPrefixes(api)) {
      expect(url.startsWith('/api/v1/'), url).toBe(true)
      for (const owner of ['/api/v1/owner/', '/admin/']) expect(owner.startsWith(url), `${url} covers ${owner}`).toBe(false)
    }
  })
})

describe('YunoHost package image pins', () => {
  const fixtureBytes = () => readFileSync(imagesFixture)
  const fixture = () => JSON.parse(fixtureBytes().toString('utf8')) as Record<string, any>
  const common = () => pkg('scripts/_common.sh')
  const shellValue = (name: string) => {
    const match = new RegExp(`^${name}="([^"]+)"$`, 'm').exec(common())
    expect(match, `${name} in _common.sh`).not.toBeNull()
    return match![1]
  }

  it('vendors the release asset umbrel-images.json unchanged', () => {
    expect(createHash('sha256').update(fixtureBytes()).digest('hex')).toBe(IMAGES_ASSET_SHA256)
    expect(fixture().tag).toBe('v0.5.20-beta')
  })

  it('pins each per-arch manifest digest from the release asset', () => {
    for (const component of ['server', 'web']) {
      const entry = fixture()[component]
      expect(shellValue(`${component}_repo`)).toBe(entry.imageRepository)
      expect(shellValue(`${component}_digest_amd64`)).toBe(entry.amd64Digest)
      expect(shellValue(`${component}_digest_arm64`)).toBe(entry.arm64Digest)
      expect(entry.amd64Digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    }
  })

  it('matches the image tag and index digest the Umbrel package pins', () => {
    const compose = parse(readRequired(umbrelCompose)) as { services: Record<string, any> }
    const { tag, server, web } = fixture()
    expect(compose.services.server.image).toBe(`${server.imageRepository}:${tag}@${server.indexDigest}`)
    expect(compose.services.web.image).toBe(`${web.imageRepository}:${tag}@${web.indexDigest}`)
  })
})

describe('YunoHost package scripts, docs and config', () => {
  it('uses no shared nobody identity in any script', () => {
    for (const { name, text } of scripts()) expect(text, name).not.toMatch(/\bnobody\b|\bnogroup\b/)
  })

  it('generates and stores only the owner_password and registration_token secrets', () => {
    const all = scripts().map(({ text }) => text).join('\n')
    const generated = [...all.matchAll(/^\s*([a-z_]+)=\$\(ynh_string_random\b/gm)].map(([, name]) => name).sort()
    expect(generated).toEqual(['owner_password', 'registration_token'])
    const stored = [...all.matchAll(/ynh_app_setting_set\s+--key=([a-z_]+)/g)].map(([, name]) => name).sort()
    expect(stored).toEqual(['owner_password', 'registration_token'])
    expect(pkg('conf/server.env')).toMatch(/^ETEBASE_OWNER_PASSWORD=__OWNER_PASSWORD__$/m)
    expect(pkg('conf/server.env')).toMatch(/^ETEBASE_REGISTRATION_TOKEN=__REGISTRATION_TOKEN__$/m)
  })

  it('never renders a secret into the docs', () => {
    const docs = readdirSync(join(packageDir, 'doc')).filter((name) => name.endsWith('.md'))
    expect(docs.length).toBeGreaterThan(0)
    for (const name of docs) {
      expect(pkg(`doc/${name}`), name).not.toMatch(/__OWNER_PASSWORD__|__REGISTRATION_TOKEN__/)
    }
  })

  it('turns off nginx access and error logs in every location block', () => {
    const blocks = [...pkg('conf/nginx.conf').matchAll(/location\s+[^{]+\{([^}]*)\}/g)]
    expect(blocks.length).toBeGreaterThan(0)
    for (const [block, body] of blocks) {
      expect(body, block.split('\n')[0]).toMatch(/^\s*access_log off;$/m)
      expect(body, block.split('\n')[0]).toMatch(/^\s*error_log \/dev\/null;$/m)
    }
  })

  it('runs both units inside their image tree as the app user with a read-only system', () => {
    for (const unit of ['server', 'web']) {
      const text = pkg(`conf/${unit}.service`)
      expect(text, unit).toMatch(new RegExp(`^RootDirectory=__INSTALL_DIR__/${unit}$`, 'm'))
      expect(text, unit).toMatch(/^ProtectSystem=strict$/m)
      expect(text, unit).toMatch(/^NoNewPrivileges=yes$/m)
      expect(text, unit).toMatch(/^User=__APP__$/m)
    }
    const server = pkg('conf/server.service')
    expect(server).toMatch(/^BindPaths=__DATA_DIR__:\/data$/m)
    expect(server).toMatch(/^ExecStart=\S*uvicorn .*--no-access-log/m)
  })

  it('contains no secret-looking literal other than sha256 image digests', () => {
    // Runs of 40+ token characters (letters, digits, `+_=-`) mixing letters and digits. `/` is
    // left out so URL paths do not join into one run; the `sha256:` digests are the only
    // allowed hits.
    for (const path of filesUnder(packageDir)) {
      const text = readFileSync(path, 'utf8')
      for (const match of text.matchAll(/[A-Za-z0-9+_=-]{40,}/g)) {
        const token = match[0]
        if (!/[0-9]/.test(token) || !/[A-Za-z]/.test(token)) continue
        const digest = /^[0-9a-f]{64}$/.test(token) && text.slice(Math.max(0, match.index! - 7), match.index) === 'sha256:'
        expect(digest, `${relative(packageDir, path)}: ${token.slice(0, 12)}...`).toBe(true)
      }
    }
  })
})

// The candidate workflow is written separately; these checks run once it exists.
describe.skipIf(!existsSync(workflowPath))('YunoHost candidate CI workflow', () => {
  it('is read-only, pins its actions and runs the fetcher tests', () => {
    const text = readRequired(workflowPath)
    const workflow = parse(text) as Record<string, any>
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(text).not.toMatch(/secrets\./)
    for (const [, action, ref] of text.matchAll(/uses:\s*([^\s@]+)@(\S+)/g)) {
      expect(ref, `${action} must be pinned`).toMatch(/^[0-9a-f]{40}$/)
    }
    expect(text).toContain('scripts/yunohost-candidate-fetcher-test.sh')
  })
})
