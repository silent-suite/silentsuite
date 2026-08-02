import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function workflow(name: string): string {
  return readFileSync(resolve(process.cwd(), `../../.github/workflows/${name}`), 'utf8')
}

describe('production deployment workflow integrity', () => {
  it.each([
    ['deploy-web.yml', 'web-production', 'WEB_DEPLOY_APPROVED_SHA'],
    ['deploy-server.yml', 'server-production', 'SERVER_DEPLOY_APPROVED_SHA'],
    ['deploy-docs.yml', 'docs-production', 'DOCS_DEPLOY_APPROVED_SHA'],
  ])('%s requires continuing exact-SHA owner approval', (name, environment, approvalVariable) => {
    const source = workflow(name)

    expect(source).toContain('workflow_dispatch:')
    expect(source).toContain('expected_sha:')
    expect(source).not.toMatch(/^  push:/m)
    expect(source.match(new RegExp(`environment: ${environment}`, 'g'))).toHaveLength(2)
    expect(source.split(`${approvalVariable}: \${{ vars.${approvalVariable} }}`).length - 1).toBe(2)
    expect(source.split(`[ "$${approvalVariable}" != "$EXPECTED_SHA" ]`).length - 1).toBe(2)
    expect(source.match(/ref: \$\{\{ inputs\.expected_sha \}\}/g)).toHaveLength(2)
    expect(source.match(/LIVE_MAIN_SHA=\$\(git rev-parse origin\/main\)/g)).toHaveLength(2)
    expect(source.match(/\[ "\$GITHUB_SHA" != "\$LIVE_MAIN_SHA" \]/g)).toHaveLength(2)
    expect(source.match(/\[ "\$EXPECTED_SHA" != "\$LIVE_MAIN_SHA" \]/g)).toHaveLength(2)
  })

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

  it.each(['deploy-web.yml', 'deploy-server.yml'])('%s reauthorizes as the final step before SSH mutation', (name) => {
    const source = workflow(name)
    const reauthorization = source.indexOf('name: Re-assert live main immediately before deployment')
    const mutation = source.indexOf('name: Deploy via SSH')

    expect(reauthorization).toBeGreaterThan(-1)
    expect(mutation).toBeGreaterThan(reauthorization)
    expect(source.slice(reauthorization, mutation)).not.toContain('\n      - name:')
  })

  it('blocks the web cutover until Billing proves the non-bearer handoff is ready', () => {
    const source = workflow('deploy-web.yml')
    const gate = source.indexOf('https://api.silentsuite.io/health/link-proof')
    const deploy = source.indexOf('name: Deploy via SSH')

    expect(gate).toBeGreaterThan(-1)
    expect(deploy).toBeGreaterThan(gate)
  })

  it('builds docs once and deploys the admitted artifact after reauthorization', () => {
    const source = workflow('deploy-docs.yml')
    const deployJob = source.slice(source.indexOf('\n  deploy:'))
    const reauthorization = deployJob.indexOf('name: Re-assert owner approval immediately before deployment')
    const mutation = deployJob.indexOf('name: Deploy to production Worker')
    const mutationStep = deployJob.lastIndexOf('\n      - name:', mutation)

    expect(source).toContain('needs: build')
    expect(source).toContain('name: docs-production-${{ inputs.expected_sha }}')
    expect(source).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02')
    expect(source).toContain('actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093')
    expect(deployJob).not.toContain('pnpm run build')
    expect(reauthorization).toBeGreaterThan(-1)
    expect(mutationStep).toBeGreaterThan(reauthorization)
    expect(deployJob.slice(reauthorization, mutationStep)).not.toContain('\n      - name:')
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
