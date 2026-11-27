import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// Static contract for the CasaOS / ZimaOS app-store package and its CI workflow.
// Nothing here starts containers; ci-casaos-package.yml boots the stack.

const repoRoot = resolve(__dirname, '../../../../..')
const packageDir = resolve(repoRoot, 'self-host/casaos/SilentSuite')
const composePath = resolve(packageDir, 'docker-compose.yml')
const workflowPath = resolve(repoRoot, '.github/workflows/ci-casaos-package.yml')

const RELEASE_VERSION = '0.5.22-beta'
const WEB_IMAGE = 'ghcr.io/silent-suite/silentsuite-web-selfhost:v0.5.22-beta@sha256:0684fdde0c71e5b849c10f5f4992b307cabf19f311fa865d9cda5939e1bc4cb2'
const SERVER_IMAGE = 'ghcr.io/silent-suite/silentsuite-server:v0.5.22-beta@sha256:e6db5a437a7c5ec6d64289037ab1dce19616ea5feee9cee068fe91c2a39130a0'
const POSTGRES_IMAGE = 'postgres:16.16-alpine@sha256:81e77a4833487b8132fe4b00bedd39dc3f74b8641e387f19312a48f7de218c2e'
const ROUTER_IMAGE = 'nginxinc/nginx-unprivileged:1.30.6-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03'
const DATA_ROOT = '/DATA/AppData/$AppID/'
const STORE_CATEGORIES = ['Media', 'Productivity', 'Home', 'Networking', 'AI', 'Finance', 'Social', 'Developer', 'Others']
const PASSWORD_PATH = '/DATA/AppData/silentsuite/installation-password/password.txt'
const PINNED_ACTIONS: Record<string, string> = {
  'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-python': '5fda3b95a4ea91299a34e894583c3862153e4b97',
}

type Service = {
  image: string
  entrypoint?: string[]
  environment?: Record<string, string>
  volumes?: string[]
  ports?: Array<{ target: number; published: string; protocol: string }>
  depends_on?: Record<string, { condition: string }>
  [key: string]: unknown
}

const text = readFileSync(composePath, 'utf8')
const compose = parse(text) as {
  name: string
  services: Record<string, Service>
  'x-casaos': Record<string, unknown>
}
const services = compose.services
const xcasaos = compose['x-casaos']
const program = (name: string) => (services[name].entrypoint ?? []).join('\n')

describe('CasaOS package store rules', () => {
  it('declares the identity, entry and metadata the store validator and builder require', () => {
    expect(compose.name).toMatch(/^[a-z0-9_-]+$/)
    expect(xcasaos.id).toBe('io.silentsuite.silentsuite')
    expect(String(xcasaos.id)).toMatch(/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\.[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/)
    expect(Object.keys(services)).toContain(xcasaos.main)
    expect(xcasaos.index).toBe('/')
    expect(xcasaos.port_map).toBe('39128')
    expect(xcasaos.scheme).toBe('http')
    expect(STORE_CATEGORIES).toContain(xcasaos.category)
    expect(xcasaos.architectures).toEqual(['amd64', 'arm64'])
    for (const field of ['title', 'tagline', 'description', 'release_notes']) {
      expect((xcasaos[field] as Record<string, string>).en_US, field).toBeTruthy()
    }
    expect(xcasaos.icon).toBe('https://cdn.jsdelivr.net/gh/IceWhaleTech/CasaOS-AppStore@main/Apps/SilentSuite/icon.png')
    expect(existsSync(resolve(packageDir, 'icon.png'))).toBe(true)
  })

  it('declares the released version and refreshes it with the images', () => {
    expect(xcasaos.version).toBe(RELEASE_VERSION)
    expect(String(xcasaos.update_at)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(services['silentsuite-web'].image).toContain(`:v${RELEASE_VERSION}@sha256:`)
  })

  it('uses the web service as main, so legacy CasaOS sees each release as an update', () => {
    // CasaOS-AppManagement compares the main service's image tag; the router's never changes.
    expect(xcasaos.main).toBe('silentsuite-web')
    const tag = services['silentsuite-web'].image.split(':').slice(1).join(':')
    expect(tag).toMatch(/^v\d+\.\d+\.\d+[-.\w]*@sha256:[0-9a-f]{64}$/)
    expect(tag.startsWith('latest')).toBe(false)
  })

  it('contains no interpolation except the platform AppID (ZimaOS interpolates twice)', () => {
    const tokens = new Set(text.match(/\$\{?[A-Za-z_]*/g) ?? [])
    expect([...tokens]).toEqual(['$AppID'])
  })
})

describe('CasaOS package runtime boundaries', () => {
  it('runs router, web, one-shot init, server and PostgreSQL only', () => {
    expect(Object.keys(services).sort()).toEqual(
      ['silentsuite', 'silentsuite-db', 'silentsuite-init', 'silentsuite-server', 'silentsuite-web'],
    )
  })

  it('pins every image to the released or reviewed digest', () => {
    expect(services.silentsuite.image).toBe(ROUTER_IMAGE)
    expect(services['silentsuite-web'].image).toBe(WEB_IMAGE)
    expect(services['silentsuite-init'].image).toBe(SERVER_IMAGE)
    expect(services['silentsuite-server'].image).toBe(SERVER_IMAGE)
    expect(services['silentsuite-db'].image).toBe(POSTGRES_IMAGE)
  })

  it('publishes only the router port and grants no host access', () => {
    for (const [name, service] of Object.entries(services)) {
      for (const key of ['privileged', 'cap_add', 'devices', 'pid', 'ipc', 'security_opt', 'env_file', 'build', 'extra_hosts']) {
        expect(service[key], `${name}.${key}`).toBeUndefined()
      }
      if (name === 'silentsuite-init') expect(service.network_mode).toBe('none')
      else expect(service.network_mode, name).toBeUndefined()
      if (name !== 'silentsuite') expect(service.ports, name).toBeUndefined()
      for (const volume of service.volumes ?? []) {
        expect(volume, name).toMatch(/^\/DATA\/AppData\/\$AppID\/[a-z-]+:\/[a-z/-]+(:ro)?$/)
        expect(volume).not.toContain('docker.sock')
      }
    }
    expect(services.silentsuite.ports).toEqual([{ target: 8080, published: '39128', protocol: 'tcp' }])
  })

  it('mounts only directories, never a single file path (CasaOS creates missing sources as directories)', () => {
    const sources = Object.values(services).flatMap((service) => (service.volumes ?? []).map((v) => v.split(':')[0]))
    for (const source of sources) {
      expect(source.startsWith(DATA_ROOT)).toBe(true)
      expect(source.slice(DATA_ROOT.length)).not.toContain('.')
    }
  })

  it('starts the server and database only after init succeeded', () => {
    expect(services['silentsuite-server'].depends_on?.['silentsuite-init']).toEqual({ condition: 'service_completed_successfully' })
    expect(services['silentsuite-db'].depends_on?.['silentsuite-init']).toEqual({ condition: 'service_completed_successfully' })
    expect(services['silentsuite-init'].restart).toBe('no')
  })
})

describe('CasaOS package credentials', () => {
  it('holds no credential in the file and generates three independent ones in init', () => {
    const init = program('silentsuite-init')
    expect(init).toContain('NAMES = ("owner-password", "registration-signing", "database-password")')
    expect(init).toContain('secrets.token_hex(32)')
    expect(init).toContain('VALID = re.compile(r"[0-9a-f]{64}\\n?")')
    expect(text).not.toMatch(/PASSWORD:\s*\S*[0-9a-f]{16}/i)
    for (const service of Object.values(services)) {
      for (const key of Object.keys(service.environment ?? {})) {
        expect(['SUPER_USER', 'SUPER_PASS', 'ETEBASE_BOOTSTRAP_ADMIN_TOKEN', 'ETEBASE_OWNER_PASSWORD', 'ETEBASE_REGISTRATION_TOKEN', 'POSTGRES_PASSWORD']).not.toContain(key)
      }
    }
  })

  it('refuses an existing database without a valid credential set, markerless PGDATA included', () => {
    const init = program('silentsuite-init')
    expect(init).toContain('existing_database = os.path.isdir("/pg/pgdata") and bool(os.listdir("/pg/pgdata"))')
    expect(init).toContain('Nothing was changed.')
    expect(init).not.toContain('PG_VERSION")')
  })

  it('makes the server validate all three credentials itself and export only two', () => {
    const server = program('silentsuite-server')
    expect(server).toContain('NAMES = ("owner-password", "registration-signing", "database-password")')
    expect(server).toContain('if len(set(values.values())) != len(NAMES):')
    expect(server.match(/os\.environ\["[A-Z_]+"\] =/g)).toEqual([
      'os.environ["ETEBASE_OWNER_PASSWORD"] =',
      'os.environ["ETEBASE_REGISTRATION_TOKEN"] =',
    ])
    expect(services['silentsuite-server'].volumes).toContain(`${DATA_ROOT}server-secrets:/run/silentsuite:ro`)
    expect(services['silentsuite-db'].environment?.POSTGRES_PASSWORD_FILE).toBe('/run/silentsuite/password')
  })

  it('keeps Django admin off and never configures a bootstrap or superuser credential', () => {
    expect(services['silentsuite-server'].environment).toMatchObject({
      ETEBASE_DISABLE_DJANGO_ADMIN: 'true',
      CORS_ALLOWED_ORIGINS: '',
      ETEBASE_SECURE_SSL_REDIRECT: 'false',
    })
    expect(text).not.toMatch(/createsuperuser|SUPER_PASS|BOOTSTRAP_ADMIN/)
  })
})

describe('CasaOS package logging and routing', () => {
  it('runs the two-worker uvicorn with access logging off and loopback-only forwarded IPs', () => {
    const server = program('silentsuite-server')
    for (const part of ['"--workers", "2"', '"--no-access-log"', '"--log-level", "warning"', '"--forwarded-allow-ips", "127.0.0.1"', 'os.umask(0o077)', '"collectstatic"', '"migrate"']) {
      expect(server).toContain(part)
    }
  })

  it('routes /api/ to the server and everything else to the web app with Host and WebSockets intact', () => {
    const router = program('silentsuite')
    expect(router).toContain("tr '@' '\\044' > /etc/nginx/conf.d/default.conf <<'EOF'")
    for (const part of ['access_log off;', 'error_log /dev/null;', 'proxy_set_header Host @http_host;', 'proxy_set_header Upgrade @http_upgrade;',
      'proxy_set_header Connection @connection_upgrade;', 'resolver 127.0.0.11', 'set @server_upstream silentsuite-server:3735;',
      'set @web_upstream silentsuite-web:3000;', 'location /api/ {', 'proxy_pass http://@server_upstream;', 'proxy_pass http://@web_upstream;']) {
      expect(router).toContain(part)
    }
    // No other "@" may reach tr: it would turn into a dollar sign.
    const config = router.slice(router.indexOf("<<'EOF'"), router.lastIndexOf('EOF'))
    expect(config.match(/@[a-z_]+/g)?.every((token) => ['@http_upgrade', '@connection_upgrade', '@http_host', '@server_upstream', '@web_upstream'].includes(token))).toBe(true)
  })
})

describe('CasaOS listing copy', () => {
  const tips = (xcasaos.tips as { before_install: { en_US: string } }).before_install.en_US
  const description = (xcasaos.description as { en_US: string }).en_US

  it('says HTTPS is required before signup works, and where the installation password is', () => {
    expect(tips).toContain('HTTPS is required')
    expect(tips).toContain(PASSWORD_PATH)
    expect(program('silentsuite-init')).toContain(PASSWORD_PATH)
  })

  it('documents a stopped, ownership-preserving backup and a move-aside restore', () => {
    expect(tips).toContain('stop SilentSuite in the dashboard first')
    expect(tips).toContain('sudo cp -a')
    expect(tips).toContain('move the existing folder aside')
  })

  it('names the Bridge for CalDAV/CardDAV and is honest about what is untested', () => {
    expect(description).toContain('desktop Bridge')
    expect(description).toContain('has no CalDAV or CardDAV endpoint')
    expect(description).toContain('not yet on a real CasaOS or ZimaOS device')
  })
})

describe('CasaOS package CI workflow', () => {
  const workflow = readFileSync(workflowPath, 'utf8')

  it('pins every action, reads only and publishes nothing', () => {
    for (const [, action, ref] of workflow.matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@(\S+)/g)) {
      expect(PINNED_ACTIONS[action], action).toBe(ref)
    }
    expect(workflow).toMatch(/permissions:\n {2}contents: read/)
    expect(workflow).not.toMatch(/docker (push|login)|upload-artifact|\$\{\{\s*secrets\./)
  })

  it('runs both native architectures through the store builder and the boot drills', () => {
    expect(workflow).toContain('runner: ubuntu-24.04\n')
    expect(workflow).toContain('runner: ubuntu-24.04-arm')
    expect(workflow).toContain('STORE_BUILDER_SHA: c9bb47fad5b32d7928a07978fad68801f52e910f')
    expect(workflow).toContain('docker-compose.$ARCH.yml')
    expect(workflow).toContain('scripts/casaos-package-update-check.py')
    expect(workflow).toContain('bash scripts/casaos-package-smoke.sh')
  })
})
