import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'

type WorkflowStep = {
  name?: string
  uses?: string
  with?: Record<string, string>
  run?: string
}

type WorkflowJob = {
  if?: string
  environment?: string
  env?: Record<string, string>
  needs?: string
  steps?: WorkflowStep[]
}

type ParsedWorkflow = { jobs: Record<string, WorkflowJob> }

function workflow(name: string): string {
  return readFileSync(resolve(process.cwd(), `../../.github/workflows/${name}`), 'utf8')
}

function parseWorkflow(source: string): ParsedWorkflow {
  const document = parseDocument(source, { uniqueKeys: true })
  if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join('\n'))
  const workflow = document.toJS() as ParsedWorkflow
  const rejectMergeKeys = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Object.prototype.hasOwnProperty.call(value, '<<')) throw new Error('YAML merge keys are not supported')
    for (const child of Object.values(value)) rejectMergeKeys(child)
  }
  rejectMergeKeys(workflow)
  return workflow
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function expectAuthorizedJob(job: WorkflowJob, environment: string, approvalVariable: string, authorizationName: string, expectedRunSha256: string) {
  const steps = job.steps ?? []
  expect(job.if).toBe(
    `github.ref == 'refs/heads/main' && github.sha == inputs.expected_sha && vars.${approvalVariable} == inputs.expected_sha`,
  )
  expect(job.environment).toBe(environment)
  expect(job.env?.[approvalVariable]).toBe(`\${{ vars.${approvalVariable} }}`)
  const checkouts = steps.filter((step) => step.uses?.startsWith('actions/checkout@'))
  expect(checkouts).toHaveLength(1)
  expect(checkouts[0].with?.ref).toBe('${{ inputs.expected_sha }}')
  const authorizationSteps = steps.filter((step) => step.name === authorizationName)
  expect(authorizationSteps).toHaveLength(1)
  const run = authorizationSteps[0].run ?? ''
  expect(sha256(run)).toBe(expectedRunSha256)
  expect(run).toContain(`[ "$${approvalVariable}" != "$EXPECTED_SHA" ]`)
  expect(run).toContain('LIVE_MAIN_SHA=$(git rev-parse origin/main)')
  expect(run).toContain('[ "$GITHUB_SHA" != "$LIVE_MAIN_SHA" ]')
  expect(run).toContain('[ "$EXPECTED_SHA" != "$LIVE_MAIN_SHA" ]')
}

const deployRunbook = readFileSync(resolve(process.cwd(), '../../runbooks/production-deploy.md'), 'utf8')

function jobBlock(source: string, name: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((line) => line === `  ${name}:`)
  if (start === -1) throw new Error(`Missing job: ${name}`)
  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^  [A-Za-z0-9_-]+:$/.test(line))
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd
  return lines.slice(start, end).join('\n')
}

describe('production deployment workflow integrity', () => {
  it('strict AST rejects attacker checkout, no-op authorization, heredoc decoys, and duplicate keys', () => {
    const source = workflow('deploy-web.yml')
    const mutated = source
      .replace('          ref: ${{ inputs.expected_sha }}', '          ref: refs/heads/attacker')
      .replace('        run: |\n          set -euo pipefail', '        run: exit 0\n\n      - name: Harmless heredoc decoy\n        run: |\n          ref: ${{ inputs.expected_sha }}\n          set -euo pipefail')
    const job = parseWorkflow(mutated).jobs['build-and-push']
    expect(() => expectAuthorizedJob(job, 'web-production', 'WEB_DEPLOY_APPROVED_SHA', 'Assert this is the live main commit', 'e6ba5b37eecde3082c3ec47f85d3885591e769998348d31fde7ca520d9e9413d')).toThrow()

    const duplicate = source.replace('    environment: web-production', '    environment: web-production\n    environment: attacker')
    expect(() => parseWorkflow(duplicate)).toThrow()
  })

  it('plain-scalar comment decoys cannot satisfy exact structural lines', () => {
    const source = workflow('deploy-web.yml')
      .replace('    environment: web-production', "    name: Owner's build # environment: web-production")
      .replace('      WEB_DEPLOY_APPROVED_SHA: ${{ vars.WEB_DEPLOY_APPROVED_SHA }}', '    name: Release 12" image # WEB_DEPLOY_APPROVED_SHA: ${{ vars.WEB_DEPLOY_APPROVED_SHA }}')
    const lines = jobBlock(source, 'build-and-push').split('\n')

    expect(lines).not.toContain('    environment: web-production')
    expect(lines).not.toContain('      WEB_DEPLOY_APPROVED_SHA: ${{ vars.WEB_DEPLOY_APPROVED_SHA }}')
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
    ['deploy-web.yml', 'web-production', 'WEB_DEPLOY_APPROVED_SHA', ['e6ba5b37eecde3082c3ec47f85d3885591e769998348d31fde7ca520d9e9413d', 'cfc63a1210b969831bc73107aec443b5238a2a8feae86a1f01eadeeec969ce15']],
    ['deploy-server.yml', 'server-production', 'SERVER_DEPLOY_APPROVED_SHA', ['a42b337d7f795fd005cecaa0b450e8ed98ae71906b1541c0c5576fc7ddcd10b5', '9876fb19ad6579b278cb6d8aa8fbc6b011995d1b336ce80e6b0ab1d1fffbe0f4']],
    ['deploy-docs.yml', 'docs-production', 'DOCS_DEPLOY_APPROVED_SHA', ['02f41b250b6256a39c271cde53df98c87759b77ad38987af6d92dee96814d77b', '34fd2be0097b650297047c7c918ec462bc6d5d77f17a3320dab5bd8eeaab309b']],
  ])('%s requires continuing exact-SHA owner approval', (name, environment, approvalVariable, runDigests) => {
    const source = workflow(name)
    const parsed = parseWorkflow(source)
    const jobNames = name === 'deploy-docs.yml' ? ['build', 'deploy'] : ['build-and-push', 'deploy']
    expect(Object.keys(parsed.jobs).sort()).toEqual([...jobNames].sort())

    expect(source).toContain('workflow_dispatch:')
    expect(source).toContain('expected_sha:')
    expect(source).not.toMatch(/^  push:/m)
    for (const [index, jobName] of jobNames.entries()) {
      const job = parsed.jobs[jobName]
      const authorizationName = jobName === 'deploy'
        ? name === 'deploy-docs.yml' ? 'Re-assert owner approval immediately before deployment' : 'Re-assert live main immediately before deployment'
        : name === 'deploy-docs.yml' ? 'Verify exact owner-approved live main commit for build' : 'Assert this is the live main commit'
      expectAuthorizedJob(job, environment, approvalVariable, authorizationName, runDigests[index])
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
    const parsed = parseWorkflow(workflow(name))
    const steps = parsed.jobs.deploy.steps ?? []
    const reauthorization = steps.findIndex((step) => step.name === 'Re-assert live main immediately before deployment')
    const mutation = steps.findIndex((step) => step.name === 'Deploy via SSH' && step.uses?.startsWith('appleboy/ssh-action@'))
    const mutationActions = Object.values(parsed.jobs).flatMap((job) => job.steps ?? []).filter((step) => step.uses?.startsWith('appleboy/ssh-action@'))

    expect(mutationActions).toHaveLength(1)
    expect(mutation).toBe(reauthorization + 1)
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
    const parsed = parseWorkflow(source)
    const deploySteps = parsed.jobs.deploy.steps ?? []
    const downloadIndex = deploySteps.findIndex((step) => step.name === 'Download and verify admitted docs artifact')
    const reauthorization = deploySteps.findIndex((step) => step.name === 'Re-assert owner approval immediately before deployment')
    const mutation = deploySteps.findIndex((step) => step.name === 'Deploy to production Worker' && step.uses?.startsWith('cloudflare/wrangler-action@'))
    const mutationActions = Object.values(parsed.jobs).flatMap((job) => job.steps ?? []).filter((step) => step.uses?.startsWith('cloudflare/wrangler-action@'))

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
    const download = deploySteps[downloadIndex]
    expect(sha256(download?.run ?? '')).toBe('3839d4770098d4b1a20435631a3c1c628aed3648b5f1678f94fc965f949052eb')
    expect(deployJob).not.toContain('actions/download-artifact@')
    expect(deployJob).not.toContain('pnpm run build')
    expect(mutationActions).toHaveLength(1)
    expect(downloadIndex).toBeGreaterThan(-1)
    expect(downloadIndex).toBeLessThan(reauthorization)
    expect(mutation).toBe(reauthorization + 1)
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
