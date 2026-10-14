import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// Runtime robustness contract for the development Umbrel candidate: the server container
// starts through a package-owned wrapper that preserves the image lifecycle while keeping
// request paths out of container logs, the smoke script cannot die from a pipefail/SIGPIPE
// race on docker logs, and the probe fails cleanly instead of cascading after a failure.
// Nothing here starts containers.

const repoRoot = resolve(__dirname, '../../../../..')
const packageDir = resolve(repoRoot, 'self-host/umbrel/silentsuite')
const wrapperPath = join(packageDir, 'data/bootstrap/server-start.sh')
const smokePath = resolve(repoRoot, 'scripts/umbrel-candidate-smoke.sh')
const probePath = resolve(repoRoot, 'scripts/umbrel-candidate-probe.py')
const workflowPath = resolve(repoRoot, '.github/workflows/ci-umbrel-candidate.yml')

function readRequired(path: string): string {
  expect(existsSync(path), `missing ${path.slice(repoRoot.length + 1)}`).toBe(true)
  return readFileSync(path, 'utf8')
}

type Service = Record<string, any>
const compose = () => parse(readRequired(join(packageDir, 'docker-compose.yml'))) as { services: Record<string, Service> }

describe('Umbrel package server runtime wrapper', () => {
  it('starts the server through the package wrapper mounted from its own bind data', () => {
    const server = compose().services.server
    expect(server, 'server service').toBeDefined()
    expect((server.entrypoint ?? []).join(' ')).toContain('/bootstrap/server-start.sh')
    expect(server.command, 'the wrapper owns the lifecycle; no command override').toBeUndefined()
    expect((server.volumes ?? []).map(String)).toContain('${APP_DATA_DIR}/data/bootstrap:/bootstrap:ro')
  })

  it('preserves collectstatic, migrations and the two-worker uvicorn lifecycle', () => {
    const wrapper = readRequired(wrapperPath)
    expect(wrapper).toContain('python manage.py collectstatic --noinput')
    expect(wrapper).toContain('python manage.py migrate --noinput')
    expect(wrapper).toContain('uvicorn etebase_server.asgi:application')
    expect(wrapper).toContain('--host 0.0.0.0 --port 3735')
    expect(wrapper).toContain('--workers 2')
  })

  it('disables access logging with the real uvicorn flag and invents no env names', () => {
    const wrapper = readRequired(wrapperPath)
    expect(wrapper).toContain('--no-access-log')
    expect(wrapper).not.toMatch(/UVICORN_[A-Z_]+/)
    const environment = (compose().services.server.environment ?? {}) as Record<string, unknown>
    expect(Object.keys(environment).join(' ')).not.toMatch(/UVICORN_/)
  })

  it('keeps forwarded-IP trust on loopback and starts files private', () => {
    const wrapper = readRequired(wrapperPath)
    expect(wrapper).toContain('TRUSTED_PROXY_IPS="${TRUSTED_PROXY_IPS:-127.0.0.1}"')
    expect(wrapper).toContain('umask 077')
    expect(wrapper).not.toContain('0.0.0.0/0')
  })

  it('never creates Django admin or bootstrap authority', () => {
    const wrapper = readRequired(wrapperPath)
    expect(wrapper).not.toContain('SUPER_USER')
    expect(wrapper).not.toContain('create_superuser')
    expect(wrapper).not.toContain('ETEBASE_BOOTSTRAP')
  })
})

describe('Umbrel candidate smoke and probe failure behavior', () => {
  it('cannot fail the smoke script through a pipefail/SIGPIPE race on docker logs', () => {
    const smoke = readRequired(smokePath)
    expect(smoke).toMatch(/set -euo pipefail/)
    for (const line of smoke.split('\n')) {
      expect(line.trim(), `pipefail race: ${line.trim()}`).not.toMatch(/\|\s*grep -q/)
    }
    expect(smoke).toContain('applying database migrations')
    const secretCheck = smoke.indexOf('secret.txt')
    const restartCheck = smoke.indexOf('--after-restart')
    expect(secretCheck, 'secret file is checked before the restart').toBeGreaterThan(-1)
    expect(restartCheck).toBeGreaterThan(secretCheck)
  })

  it('stops the probe cleanly when the stack or owner grant is unavailable', () => {
    const probe = readRequired(probePath)
    expect(probe).toMatch(/if not wait_for_stack\(\)/)
    expect(probe).not.toContain('json.loads(body).get(')
    expect(probe).toMatch(/except ValueError/)
    expect(probe).toContain('NOT COVERED')
  })
})

describe('Umbrel candidate archive delivery', () => {
  it('uploads the development archive with hidden files included and the unchanged scoped path', () => {
    const workflow = parse(readRequired(workflowPath)) as Record<string, any>
    const steps = (workflow.jobs?.candidate?.steps ?? []) as Record<string, any>[]
    const upload = steps.find((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@'))
    expect(upload, 'upload-artifact step').toBeDefined()
    const inputs = (upload?.with ?? {}) as Record<string, unknown>
    expect(inputs['include-hidden-files'], 'hidden files must be delivered').toBe(true)
    expect(inputs.path, 'upload path stays scoped to the candidate dir').toBe('${{ runner.temp }}/umbrel-candidate')
    expect(inputs.name).toBe('umbrel-development-candidate-${{ github.event.pull_request.head.sha }}')
    expect(inputs['if-no-files-found']).toBe('error')
    expect(inputs['retention-days']).toBe(7)
  })
})
