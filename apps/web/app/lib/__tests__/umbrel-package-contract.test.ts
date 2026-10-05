import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// Static contract for the development Umbrel package and its non-publishing CI candidate.
// Nothing here starts containers; it checks the declared manifest, Compose, exports and workflow.

const repoRoot = resolve(__dirname, '../../../../..')
const packageDir = resolve(repoRoot, 'self-host/umbrel/silentsuite')
const workflowPath = resolve(repoRoot, '.github/workflows/ci-umbrel-candidate.yml')

const POSTGRES_DIGEST = '7c688148e5e156d0e86df7ba8ae5a05a2386aaec1e2ad8e6d11bdf10504b1fb7'
const NGINX_UNPRIVILEGED_DIGEST = '15c994d10d6d78658721c3bcafff14cb281fba2a4bdf9d5ba92c416a472516e3'
const PINNED_ACTIONS: Record<string, string> = {
  'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
  'docker/setup-buildx-action': 'bb05f3f5519dd87d3ba754cc423b652a5edd6d2c',
  'docker/build-push-action': '53b7df96c91f9c12dcc8a07bcb9ccacbed38856a',
  'actions/upload-artifact': '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
}

function readRequired(path: string): string {
  expect(existsSync(path), `missing ${path.slice(repoRoot.length + 1)}`).toBe(true)
  return readFileSync(path, 'utf8')
}

type Service = Record<string, any>
const manifest = () => parse(readRequired(join(packageDir, 'umbrel-app.yml'))) as Record<string, any>
const compose = () => parse(readRequired(join(packageDir, 'docker-compose.yml'))) as { services: Record<string, Service>; volumes?: unknown }
const exportsScript = () => readRequired(join(packageDir, 'exports.sh'))

function env(service: Service | undefined): Record<string, string> {
  const raw = service?.environment ?? {}
  if (Array.isArray(raw)) {
    return Object.fromEntries(raw.map((entry: string) => {
      const index = entry.indexOf('=')
      return index === -1 ? [entry, ''] : [entry.slice(0, index), entry.slice(index + 1)]
    }))
  }
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value == null ? '' : String(value)]))
}

function packageTexts(dir = packageDir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? packageTexts(path) : [readFileSync(path, 'utf8')]
  })
}

// Copy of the umbrelOS 2.0.0 installed app-gateway path matcher (read-only snapshot semantics).
function normalisePath(value: string) {
  let path = value || '/'
  path = path.split('?')[0] || '/'
  if (!path.startsWith('/')) path = `/${path}`
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path
}
function pathMatches(pathname: string, rules: string[]) {
  const requestPath = normalisePath(pathname)
  return rules.some((rule) => {
    const path = normalisePath(rule.trim())
    if (!rule.trim()) return false
    if (rule.trim() === '*') return true
    if (path === '/') return requestPath === '/'
    if (path.endsWith('/*')) {
      const basePath = normalisePath(path.slice(0, -2))
      return basePath === '/' || requestPath.startsWith(`${basePath}/`)
    }
    if (path.endsWith('*')) {
      const basePath = normalisePath(path.slice(0, -1))
      return basePath === '/' || requestPath.startsWith(basePath)
    }
    return requestPath === path
  })
}
const rules = (value: string | undefined) => (value ?? '').split(',').map((rule) => rule.trim()).filter(Boolean)

const RUNTIME_SERVICES = ['postgres', 'router', 'server', 'web']

describe('Umbrel development package', () => {
  it('declares an HTTPS umbrelOS 2.0 manifest with the displayed owner password and honest first-run copy', () => {
    const app = manifest()
    expect(app.id).toBe('silentsuite')
    expect(Number(app.manifestVersion)).toBeGreaterThanOrEqual(2)
    expect(app.requiresHttps).toBe(true)
    expect(app.deterministicPassword).toBe(true)
    expect(app.storage?.dataRoot).toBe('data')
    expect(app.gallery).toEqual([])
    expect(Number.isInteger(app.port) && app.port >= 1024 && app.port <= 65535).toBe(true)
    expect(app.path === '' || (typeof app.path === 'string' && app.path.startsWith('/'))).toBe(true)
    const copy = Object.values(app).filter((value) => typeof value === 'string').join('\n')
    expect(copy).toMatch(/encrypt/i)
    expect(copy).toMatch(/password/i)
    expect(copy).not.toMatch(/\bssh\b|docker logs|\.env\b|bootstrap|token/i)
  })

  it('routes app_proxy to the router with Umbrel auth kept on', () => {
    const proxy = compose().services.app_proxy
    expect(proxy, 'app_proxy service').toBeDefined()
    expect(Object.keys(proxy)).toEqual(['environment'])
    const proxyEnv = env(proxy)
    expect(proxyEnv.APP_HOST).toBe('silentsuite_router_1')
    expect(proxyEnv.APP_PORT).toBe('8080')
    expect(proxyEnv.PROXY_AUTH_ADD?.toLowerCase()).not.toBe('false')
    for (const rule of rules(proxyEnv.PROXY_AUTH_WHITELIST)) {
      expect(['*', '/*', '/api/*', '/api/v1/*', '/api*', '/api/v1*']).not.toContain(rule)
    }
  })

  it('exempts only native Etebase protocol paths from Umbrel auth and never owner routes', () => {
    const proxyEnv = env(compose().services.app_proxy)
    const whitelist = rules(proxyEnv.PROXY_AUTH_WHITELIST)
    const blacklist = rules(proxyEnv.PROXY_AUTH_BLACKLIST)
    const exempt = (path: string) => pathMatches(path, whitelist) && !pathMatches(path, blacklist)

    for (const path of [
      '/api/v1/authentication/is_etebase/',
      '/api/v1/authentication/login_challenge/',
      '/api/v1/authentication/login/',
      '/api/v1/collection/',
      '/api/v1/collection/list_multi/',
      '/api/v1/collection/synthetic-uid/item/',
      '/api/v1/invitation/incoming/',
      '/api/v1/invitation/outgoing/',
      '/api/v1/ws/synthetic-ticket/',
    ]) {
      expect(exempt(path), `${path} must reach the server without Umbrel login`).toBe(true)
    }
    for (const path of ['/', '/signup', '/login', '/api/v1/owner/', '/api/v1/owner/login/', '/admin/', '/api/v1/billing/link-proof/']) {
      expect(exempt(path), `${path} must stay behind Umbrel login`).toBe(false)
    }
    expect(pathMatches('/api/v1/owner/login/', blacklist)).toBe(true)
  })

  it('runs web, server, PostgreSQL and router (plus an optional one-shot init) without host access', () => {
    const { services, volumes } = compose()
    const names = Object.keys(services).filter((name) => name !== 'app_proxy').sort()
    const extras = names.filter((name) => !RUNTIME_SERVICES.includes(name))
    expect(RUNTIME_SERVICES.every((name) => names.includes(name)), `services: ${names.join(', ')}`).toBe(true)
    expect(extras.every((name) => /init/.test(name)), `unexpected services: ${extras.join(', ')}`).toBe(true)
    expect(volumes).toBeUndefined()

    for (const name of names) {
      const service = services[name]
      for (const key of ['ports', 'build', 'privileged', 'cap_add', 'devices', 'pid', 'ipc', 'userns_mode']) {
        expect(service[key], `${name}.${key}`).toBeUndefined()
      }
      expect([undefined, 'none'], `${name}.network_mode`).toContain(service.network_mode)
      for (const mount of (service.volumes ?? []) as unknown[]) {
        expect(typeof mount, `${name} volume must be a bind string`).toBe('string')
        const host = String(mount).split(':')[0]
        expect(host.startsWith('${APP_DATA_DIR}/data/'), `${name} mount ${host}`).toBe(true)
        expect(host).not.toMatch(/docker\.sock/)
      }
    }
    for (const name of extras) {
      expect(services[name].network_mode, `${name} must have no network`).toBe('none')
      expect(['no', undefined], `${name} must be one-shot`).toContain(services[name].restart)
    }
  })

  it('pins third-party images and uses truthful development placeholders for SilentSuite images', () => {
    const { services } = compose()
    expect(services.postgres.image).toMatch(new RegExp(`@sha256:${POSTGRES_DIGEST}$`))
    expect(services.router.image).toMatch(new RegExp(`nginx-unprivileged.*@sha256:${NGINX_UNPRIVILEGED_DIGEST}$`))
    for (const name of ['web', 'server']) {
      const image = String(services[name].image)
      expect(image).not.toMatch(/:latest\b/)
      const pinned = /@sha256:[0-9a-f]{64}$/.test(image)
      const placeholder = /\$\{[A-Z0-9_]+\}|\{\{[^}]+\}\}/.test(image)
      expect(pinned || placeholder, `${name} image ${image}`).toBe(true)
    }
  })

  it('wires independent owner, signing and database secrets without widening trust', () => {
    const { services } = compose()
    const server = env(services.server)
    expect(server.ETEBASE_OWNER_PASSWORD).toBe('${APP_PASSWORD}')
    const signing = server.ETEBASE_REGISTRATION_TOKEN ?? ''
    const database = env(services.postgres).POSTGRES_PASSWORD ?? ''
    expect(signing).toMatch(/^\$\{APP_[A-Z0-9_]+\}$/)
    expect(database).toMatch(/^\$\{APP_[A-Z0-9_]+\}$/)
    expect(new Set([server.ETEBASE_OWNER_PASSWORD, signing, database]).size).toBe(3)
    expect(signing).not.toBe('${APP_SEED}')
    expect(server.ETEBASE_BOOTSTRAP_ADMIN_TOKEN ?? '').toBe('')
    expect(server.ETEBASE_DISABLE_DJANGO_ADMIN).toBe('true')
    expect(server.CORS_ALLOWED_ORIGINS).toBe('')
    expect(['', '127.0.0.1']).toContain(server.TRUSTED_PROXY_IPS ?? '')
    const all = packageTexts().join('\n')
    expect(all).not.toMatch(/NETWORK_IP/)
    expect(all).toMatch(/^\s*allowed_host1\s*=\s*\*\s*$/m)
  })

  it('derives each package secret from a stable purpose-labelled derive_entropy export', () => {
    const script = exportsScript()
    const exported = [...script.matchAll(/^export\s+(APP_[A-Z0-9_]+)="\$\(derive_entropy\s+"([^"]+)"\)"\s*$/gm)]
    const names = exported.map(([, name]) => name)
    const labels = exported.map(([, , label]) => label)
    const server = env(compose().services.server)
    const database = env(compose().services.postgres).POSTGRES_PASSWORD ?? ''
    for (const reference of [server.ETEBASE_REGISTRATION_TOKEN, database]) {
      expect(names, `${reference} must come from exports.sh`).toContain(String(reference).slice(2, -1))
    }
    expect(new Set(labels).size).toBe(labels.length)
    for (const label of labels) expect(label).toMatch(/-(registration|signing|postgres|database|db)[a-z0-9-]*$/)
    expect(script).not.toMatch(/\$RANDOM|openssl rand|uuidgen|\/dev\/urandom|\bdate\b/)
  })
})

describe('Umbrel candidate CI workflow', () => {
  it('builds owner-enabled self-host images from the exact PR head without publishing anything', () => {
    const text = readRequired(workflowPath)
    const workflow = parse(text) as Record<string, any>
    expect(Object.keys(workflow.on ?? workflow[true as unknown as string] ?? {})).toContain('pull_request')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    for (const [name, job] of Object.entries(workflow.jobs ?? {}) as [string, Record<string, any>][]) {
      expect(job.environment, `${name}.environment`).toBeUndefined()
      expect([undefined, { contents: 'read' }], `${name}.permissions`).toContainEqual(job.permissions)
    }
    expect(text).not.toMatch(/secrets\.|docker\/login-action|docker push|push:\s*true|gh release|git tag|git push/)

    const uses = [...text.matchAll(/uses:\s*([^\s@]+)@(\S+)/g)]
    expect(uses.length).toBeGreaterThan(0)
    for (const [, action, ref] of uses) {
      expect(ref, `${action} must be pinned`).toMatch(/^[0-9a-f]{40}$/)
      if (PINNED_ACTIONS[action]) expect(ref, action).toBe(PINNED_ACTIONS[action])
    }
    expect(text).toContain('ref: ${{ github.event.pull_request.head.sha }}')
    expect(text).toMatch(/VCS_REF=\$\{\{ github\.event\.pull_request\.head\.sha \}\}/)
    expect(text).toMatch(/NEXT_PUBLIC_SELF_HOSTED=true/)
    expect(text).toMatch(/NEXT_PUBLIC_ETEBASE_SERVER_URL=(\s*$|["']{2}|\n)/m)
    expect(text).toMatch(/NEXT_PUBLIC_OWNER_REGISTRATION=true/)
    expect(text).toMatch(/docker save|type=(docker|oci),dest=/)
    expect(text).toContain('self-host/umbrel/silentsuite')
    expect(text).toMatch(/sha256sum/)
    expect(text).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/)
  })
})
