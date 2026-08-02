import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function workflow(name: string): string {
  return readFileSync(resolve(process.cwd(), `../../.github/workflows/${name}`), 'utf8')
}

const deployRunbook = readFileSync(resolve(process.cwd(), '../../runbooks/production-deploy.md'), 'utf8')

function stripYamlComment(line: string): string {
  let inSingleQuote = false
  let inDoubleQuote = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === "'" && !inDoubleQuote) {
      if (inSingleQuote && line[index + 1] === "'") {
        index += 1
      } else {
        inSingleQuote = !inSingleQuote
      }
    } else if (character === '"' && !inSingleQuote && line[index - 1] !== '\\') {
      inDoubleQuote = !inDoubleQuote
    } else if (character === '#' && !inSingleQuote && !inDoubleQuote && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index).trimEnd()
    }
  }
  return line
}

function jobBlock(source: string, name: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((line) => line === `  ${name}:`)
  if (start === -1) throw new Error(`Missing job: ${name}`)
  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^  [A-Za-z0-9_-]+:$/.test(line))
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd
  return lines.slice(start, end).map(stripYamlComment).filter((line) => line.trim().length > 0).join('\n')
}

describe('production deployment workflow integrity', () => {
  it('strips inline YAML comments without stripping quoted hashes', () => {
    expect(stripYamlComment('    timeout-minutes: 10 # fake authorization')).toBe('    timeout-minutes: 10')
    expect(stripYamlComment('    value: "kept # literal" # removed')).toBe('    value: "kept # literal"')
  })

  it('documents repository approval variables and the actual revocation boundary', () => {
    expect(deployRunbook).toContain("component's repository approval variable")
    expect(deployRunbook).toContain('do not configure a same-named environment variable')
    expect(deployRunbook).toContain('Approval is not dynamically reloaded after a deployment job has started')
    expect(deployRunbook).not.toContain("component's protected-environment approval variable")
    expect(deployRunbook).toContain('Production dispatch is operationally blocked until all three component environments')
    expect(deployRunbook).toContain('auto-create it without protection rules')
    expect(deployRunbook).toContain('deployment branch policy that permits only `main`')
    expect(deployRunbook).toContain('Do not set an approval variable or dispatch any production workflow until this verification succeeds')
    expect(deployRunbook).toContain('none of the three component environments existed')
  })

  it.each([
    ['deploy-web.yml', 'web-production', 'WEB_DEPLOY_APPROVED_SHA'],
    ['deploy-server.yml', 'server-production', 'SERVER_DEPLOY_APPROVED_SHA'],
    ['deploy-docs.yml', 'docs-production', 'DOCS_DEPLOY_APPROVED_SHA'],
  ])('%s requires continuing exact-SHA owner approval', (name, environment, approvalVariable) => {
    const source = workflow(name)
    const jobNames = name === 'deploy-docs.yml' ? ['build', 'deploy'] : ['build-and-push', 'deploy']

    expect(source).toContain('workflow_dispatch:')
    expect(source).toContain('expected_sha:')
    expect(source).not.toMatch(/^  push:/m)
    for (const jobName of jobNames) {
      const job = jobBlock(source, jobName)
      expect(job.split('\n').filter((line) => /^    if:/.test(line))).toEqual([
        `    if: github.ref == 'refs/heads/main' && vars.${approvalVariable} == inputs.expected_sha`,
      ])
      expect(job).toContain(`environment: ${environment}`)
      expect(job).toContain(`${approvalVariable}: \${{ vars.${approvalVariable} }}`)
      expect(job).toContain(`[ "$${approvalVariable}" != "$EXPECTED_SHA" ]`)
      expect(job).toContain('ref: ${{ inputs.expected_sha }}')
      expect(job).toContain('LIVE_MAIN_SHA=$(git rev-parse origin/main)')
      expect(job).toContain('[ "$GITHUB_SHA" != "$LIVE_MAIN_SHA" ]')
      expect(job).toContain('[ "$EXPECTED_SHA" != "$LIVE_MAIN_SHA" ]')
    }
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
    const deploy = jobBlock(workflow(name), 'deploy')
    const reauthorization = deploy.indexOf('      - name: Re-assert live main immediately before deployment')
    const mutation = deploy.indexOf('      - name: Deploy via SSH')

    expect(reauthorization).toBeGreaterThan(-1)
    expect(mutation).toBeGreaterThan(reauthorization)
    expect(deploy.slice(reauthorization + 1, mutation)).not.toMatch(/^      - /m)
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
    const buildJob = jobBlock(source, 'build')
    const deployJob = jobBlock(source, 'deploy')
    const reauthorization = deployJob.indexOf('      - name: Re-assert owner approval immediately before deployment')
    const mutation = deployJob.indexOf('      - name: Deploy to production Worker')

    expect(source).toContain('needs: build')
    expect(source).toContain('name: docs-production-${{ inputs.expected_sha }}')
    expect(buildJob).toContain('id: upload')
    expect(buildJob).toContain('artifact-id: ${{ steps.upload.outputs.artifact-id }}')
    expect(buildJob).toContain('artifact-digest: ${{ steps.upload.outputs.artifact-digest }}')
    expect(deployJob).toContain('actions: read')
    expect(deployJob).toContain('ARTIFACT_ID: ${{ needs.build.outputs.artifact-id }}')
    expect(deployJob).toContain('EXPECTED_ARTIFACT_DIGEST: ${{ needs.build.outputs.artifact-digest }}')
    expect(deployJob).toContain('actions/artifacts/$ARTIFACT_ID/zip')
    expect(deployJob).toContain('ACTUAL_ARTIFACT_DIGEST=$(sha256sum')
    expect(deployJob).toContain('test "$ACTUAL_ARTIFACT_DIGEST" = "$EXPECTED_ARTIFACT_DIGEST"')
    expect(deployJob).not.toContain('actions/download-artifact@')
    expect(deployJob).not.toContain('pnpm run build')
    expect(reauthorization).toBeGreaterThan(-1)
    expect(mutation).toBeGreaterThan(reauthorization)
    expect(deployJob.slice(reauthorization + 1, mutation)).not.toMatch(/^      - /m)
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
