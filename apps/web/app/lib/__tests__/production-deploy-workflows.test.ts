import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function workflow(name: string): string {
  return readFileSync(resolve(process.cwd(), `../../.github/workflows/${name}`), 'utf8')
}

describe('production deployment workflow integrity', () => {
  it.each(['deploy-web.yml', 'deploy-server.yml'])('%s deploys only an exact live-main image', (name) => {
    const source = workflow(name)

    expect(source).toContain('git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main')
    expect(source.match(/GITHUB_SHA.*LIVE_MAIN_SHA/g)).toHaveLength(2)
    expect(source).toContain('IMAGE_NAME }}:${{ github.sha }}')
    expect(source).toContain('DEPLOY_SHA: ${{ github.sha }}')
    expect(source).toContain('IMAGE_DIGEST: ${{ needs.build-and-push.outputs.image-digest }}')
    expect(source).toContain('image: ${IMAGE_NAME}@${IMAGE_DIGEST}')
    expect(source).toContain('org.opencontainers.image.revision')
    expect(source).toContain("bash -se <<'BASH'")
    expect(source).not.toMatch(/silentsuite-(?:web|server):latest/)
  })

  it('blocks the web cutover until Billing proves the non-bearer handoff is ready', () => {
    const source = workflow('deploy-web.yml')
    const gate = source.indexOf('https://api.silentsuite.io/health/link-proof')
    const deploy = source.indexOf('name: Deploy via SSH')

    expect(gate).toBeGreaterThan(-1)
    expect(deploy).toBeGreaterThan(gate)
  })

  it('runs server migrations from the exact image before replacing the server', () => {
    const source = workflow('deploy-server.yml')
    const migration = source.indexOf('run --rm --no-deps silentsuite-server python manage.py migrate --noinput')
    const replacement = source.indexOf('up -d --force-recreate --no-deps --no-build silentsuite-server')

    expect(migration).toBeGreaterThan(-1)
    expect(replacement).toBeGreaterThan(migration)
  })

  it.each([
    ['deploy-web.yml', 'web'],
    ['deploy-server.yml', 'server'],
  ])('%s verifies the running image and rolls back failed replacements', (name, component) => {
    const source = workflow(name)

    expect(source).toContain('PREVIOUS_IMAGE_ID=')
    expect(source).toContain('RUNNING_IMAGE_ID=')
    expect(source).toContain('RUNNING_REVISION=')
    expect(source).toContain('rollback()')
    expect(source).toContain(`Automatic ${component} rollback failed`)
  })
})
