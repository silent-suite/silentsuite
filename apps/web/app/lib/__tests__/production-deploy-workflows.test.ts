import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'

type WorkflowStep = {
  name?: string
  if?: string
  uses?: string
  shell?: string
  env?: Record<string, string>
  with?: Record<string, string>
  run?: string
  'continue-on-error'?: boolean
}

type WorkflowJob = {
  if?: string
  environment?: string
  env?: Record<string, string>
  needs?: string
  permissions?: Record<string, string>
  'timeout-minutes'?: number
  outputs?: Record<string, string>
  uses?: string
  secrets?: Record<string, string>
  steps?: WorkflowStep[]
}

type ParsedWorkflow = {
  name?: string
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, unknown>
    }
    workflow_call?: {
      secrets?: Record<string, { required?: boolean }>
    }
  }
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean }
  env?: Record<string, string>
  jobs: Record<string, WorkflowJob>
}

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

function executeStreamingDeployScript(migrationCommand: string): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'silentsuite-compose-stdin-'))
  const docker = join(directory, 'docker')
  writeFileSync(docker, `#!/bin/sh
case " $* " in
  *" --interactive=false "*) exit 0 ;;
  *) cat >/dev/null ;;
esac
`)
  chmodSync(docker, 0o700)

  return new Promise((resolveOutput, reject) => {
    const child = spawn('bash', ['-se'], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (status) => {
      rmSync(directory, { recursive: true, force: true })
      if (status === 0) resolveOutput(stdout)
      else reject(new Error(`streaming deploy fixture failed (${status}): ${stderr}`))
    })
    child.stdin.write(`docker compose ${migrationCommand}\n`)
    setTimeout(() => child.stdin.end("printf '__AFTER_MIGRATION__\\n'\n"), 25)
  })
}

const jobContracts: Record<string, Record<string, { steps: string; permissions: string }>> = {
  'deploy-web.yml': {
    'build-and-push': { steps: '879dff8ef54f62febae9b7d55fb6411e3033a843e6b71104914b4922ab63114c', permissions: '005c397eb9ccf2cc53aad524b4ebcad817405ec025bb937a039a8a5ef8c69bca' },
    deploy: { steps: '0c0f3e19720c3a70dc8ac1f9997deae683af96b27de26cf6a249e8976790e90a', permissions: 'd8d6aceb1abc41990618a503082c3badcca8897feee0976f222af5b74e30bec2' },
  },
  'deploy-server.yml': {
    'build-and-push': { steps: 'eaaaecf8738fd3b7d25bfb6f383709911df7c00da94dff1cca81014fdb254a62', permissions: '005c397eb9ccf2cc53aad524b4ebcad817405ec025bb937a039a8a5ef8c69bca' },
    deploy: { steps: 'bbd0c9a9415d24b319bf53201011b78485a5a22674d36336b252fa770e19cf4c', permissions: 'd8d6aceb1abc41990618a503082c3badcca8897feee0976f222af5b74e30bec2' },
  },
  'deploy-docs.yml': {
    build: { steps: 'aaa1a984b500e400dfe37e18519e66fff62ead0c6d96bc09b731174a2ad0ce5b', permissions: 'd8d6aceb1abc41990618a503082c3badcca8897feee0976f222af5b74e30bec2' },
    deploy: { steps: '6e12aca6ea1f36bec6c34603968cf8d2aa32e9434a9dd6805a6ce182301c0aca', permissions: '551b70084a8244c7f3114d8603c3d2ddac6b642093a4b34cd2e3a00b7e4f8ee1' },
  },
  // build and deploy permissions must equal deploy-docs.yml's.
  'deploy-docs-standalone.yml': {
    admission: { steps: '73ab530335bd89541c24b3c6ffb70983a5d78802ec7f697b4d7686e760524702', permissions: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a' },
    build: { steps: '26c6b38174fcb382ca677de8a448dc78d43eb1f8446b73d2bdc96460b7385f22', permissions: 'd8d6aceb1abc41990618a503082c3badcca8897feee0976f222af5b74e30bec2' },
    deploy: { steps: 'dcd03aaa5b0eab562a5fa65239ec3193012156bcf330e611df87f1164f3e5943', permissions: '551b70084a8244c7f3114d8603c3d2ddac6b642093a4b34cd2e3a00b7e4f8ee1' },
  },
}

const workflowContracts: Record<string, string> = {
  'deploy-web.yml': 'a1507e64f4617da3f9b7a17c9ad8ef81898b01d7e2471c6aadd96f0cc7c39deb',
  'deploy-server.yml': 'ee8015b23a29d0faa6b0ecb0371f049ae9189c37fe4c80591f82f0e844193312',
  'deploy-docs.yml': 'b75623f1069fc1a4d6ede2834a85b9e90bbc190a70260bf3e3d5b9e2d65f1d3d',
  'deploy-docs-standalone.yml': 'f26f9bc78ecfe56d61086bebc1aa6d945bed216645f6f443f6de3d825469e9cd',
}

const approvedNode24ActionPins: Record<string, string> = {
  'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
  'pnpm/action-setup': '0977fd99725f1db4007ccb2928dbb4e90d06cc86',
  'actions/setup-python': '5fda3b95a4ea91299a34e894583c3862153e4b97',
  'actions/setup-java': 'b6effb05e454b25005698d916606bdc6ffcbf961',
  'actions/cache': '55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
  'ReactiveCircus/android-emulator-runner': 'a421e43855164a8197daf9d8d40fe71c6996bb0d',
  'actions/github-script': '3a2844b7e9c422d3c10d287c895573f7108da1b3',
  'cloudflare/wrangler-action': 'ebbaa1584979971c8614a24965b4405ff95890e0',
  'docker/setup-qemu-action': '96fe6ef7f33517b61c61be40b68a1882f3264fb8',
  'android-actions/setup-android': '40fd30fb8d7440372e1316f5d1809ec01dcd3699',
  'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020',
  'actions/upload-artifact': '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  'actions/download-artifact': '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
  'actions/create-github-app-token': '0f859bf9e69e887678d5bbfbee594437cb440ffe',
  'docker/setup-buildx-action': 'bb05f3f5519dd87d3ba754cc423b652a5edd6d2c',
  'docker/login-action': 'dbcb813823bdd20940b903addbd779551569679f',
  'docker/build-push-action': '53b7df96c91f9c12dcc8a07bcb9ccacbed38856a',
}

function node24PinViolations(root: string): string[] {
  const seen = new Set<string>()
  const violations: string[] = []

  for (const relativeDirectory of ['.github/workflows', 'android/.github/workflows']) {
    const directory = join(root, relativeDirectory)
    for (const name of readdirSync(directory).filter((entry) => /\.ya?ml$/.test(entry))) {
      const relativePath = `${relativeDirectory}/${name}`
      let parsed: ParsedWorkflow
      try {
        parsed = parseWorkflow(readFileSync(join(directory, name), 'utf8'))
      } catch (error) {
        violations.push(`${relativePath}: invalid workflow YAML: ${String(error)}`)
        continue
      }

      for (const job of Object.values(parsed.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (typeof step.uses !== 'string') continue
          const separator = step.uses.lastIndexOf('@')
          const action = separator === -1 ? step.uses : step.uses.slice(0, separator)
          const canonicalAction = Object.keys(approvedNode24ActionPins)
            .find((approved) => approved.toLocaleLowerCase('en-US') === action.toLocaleLowerCase('en-US'))
          if (!canonicalAction) continue
          seen.add(canonicalAction)
          const expected = `${canonicalAction}@${approvedNode24ActionPins[canonicalAction]}`
          if (step.uses !== expected) {
            violations.push(
              `${relativePath}: governed action must use exact immutable pin ${expected}; found ${step.uses}`,
            )
          }
        }
      }
    }
  }

  for (const action of Object.keys(approvedNode24ActionPins)) {
    if (!seen.has(action)) violations.push(`missing governed action: ${action}`)
  }
  return violations
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
  expect(authorizationSteps[0].shell).toBe('bash')
  const run = authorizationSteps[0].run ?? ''
  expect(sha256(run)).toBe(expectedRunSha256)
  expect(run).toContain(`[ "$${approvalVariable}" != "$EXPECTED_SHA" ]`)
  expect(run).toContain('LIVE_MAIN_SHA=$(git rev-parse origin/main)')
  expect(run).toContain('[ "$GITHUB_SHA" != "$LIVE_MAIN_SHA" ]')
  expect(run).toContain('[ "$EXPECTED_SHA" != "$LIVE_MAIN_SHA" ]')
}

const deployRunbook = readFileSync(resolve(process.cwd(), '../../runbooks/production-deploy.md'), 'utf8')
const billingLinkRollout = readFileSync(resolve(process.cwd(), '../../docs/operator-billing-link-proof-rollout.md'), 'utf8')

function jobBlock(source: string, name: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((line) => line === `  ${name}:`)
  if (start === -1) throw new Error(`Missing job: ${name}`)
  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^  [A-Za-z0-9_-]+:$/.test(line))
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd
  return lines.slice(start, end).join('\n')
}

// drone-ssh, the transport behind the pinned appleboy/ssh-action, skips server
// verification when its fingerprint input is empty. The mutation connection is
// authenticated only while with.fingerprint is bound to the protected secret
// and the runner refuses missing or malformed custody before final authorization.
const pinnedSshAction = 'appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2'
const sshFingerprintBinding = '${{ secrets.VPS_SSH_FINGERPRINT }}'
const sshFingerprintPreflightName = 'Require protected SSH host-key fingerprint before final authorization'
const sshFingerprintPreflightSha256 = 'afcb1a61e8c77b3de23bf7fe4ce0f19aeb8117660dfb8b033e852de34da642ae'

function sshHostVerificationViolations(parsed: ParsedWorkflow): string[] {
  const violations: string[] = []
  const steps = parsed.jobs.deploy?.steps ?? []
  const allSteps = Object.values(parsed.jobs).flatMap((job) => job.steps ?? [])
  const reauthorization = steps.findIndex((step) => step.name === 'Re-assert live main immediately before deployment')
  const mutation = steps.findIndex((step) => step.name === 'Deploy via SSH')
  const preflight = steps.findIndex((step) => step.name === sshFingerprintPreflightName)
  const ssh = steps[mutation]
  const custody = steps[preflight]
  const environmentNames = [parsed.env, ...Object.values(parsed.jobs).map((job) => job.env), ...allSteps.map((step) => step.env)]
    .flatMap((env) => Object.keys(env ?? {}))

  if (allSteps.filter((step) => step.uses?.startsWith('appleboy/')).length !== 1 || ssh?.uses !== pinnedSshAction || ssh?.if !== undefined || ssh?.['continue-on-error'] !== undefined) {
    violations.push('SSH mutation must be the single unconditional reviewed appleboy/ssh-action pin')
  }
  if (ssh?.with?.fingerprint !== sshFingerprintBinding) violations.push('SSH mutation must bind with.fingerprint to the protected VPS_SSH_FINGERPRINT secret')
  if (Object.keys(ssh?.with ?? {}).some((key) => key.startsWith('proxy_')) || environmentNames.some((name) => /^(?:PLUGIN|SSH|INPUT)_FINGERPRINT$/.test(name))) {
    violations.push('SSH mutation must not proxy or override the transport fingerprint')
  }
  if (reauthorization < 0 || mutation !== reauthorization + 1) violations.push('final authorization must remain directly adjacent to the SSH mutation')
  if (steps.filter((step) => step.name === sshFingerprintPreflightName).length !== 1 || preflight !== reauthorization - 1) {
    violations.push('fingerprint custody preflight must run immediately before final authorization')
  }
  if (custody?.if !== undefined || custody?.['continue-on-error'] !== undefined || custody?.uses !== undefined || custody?.shell !== 'bash' ||
    JSON.stringify(custody?.env) !== JSON.stringify({ VPS_SSH_FINGERPRINT: sshFingerprintBinding }) || sha256(custody?.run ?? '') !== sshFingerprintPreflightSha256) {
    violations.push('fingerprint custody preflight must be the exact reviewed fail-closed validation')
  }
  if (JSON.stringify(parsed.on?.workflow_call?.secrets?.VPS_SSH_FINGERPRINT) !== '{"required":true}') {
    violations.push('reusable workflow must declare VPS_SSH_FINGERPRINT as a required secret')
  }
  return violations
}

function moveStep(source: string, stepName: string, beforeStepName: string): string {
  const start = source.indexOf(`      - name: ${stepName}\n`)
  if (start === -1) throw new Error(`Missing step: ${stepName}`)
  const end = source.indexOf('\n      - name: ', start + 1) + 1
  const block = source.slice(start, end)
  const remainder = source.slice(0, start) + source.slice(end)
  const target = remainder.indexOf(`      - name: ${beforeStepName}\n`)
  if (target === -1) throw new Error(`Missing step: ${beforeStepName}`)
  return remainder.slice(0, target) + block + remainder.slice(target)
}

function removeStep(source: string, stepName: string): string {
  const start = source.indexOf(`      - name: ${stepName}\n`)
  if (start === -1) throw new Error(`Missing step: ${stepName}`)
  const end = source.indexOf('\n      - name: ', start + 1) + 1
  return source.slice(0, start) + source.slice(end)
}

function insertBeforeStep(source: string, beforeStepName: string, block: string): string {
  const target = source.indexOf(`      - name: ${beforeStepName}\n`)
  if (target === -1) throw new Error(`Missing step: ${beforeStepName}`)
  return source.slice(0, target) + block + source.slice(target)
}

function runSshFingerprintPreflight(run: string, value?: string) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
  if (value !== undefined) env.VPS_SSH_FINGERPRINT = value
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run], { env, encoding: 'utf8' })
}

// Semantic contracts shared by the protected deploy workflows. The whole-workflow and
// job digests stay in the calling test so these can also judge mutated sources.
function expectManualOnlyContract(name: string, source: string, environment: string, approvalVariable: string, runDigests: string[]) {
  const parsed = parseWorkflow(source)
  const docs = name === 'deploy-docs.yml' || name === 'deploy-docs-standalone.yml'
  const jobNames = name === 'deploy-docs-standalone.yml' ? ['admission', 'build', 'deploy'] : docs ? ['build', 'deploy'] : ['build-and-push', 'deploy']
  expect(Object.keys(parsed.jobs).sort()).toEqual([...jobNames].sort())

  expect(source).toContain('workflow_dispatch:')
  expect(source).toContain('expected_sha:')
  expect(source).not.toMatch(/^  push:/m)
  const stageASteps = Object.values(parsed.jobs).flatMap((job) => job.steps ?? []).filter(
    (step) => step.uses === './.github/actions/verify-annual-pre-public-admission',
  )
  if (name === 'deploy-web.yml' || name === 'deploy-docs.yml') {
    expect(parsed.on?.workflow_call?.secrets?.ANNUAL_PUBLIC_REVIEW_HMAC_KEY).toEqual({ required: true })
    expect(stageASteps.filter(
      (step) => step.with?.public_review_hmac_key === '${{ secrets.ANNUAL_PUBLIC_REVIEW_HMAC_KEY }}',
    )).toHaveLength(2)
  }
  if (name === 'deploy-docs-standalone.yml') {
    expect(parsed.on?.workflow_call).toBeUndefined()
    expect(stageASteps).toHaveLength(0)
  }
  // The secretless standalone admission preflight is asserted separately; it is not a protected job.
  for (const [index, jobName] of jobNames.filter((jobName) => jobName !== 'admission').entries()) {
    const authorizationName = jobName === 'deploy'
      ? docs ? 'Re-assert owner approval immediately before deployment' : 'Re-assert live main immediately before deployment'
      : docs ? 'Verify exact owner-approved live main commit for build' : 'Assert this is the live main commit'
    expectAuthorizedJob(parsed.jobs[jobName], environment, approvalVariable, authorizationName, runDigests[index])
  }
}

function expectDocsBuildOnce(name: string, source: string, artifactName: string) {
  const buildJob = jobBlock(source, 'build')
  const deployJob = jobBlock(source, 'deploy')
  const parsed = parseWorkflow(source)
  const deploySteps = parsed.jobs.deploy.steps ?? []
  const downloadIndex = deploySteps.findIndex((step) => step.name === 'Download and verify admitted docs artifact')
  const reauthorization = deploySteps.findIndex((step) => step.name === 'Re-assert owner approval immediately before deployment')
  const mutation = deploySteps.findIndex((step) => step.name === 'Deploy to production Worker' && step.uses?.startsWith('cloudflare/wrangler-action@'))
  const mutationActions = Object.values(parsed.jobs).flatMap((job) => job.steps ?? []).filter((step) => step.uses?.startsWith('cloudflare/wrangler-action@'))

  expect(source).toContain('needs: build')
  expect(source).toContain(`name: ${artifactName}`)
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
  expect(sha256(download?.run ?? '')).toBe('ee4fc688752cc0d5381af6ea1bf9be77f9b652c1de4ddb650847bc72f7ee9715')
  expect(deployJob).not.toContain('actions/download-artifact@')
  expect(deployJob).not.toContain('pnpm run build')
  expect(mutationActions).toHaveLength(1)
  expect(downloadIndex).toBeGreaterThan(-1)
  expect(downloadIndex).toBeLessThan(reauthorization)
  expect(mutation).toBe(reauthorization + 1)
  if (name === 'deploy-docs.yml') {
    expect(buildJob).toContain('Fetch and verify exact timestamp-free Stage A before docs publication')
    expect(deployJob).toContain('Re-verify exact timestamp-free Stage A before docs deployment')
  } else {
    expect(source).not.toContain('name: docs-production-${{ inputs.expected_sha }}')
    expect(source).not.toContain('timestamp-free Stage A')
  }
  expect(buildJob).toContain('deployment-identity.json')
  expect(deployJob).toContain('deployment-identity.json')
}

function expectStandaloneMirrorsAnnualDocs(source: string) {
  const annual = parseWorkflow(workflow('deploy-docs.yml'))
  const standalone = parseWorkflow(source)
  const isAnnualAdmissionStep = (step: WorkflowStep) =>
    step.uses === './.github/actions/verify-annual-pre-public-admission' || step.uses?.startsWith('actions/create-github-app-token@') === true
  // The only two permitted differences in every retained step and job control.
  const asStandalone = <T>(value: T): T => JSON.parse(JSON.stringify(value)
    .replaceAll('DOCS_DEPLOY_APPROVED_SHA', 'DOCS_STANDALONE_DEPLOY_APPROVED_SHA')
    .replaceAll('docs-production-${{ inputs.expected_sha }}', 'docs-standalone-production-${{ inputs.expected_sha }}'))
  const controls = (job: WorkflowJob) => ({
    if: job.if, environment: job.environment, permissions: job.permissions, 'timeout-minutes': job['timeout-minutes'], outputs: job.outputs,
  })

  for (const jobName of ['build', 'deploy']) {
    const reference = annual.jobs[jobName]
    const candidate = standalone.jobs[jobName]
    expect((reference.steps ?? []).filter(isAnnualAdmissionStep)).toHaveLength(2)
    expect(candidate?.steps).toStrictEqual(asStandalone((reference.steps ?? []).filter((step) => !isAnnualAdmissionStep(step))))
    expect(controls(candidate)).toEqual(asStandalone(controls(reference)))
  }
  expect(standalone.jobs.build.needs).toBe('admission')
  expect(standalone.jobs.deploy.needs).toBe(annual.jobs.deploy.needs)
  expect(standalone.concurrency).toEqual(annual.concurrency)
  expect(standalone.concurrency).toEqual({ group: 'deploy-docs-production', 'cancel-in-progress': false })
}

function expectStandaloneCarriesNoAnnualMaterial(source: string) {
  const parsed = parseWorkflow(source)
  const steps = Object.values(parsed.jobs).flatMap((job) => job.steps ?? [])
  const deploySteps = parsed.jobs.deploy?.steps ?? []
  const uploads = steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'))
  const mutations = steps.filter((step) => step.uses?.startsWith('cloudflare/wrangler-action@'))
  const reauthorization = deploySteps.findIndex((step) => step.name === 'Re-assert owner approval immediately before deployment')
  const mutation = deploySteps.findIndex((step) => step.uses?.startsWith('cloudflare/wrangler-action@'))

  expect(parsed.name).toBe('Deploy Docs standalone (production, no annual Stage A)')
  expect(source).not.toMatch(/ANNUAL_|annual-only|verify-annual-pre-public-admission|create-github-app-token|private_admission|DOCS_DEPLOY_APPROVED_SHA|workflow_call/)
  expect(source).not.toMatch(/secrets:\s*inherit/)
  expect(Object.keys(parsed.on ?? {})).toEqual(['workflow_dispatch'])
  expect(Object.keys(parsed.on?.workflow_dispatch?.inputs ?? {})).toEqual(['expected_sha'])
  expect(uploads).toHaveLength(1)
  expect(uploads[0]?.with?.name).toBe('docs-standalone-production-${{ inputs.expected_sha }}')
  expect(uploads[0]?.with?.name).not.toMatch(/^annual-only-/)
  expect(mutations).toHaveLength(1)
  expect(steps.filter((step) => step.if !== undefined || step['continue-on-error'] !== undefined)).toEqual([])
  expect(reauthorization).toBeGreaterThan(-1)
  expect(mutation).toBe(reauthorization + 1)
  expect(JSON.stringify(parsed.jobs.deploy ?? {})).not.toMatch(/vitepress build|pnpm run build|actions\/download-artifact@/)
}

function expectStandaloneAdmissionPreflight(source: string) {
  const admission = parseWorkflow(source).jobs.admission
  const steps = admission?.steps ?? []
  const run = steps[0]?.run ?? ''

  expect(admission).toBeDefined()
  expect(admission.if).toBeUndefined()
  expect(admission.needs).toBeUndefined()
  expect(admission.environment).toBeUndefined()
  expect(admission['timeout-minutes']).toBe(5)
  expect(admission.permissions).toEqual({})
  expect(admission.env).toEqual({
    EXPECTED_SHA: '${{ inputs.expected_sha }}',
    DOCS_STANDALONE_DEPLOY_APPROVED_SHA: '${{ vars.DOCS_STANDALONE_DEPLOY_APPROVED_SHA }}',
  })
  expect(JSON.stringify(admission)).not.toContain('secrets.')
  expect(steps).toHaveLength(1)
  expect(steps.filter((step) => step.uses !== undefined)).toEqual([])
  expect(steps[0]?.shell).toBe('bash')
  // Structural only; the executable proof of this body is the admission harness below.
  for (const fragment of [
    'set -uo pipefail',
    'refused=0',
    'fail() { echo "::error::$1"; refused=1; }',
    `[ "$GITHUB_REF" != 'refs/heads/main' ]`,
    `grep -Eq '^[0-9a-f]{40}$'`,
    '[ "$GITHUB_SHA" != "$EXPECTED_SHA" ]',
    'exit 1',
    'Refusing standalone docs deploy: the owner-approved exact-SHA admission is incomplete, so no job may run.',
  ]) expect(run).toContain(fragment)
  expect(run).toMatch(/-z "\$\{?DOCS_STANDALONE_DEPLOY_APPROVED_SHA/)
  expect(run).toMatch(/"\$\{?DOCS_STANDALONE_DEPLOY_APPROVED_SHA(?::-)?\}?" != "\$EXPECTED_SHA"/)
  expect((run.match(/^\s*fail "/gm) ?? []).length).toBeGreaterThanOrEqual(4)
  expect(run).not.toMatch(/\b(?:gh|git|curl|wget)\b/)
}

function expectCutoverInvokesOnlyAnnualDocs(cutoverSource: string) {
  const cutover = parseWorkflow(cutoverSource)
  expect(standaloneDocsCallers('annual-only-public-cutover.yml', cutoverSource)).toEqual([])
  expect(cutover.jobs['deploy-docs'].uses).toBe('./.github/workflows/deploy-docs.yml')
  expect(cutover.jobs.admission.env?.DOCS_DEPLOY_APPROVED_SHA).toBe('${{ vars.DOCS_DEPLOY_APPROVED_SHA }}')
  expect(cutoverSource).not.toContain('deploy-docs-standalone')
  expect(cutoverSource).not.toContain('DOCS_STANDALONE_DEPLOY_APPROVED_SHA')
}

function standaloneDocsCallers(name: string, source: string): string[] {
  return Object.entries(parseWorkflow(source).jobs ?? {})
    .filter(([, job]) => job.uses?.includes('deploy-docs-standalone.yml'))
    .map(([jobName]) => `${name}:${jobName}`)
}

const docsAuthorizationRunDigests = ['02f41b250b6256a39c271cde53df98c87759b77ad38987af6d92dee96814d77b', '34fd2be0097b650297047c7c918ec462bc6d5d77f17a3320dab5bd8eeaab309b']
const standaloneAuthorizationRunDigests = ['448dc0c62dd76fca8eb4e273c3da1574d7f593f9a3be358ea3f966260df4d03f', '36f60a1654f28cfcb0ed697ea94bba3e620bf4b22492be26e560ed80b8a5edaf']

// Every Stage 1 semantic contract that judges the standalone workflow source. None of
// them consults workflowContracts or jobContracts; the authorization run digests inside
// expectAuthorizedJob are unaffected by fixtures that leave both run bodies intact.
const standaloneStage1Contracts: Record<string, (source: string) => void> = {
  'manual-only': (source) => expectManualOnlyContract('deploy-docs-standalone.yml', source, 'docs-production', 'DOCS_STANDALONE_DEPLOY_APPROVED_SHA', standaloneAuthorizationRunDigests),
  'build-once': (source) => expectDocsBuildOnce('deploy-docs-standalone.yml', source, 'docs-standalone-production-${{ inputs.expected_sha }}'),
  mirror: expectStandaloneMirrorsAnnualDocs,
  'no-annual-material': expectStandaloneCarriesNoAnnualMaterial,
  'admission-preflight': expectStandaloneAdmissionPreflight,
}

function standaloneStage1Rejections(source: string): string[] {
  return Object.entries(standaloneStage1Contracts).filter(([, check]) => {
    try {
      check(source)
      return false
    } catch {
      return true
    }
  }).map(([name]) => name)
}

const standaloneEnvelopeMessages = {
  rootKeys: 'workflow top-level keys must be exactly name, on, concurrency, jobs (no inherited env, defaults, or permissions)',
  name: 'workflow name must identify the standalone, non-annual Docs deployment',
  dispatch: 'workflow must be dispatch-only with exactly one required string expected_sha input',
  concurrency: 'workflow must share the non-cancelling deploy-docs-production concurrency group',
  jobs: 'workflow jobs must be exactly admission, build, deploy',
  jobControls: (job: string) => `${job} job execution controls must be exactly the reviewed runner, timeout, predicate, dependency, environment, permissions, and outputs`,
  jobEnv: (job: string) => `${job} job env must be exactly the reviewed map`,
  stepEnv: (job: string, index: number) => `${job} step ${index} env must be exactly the reviewed map`,
  admissionStep: 'admission must run exactly one inline bash step with no action, condition, or env',
  secretLocality: 'secrets may be referenced only as the two Cloudflare credentials in the four Wrangler fields',
  githubToken: 'github.token may be bound only as GH_TOKEN of the artifact download step',
}

// Unique source anchors ending in the build or deploy job's approval env line.
function standaloneJobEnvLine(job: 'build' | 'deploy'): string {
  const binding = '    env:\n      DOCS_STANDALONE_DEPLOY_APPROVED_SHA: ${{ vars.DOCS_STANDALONE_DEPLOY_APPROVED_SHA }}\n'
  return job === 'build' ? `      artifact-digest: \${{ steps.upload.outputs.artifact-digest }}\n${binding}` : `      contents: read\n${binding}`
}

// Closed effective-controls envelope of deploy-docs-standalone.yml, judged only on the
// parsed object so a refreshed digest cannot admit an inherited or misplaced credential.
const standaloneApprovalBinding = '${{ vars.DOCS_STANDALONE_DEPLOY_APPROVED_SHA }}'
const standaloneJobPredicate = "github.ref == 'refs/heads/main' && github.sha == inputs.expected_sha && vars.DOCS_STANDALONE_DEPLOY_APPROVED_SHA == inputs.expected_sha"
const standaloneExpectedShaBinding = { EXPECTED_SHA: '${{ inputs.expected_sha }}' }
const standaloneWranglerSecrets = { CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}', CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}' }

// Every job key except steps, with its exact reviewed value; anything else (runner,
// container, services, defaults, strategy, continue-on-error) is outside the envelope.
const standaloneJobControls: Record<string, Record<string, unknown>> = {
  admission: { 'runs-on': 'ubuntu-latest', 'timeout-minutes': 5, permissions: {} },
  build: {
    if: standaloneJobPredicate, needs: 'admission', 'runs-on': 'ubuntu-latest', 'timeout-minutes': 10, environment: 'docs-production', permissions: { contents: 'read' },
    outputs: { 'artifact-id': '${{ steps.upload.outputs.artifact-id }}', 'artifact-digest': '${{ steps.upload.outputs.artifact-digest }}' },
  },
  deploy: { if: standaloneJobPredicate, needs: 'build', 'runs-on': 'ubuntu-latest', 'timeout-minutes': 10, environment: 'docs-production', permissions: { actions: 'read', contents: 'read' } },
}

const standaloneJobEnvs: Record<string, Record<string, string>> = {
  admission: { ...standaloneExpectedShaBinding, DOCS_STANDALONE_DEPLOY_APPROVED_SHA: standaloneApprovalBinding },
  build: { DOCS_STANDALONE_DEPLOY_APPROVED_SHA: standaloneApprovalBinding },
  deploy: { DOCS_STANDALONE_DEPLOY_APPROVED_SHA: standaloneApprovalBinding },
}

// Step env maps exactly as deploy-docs.yml declares them for the copied steps; every
// other step has no env.
const standaloneStepEnvs: Record<string, Record<string, string>> = {
  'build/Verify exact owner-approved live main commit for build': standaloneExpectedShaBinding,
  'build/Embed exact immutable public SHA for post-deploy served-content verification': standaloneExpectedShaBinding,
  'build/Build docs': { SILENTSUITE_HOSTED_DOCS_ANALYTICS: '1' },
  'deploy/Download and verify admitted docs artifact': {
    ARTIFACT_ID: '${{ needs.build.outputs.artifact-id }}', EXPECTED_ARTIFACT_DIGEST: '${{ needs.build.outputs.artifact-digest }}', GH_TOKEN: '${{ github.token }}',
  },
  'deploy/Re-assert owner approval immediately before deployment': standaloneExpectedShaBinding,
  'deploy/Deploy to production Worker': standaloneWranglerSecrets,
}

function standaloneEnvelopeViolations(parsed: ParsedWorkflow): string[] {
  const violations: string[] = []
  const jobs = parsed.jobs ?? {}
  const steps = Object.entries(jobs).flatMap(([jobName, job]) => (job.steps ?? []).map((step, index) => ({ jobName, index, step })))

  if (!isDeepStrictEqual(Object.keys(parsed).sort(), ['concurrency', 'jobs', 'name', 'on'])) violations.push(standaloneEnvelopeMessages.rootKeys)
  if (parsed.name !== 'Deploy Docs standalone (production, no annual Stage A)') violations.push(standaloneEnvelopeMessages.name)
  if (!isDeepStrictEqual(parsed.on, {
    workflow_dispatch: { inputs: { expected_sha: { description: 'Exact reviewed live main commit to build and deploy', required: true, type: 'string' } } },
  })) violations.push(standaloneEnvelopeMessages.dispatch)
  if (!isDeepStrictEqual(parsed.concurrency, { group: 'deploy-docs-production', 'cancel-in-progress': false })) violations.push(standaloneEnvelopeMessages.concurrency)
  if (!isDeepStrictEqual(Object.keys(jobs).sort(), ['admission', 'build', 'deploy'])) violations.push(standaloneEnvelopeMessages.jobs)

  for (const jobName of Object.keys(standaloneJobControls)) {
    const job = (jobs[jobName] ?? {}) as Record<string, unknown>
    const controls = Object.fromEntries(Object.entries(job).filter(([key]) => key !== 'steps' && key !== 'env'))
    if (!isDeepStrictEqual(controls, standaloneJobControls[jobName])) violations.push(standaloneEnvelopeMessages.jobControls(jobName))
    if (!isDeepStrictEqual(job.env, standaloneJobEnvs[jobName])) violations.push(standaloneEnvelopeMessages.jobEnv(jobName))
  }
  for (const { jobName, index, step } of steps) {
    if (!isDeepStrictEqual(step.env, standaloneStepEnvs[`${jobName}/${step.name}`])) violations.push(standaloneEnvelopeMessages.stepEnv(jobName, index))
  }
  const admissionSteps = jobs.admission?.steps ?? []
  if (admissionSteps.length !== 1 || !isDeepStrictEqual(Object.keys(admissionSteps[0] ?? {}).sort(), ['name', 'run', 'shell']) || admissionSteps[0]?.shell !== 'bash') {
    violations.push(standaloneEnvelopeMessages.admissionStep)
  }

  // Secret locality: strip the four reviewed Wrangler fields from a copy of the single
  // deploy-job Wrangler step; no secrets context may remain anywhere in the workflow.
  const wranglers = steps.filter(({ step }) => step.uses?.startsWith('cloudflare/wrangler-action@'))
  const wrangler = wranglers[0]
  const remainder = JSON.parse(JSON.stringify(parsed)) as ParsedWorkflow
  if (wranglers.length === 1 && wrangler.jobName === 'deploy') {
    const copy = remainder.jobs.deploy.steps?.[wrangler.index]
    if (copy?.with?.apiToken === standaloneWranglerSecrets.CLOUDFLARE_API_TOKEN && copy.with.accountId === standaloneWranglerSecrets.CLOUDFLARE_ACCOUNT_ID &&
      isDeepStrictEqual(copy.env, standaloneWranglerSecrets)) {
      delete copy.with.apiToken
      delete copy.with.accountId
      delete copy.env
    }
  }
  if (/\bsecrets\b/i.test(JSON.stringify(remainder))) violations.push(standaloneEnvelopeMessages.secretLocality)

  // github.token reaches only the artifact download step, as GH_TOKEN.
  const tokenReferences = JSON.stringify(parsed).match(/\bgithub\b\s*(?:\.|\[)\s*['"]?token\b/gi) ?? []
  const download = steps.filter(({ jobName, step }) => jobName === 'deploy' && step.name === 'Download and verify admitted docs artifact')
  if (tokenReferences.length !== 1 || download.length !== 1 || download[0].step.env?.GH_TOKEN !== '${{ github.token }}' || /\bGITHUB_TOKEN\b/.test(JSON.stringify(parsed))) {
    violations.push(standaloneEnvelopeMessages.githubToken)
  }
  return violations
}

const standaloneAdmissionDiagnostics = {
  ref: '::error::standalone docs deploy runs only from refs/heads/main',
  format: '::error::expected_sha must be exactly 40 lowercase hexadecimal characters',
  head: '::error::the dispatched head is not the reviewed expected_sha',
  unarmed: '::error::repository variable DOCS_STANDALONE_DEPLOY_APPROVED_SHA is not armed; arm it to the exact expected_sha for this one dispatch, then clear it after the run',
  other: '::error::repository variable DOCS_STANDALONE_DEPLOY_APPROVED_SHA is armed for a different SHA than expected_sha',
}
const standaloneAdmissionRefusal = 'Refusing standalone docs deploy: the owner-approved exact-SHA admission is incomplete, so no job may run.'
const standaloneAdmissionSuccess = 'Admission complete: the standalone docs approval is armed for the exact dispatched live main head.'

type StandaloneAdmissionInputs = Partial<Record<'GITHUB_REF' | 'GITHUB_SHA' | 'EXPECTED_SHA' | 'DOCS_STANDALONE_DEPLOY_APPROVED_SHA', string>>

// Synthetic 40-hex sentinels; none is a real commit, credential or approval value.
const admittedSha = 'a'.repeat(40)
const otherSha = 'b'.repeat(40)
const armedAdmission: StandaloneAdmissionInputs = { GITHUB_REF: 'refs/heads/main', GITHUB_SHA: admittedSha, EXPECTED_SHA: admittedSha, DOCS_STANDALONE_DEPLOY_APPROVED_SHA: admittedSha }
// Format cases bind the head and approval to the same malformed value, so only the
// format guard can refuse them and a loosened guard cannot hide behind a mismatch.
const sameMalformedValue = (value: string): StandaloneAdmissionInputs => ({ ...armedAdmission, GITHUB_SHA: value, EXPECTED_SHA: value, DOCS_STANDALONE_DEPLOY_APPROVED_SHA: value })
const admissionDiagnostic = standaloneAdmissionDiagnostics
const standaloneAdmissionCases: [string, StandaloneAdmissionInputs, string[]][] = [
  ['fully matching armed identity', armedAdmission, []],
  ['attacker ref', { ...armedAdmission, GITHUB_REF: 'refs/heads/attacker' }, [admissionDiagnostic.ref]],
  ['unset ref', { ...armedAdmission, GITHUB_REF: undefined }, [admissionDiagnostic.ref]],
  ['empty expected_sha everywhere', sameMalformedValue(''), [admissionDiagnostic.format, admissionDiagnostic.unarmed]],
  ['unset expected_sha', { ...armedAdmission, EXPECTED_SHA: undefined }, [admissionDiagnostic.format, admissionDiagnostic.head, admissionDiagnostic.other]],
  ['39-character expected_sha everywhere', sameMalformedValue('a'.repeat(39)), [admissionDiagnostic.format]],
  ['41-character expected_sha everywhere', sameMalformedValue('a'.repeat(41)), [admissionDiagnostic.format]],
  ['uppercase expected_sha everywhere', sameMalformedValue('A'.repeat(40)), [admissionDiagnostic.format]],
  ['non-hex expected_sha everywhere', sameMalformedValue('g'.repeat(40)), [admissionDiagnostic.format]],
  ['trailing-newline expected_sha everywhere', sameMalformedValue(`${admittedSha}\n`), [admissionDiagnostic.format]],
  ['two-line expected_sha everywhere', sameMalformedValue(`${admittedSha}\n${admittedSha}`), [admissionDiagnostic.format]],
  ['dispatched head mismatch', { ...armedAdmission, GITHUB_SHA: otherSha }, [admissionDiagnostic.head]],
  ['approval unset', { ...armedAdmission, DOCS_STANDALONE_DEPLOY_APPROVED_SHA: undefined }, [admissionDiagnostic.unarmed]],
  ['approval empty', { ...armedAdmission, DOCS_STANDALONE_DEPLOY_APPROVED_SHA: '' }, [admissionDiagnostic.unarmed]],
  ['approval armed for another SHA', { ...armedAdmission, DOCS_STANDALONE_DEPLOY_APPROVED_SHA: otherSha }, [admissionDiagnostic.other]],
  ['every condition at once', { GITHUB_REF: 'refs/heads/attacker', GITHUB_SHA: otherSha, EXPECTED_SHA: 'A'.repeat(40) }, [admissionDiagnostic.ref, admissionDiagnostic.format, admissionDiagnostic.head, admissionDiagnostic.unarmed]],
]

function runStandaloneAdmission(run: string, inputs: StandaloneAdmissionInputs) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
  for (const [name, value] of Object.entries(inputs)) if (value !== undefined) env[name] = value
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run], { env, encoding: 'utf8' })
}

// Runs the admission program against every case. The exact stdout transcript proves the
// exit decision, each constant diagnostic in order before the single verdict line, and
// that no input value is echoed; stderr must stay empty (no unbound-variable aborts).
function standaloneAdmissionHarnessFailures(run: string): string[] {
  const failures: string[] = []
  for (const [label, inputs, diagnostics] of standaloneAdmissionCases) {
    const result = runStandaloneAdmission(run, inputs)
    const admitted = diagnostics.length === 0
    const transcript = [...diagnostics, admitted ? standaloneAdmissionSuccess : standaloneAdmissionRefusal].map((line) => `${line}\n`).join('')
    if (result.status !== (admitted ? 0 : 1)) failures.push(`${label}: exit ${result.status}`)
    if (result.stdout !== transcript) failures.push(`${label}: stdout ${JSON.stringify(result.stdout)}`)
    if (result.stderr !== '') failures.push(`${label}: stderr ${JSON.stringify(result.stderr)}`)
  }
  return failures
}

function standaloneAdmissionRun(): string {
  const run = parseWorkflow(workflow('deploy-docs-standalone.yml')).jobs.admission?.steps?.[0]?.run
  if (typeof run !== 'string') throw new Error('Missing standalone admission program')
  return run
}

describe('production deployment workflow integrity', () => {
  it('pins migrated JavaScript actions to approved immutable Node 24 releases', () => {
    expect(node24PinViolations(resolve(process.cwd(), '../..'))).toEqual([])
  })

  it.each([
    ['bare step uses key', '.github/workflows/bypass.yml', 'jobs:\n  bypass:\n    steps:\n      - uses: actions/checkout@v7\n', 'actions/checkout@v7'],
    ['quoted value and spaced key', '.github/workflows/bypass.yml', 'jobs:\n  bypass:\n    steps:\n      - uses : "actions/checkout@v7"\n', 'actions/checkout@v7'],
    ['action identity case variant', '.github/workflows/bypass.yml', "jobs:\n  bypass:\n    steps:\n      - uses: 'Actions/Checkout@v7'\n", 'Actions/Checkout@v7'],
    ['Android sibling workflow', 'android/.github/workflows/bypass.yml', 'jobs:\n  bypass:\n    steps:\n      - uses: actions/checkout@v7\n', 'actions/checkout@v7'],
    ['standalone docs checkout (matrix row 19)', '.github/workflows/deploy-docs-standalone.yml', workflow('deploy-docs-standalone.yml').replace('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/checkout@v7'), 'actions/checkout@v7'],
  ])('rejects mutable governed actions written as %s', (_label, relativePath, source, actualUses) => {
    const root = mkdtempSync(join(tmpdir(), 'silentsuite-action-pins-'))
    try {
      for (const directory of ['.github/workflows', 'android/.github/workflows']) {
        mkdirSync(join(root, directory), { recursive: true })
      }
      for (const [action, pin] of Object.entries(approvedNode24ActionPins)) {
        writeFileSync(
          join(root, '.github/workflows', `${action.replaceAll('/', '-')}.yml`),
          `jobs:\n  control:\n    steps:\n      - name: unchanged control\n        uses: ${action}@${pin}\n`,
        )
      }
      writeFileSync(join(root, relativePath), source)

      expect(node24PinViolations(root)).toContain(
        `${relativePath}: governed action must use exact immutable pin actions/checkout@${approvedNode24ActionPins['actions/checkout']}; found ${actualUses}`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

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

  it('standalone Web authorization rejects an ineffective shell with an unchanged reviewed run body', () => {
    const source = `
name: Deploy Web standalone authorization fixture
on:
  workflow_dispatch:
    inputs:
      expected_sha: { required: true, type: string }
jobs:
  deploy:
    if: github.ref == 'refs/heads/main' && github.sha == inputs.expected_sha && vars.WEB_STANDALONE_DEPLOY_APPROVED_SHA == inputs.expected_sha
    runs-on: ubuntu-latest
    environment: web-production
    permissions:
      contents: read
    env:
      WEB_STANDALONE_DEPLOY_APPROVED_SHA: \${{ vars.WEB_STANDALONE_DEPLOY_APPROVED_SHA }}
    steps:
      - name: Checkout exact standalone Web commit
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          ref: \${{ inputs.expected_sha }}
          fetch-depth: 0
      - name: Re-assert standalone Web authorization
        shell: bash
        env:
          EXPECTED_SHA: \${{ inputs.expected_sha }}
        run: |
          set -euo pipefail
          [[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]
          [[ "$WEB_STANDALONE_DEPLOY_APPROVED_SHA" =~ ^[0-9a-f]{40}$ ]]
          git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
          LIVE_MAIN_SHA=$(git rev-parse origin/main)
          if [ "$GITHUB_REF" != "refs/heads/main" ] ||
             [ "$GITHUB_SHA" != "$LIVE_MAIN_SHA" ] ||
             [ "$(git rev-parse HEAD)" != "$EXPECTED_SHA" ] ||
             [ "$EXPECTED_SHA" != "$LIVE_MAIN_SHA" ] ||
             [ "$WEB_STANDALONE_DEPLOY_APPROVED_SHA" != "$EXPECTED_SHA" ]; then
            echo "Refusing standalone Web deployment: exact authorization is incomplete"
            exit 1
          fi
`
    const control = parseWorkflow(source).jobs.deploy
    const authorizationName = 'Re-assert standalone Web authorization'
    const controlRun = control.steps?.[1].run ?? ''
    const expectedRunSha256 = sha256(controlRun)
    expect(() => expectAuthorizedJob(control, 'web-production', 'WEB_STANDALONE_DEPLOY_APPROVED_SHA', authorizationName, expectedRunSha256)).not.toThrow()

    // Judge the new path's effective shell without consulting workflow or step hashes.
    const ineffectiveShell = "bash -c 'exit 0' {0}"
    const mutatedSource = source.replace('        shell: bash\n', `        shell: ${ineffectiveShell}\n`)
    expect(mutatedSource).not.toBe(source)
    const mutated = parseWorkflow(mutatedSource).jobs.deploy
    expect(mutated.steps?.[1].shell).toBe(ineffectiveShell)
    expect(mutated.steps?.[1].run).toBe(controlRun)
    expect(sha256(mutated.steps?.[1].run ?? '')).toBe(expectedRunSha256)
    expect(() => expectAuthorizedJob(mutated, 'web-production', 'WEB_STANDALONE_DEPLOY_APPROVED_SHA', authorizationName, expectedRunSha256)).toThrow()
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
    expect(deployRunbook).toContain('snapshotted when the workflow run is queued')
    expect(deployRunbook).toContain('does not revoke jobs in an already queued run')
    expect(deployRunbook).not.toContain('fresh repository-variable snapshot')
    expect(deployRunbook).not.toContain('between the build and deployment jobs')
    expect(deployRunbook).not.toContain("component's protected-environment approval variable")
    expect(deployRunbook).toContain('Production dispatch is operationally blocked until all three component environments')
    expect(deployRunbook).toContain('auto-create it without protection rules')
    expect(deployRunbook).toContain('deployment branch policy that permits only `main`')
    expect(deployRunbook).toContain('Do not set an approval variable or dispatch any production workflow until this verification succeeds')
    expect(deployRunbook).toContain('all three component environments exist with a custom `main`-only deployment branch policy')
    expect(deployRunbook).toContain('Stage A — private pre-public admission')
    expect(deployRunbook).toContain('Stage B — truthful public-served attestation')
    expect(deployRunbook).toContain('Stage C — private finalization')
    expect(deployRunbook).toContain('no `clientServedAt` or `verifiedAt`')
    expect(deployRunbook).not.toContain('health/link-proof')
  })

  it('keeps the Billing verifier through the previous-image rollback window', () => {
    expect(billingLinkRollout).toContain('0025_retain_etebase_session_verifier.sql')
    expect(billingLinkRollout).toContain('rollback-eligible Billing image')
    expect(billingLinkRollout).toContain('later reviewed contract release')
    expect(billingLinkRollout).toContain('At least 48 hours of clean post-cutover production soak')
    expect(billingLinkRollout).toContain('owner explicitly closes the previous-image rollback window')
    expect(billingLinkRollout).toContain('declares the prior Billing image non-restorable')
    expect(billingLinkRollout).toContain('silent-suite/silentsuite#621')
    expect(billingLinkRollout).toContain('If any condition is missing, preserve the rollback-compatible code and verifier')
    expect(billingLinkRollout).not.toContain('0025_remove_etebase_session_verifier.sql')
  })

  it.each([
    ['deploy-web.yml', 'web-production', 'WEB_DEPLOY_APPROVED_SHA', ['e6ba5b37eecde3082c3ec47f85d3885591e769998348d31fde7ca520d9e9413d', 'cfc63a1210b969831bc73107aec443b5238a2a8feae86a1f01eadeeec969ce15']],
    ['deploy-server.yml', 'server-production', 'SERVER_DEPLOY_APPROVED_SHA', ['a42b337d7f795fd005cecaa0b450e8ed98ae71906b1541c0c5576fc7ddcd10b5', '9876fb19ad6579b278cb6d8aa8fbc6b011995d1b336ce80e6b0ab1d1fffbe0f4']],
    ['deploy-docs.yml', 'docs-production', 'DOCS_DEPLOY_APPROVED_SHA', docsAuthorizationRunDigests],
    ['deploy-docs-standalone.yml', 'docs-production', 'DOCS_STANDALONE_DEPLOY_APPROVED_SHA', standaloneAuthorizationRunDigests],
  ])('%s is manual-only and binds every protected job to one reviewed SHA', (name, environment, approvalVariable, runDigests) => {
    const source = workflow(name)
    const parsed = parseWorkflow(source)
    expect(sha256(JSON.stringify(parsed))).toBe(workflowContracts[name])
    for (const [jobName, contract] of Object.entries(jobContracts[name])) {
      const job = parsed.jobs[jobName]
      expect(sha256(JSON.stringify(job?.steps ?? []))).toBe(contract.steps)
      expect(sha256(JSON.stringify(job?.permissions ?? {}))).toBe(contract.permissions)
    }
    expectManualOnlyContract(name, source, environment, approvalVariable, runDigests)
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

  it('blocks public deployment until an exact immutable signed Stage A artifact admits this exact public SHA', () => {
    for (const name of ['deploy-web.yml', 'deploy-docs.yml']) {
      const source = workflow(name)
      const gate = source.indexOf('verify-annual-pre-public-admission')
      const deploy = source.indexOf(name === 'deploy-web.yml' ? 'name: Deploy via SSH' : 'name: Deploy to production Worker')
      expect(gate).toBeGreaterThan(-1)
      expect(deploy).toBeGreaterThan(gate)
      expect(source).toContain('private_admission_run_id')
      expect(source).toContain('private_admission_run_attempt')
      expect(source).toContain('private_admission_artifact_id')
      expect(source).toContain('actions/create-github-app-token@0f859bf9e69e887678d5bbfbee594437cb440ffe')
      expect(source).toContain('ANNUAL_PRIVATE_ADMISSION_HMAC_KEY')
      expect(source).not.toContain('BILLING_V2_CUTOVER_MANIFEST')
      expect(source).not.toContain('https://api.silentsuite.io/health/link-proof')
    }
    expect(deployRunbook).toContain('annual-only-pre-public-admission-<private-run-id>-<private-run-attempt>')
    expect(deployRunbook).toContain('ANNUAL_PRIVATE_ADMISSION_HMAC_KEY')
  })

  it.each([
    ['deploy-docs.yml', 'docs-production-${{ inputs.expected_sha }}'],
    ['deploy-docs-standalone.yml', 'docs-standalone-production-${{ inputs.expected_sha }}'],
  ])('%s builds docs once and deploys the admitted artifact after reauthorization', (name, artifactName) => {
    expectDocsBuildOnce(name, workflow(name), artifactName)
  })

  it('the standalone docs workflow mirrors deploy-docs.yml exactly except for annual admission', () => {
    expectStandaloneMirrorsAnnualDocs(workflow('deploy-docs-standalone.yml'))
  })

  it('the standalone docs workflow carries no annual admission material', () => {
    expectStandaloneCarriesNoAnnualMaterial(workflow('deploy-docs-standalone.yml'))
  })

  it('the standalone admission preflight is secretless and unconditional', () => {
    expectStandaloneAdmissionPreflight(workflow('deploy-docs-standalone.yml'))
  })

  it('the actual standalone admission program admits only a fully matching armed identity and names every refused condition', () => {
    expect(standaloneAdmissionHarnessFailures(standaloneAdmissionRun())).toEqual([])
  })

  // Program mutants prove the harness is not vacuous: each must fail the named case.
  it.each<[string, (run: string) => string, string]>([
    ['always refuse', (run) => `exit 1\n${run}`, 'fully matching armed identity'],
    ['always admit through a final exit 0', (run) => run.replace('  exit 1\nfi\necho "Admission complete', '  exit 0\nfi\necho "Admission complete'), 'approval unset'],
    ['always admit through a final true', (run) => run.replace('  exit 1\nfi\necho "Admission complete', '  true\nfi\necho "Admission complete'), 'approval unset'],
    ['fail() no longer sets refused', (run) => run.replace('fail() { echo "::error::$1"; refused=1; }', 'fail() { echo "::error::$1"; }'), 'approval unset'],
    // Function replacements: a replacement string would expand the `$'` in these patterns.
    ['format pattern accepts uppercase', (run) => run.replace("'^[0-9a-f]{40}$'", () => "'^[0-9a-fA-F]{40}$'"), 'uppercase expected_sha everywhere'],
    ['length guard removed', (run) => run.replace('[ "${#EXPECTED_SHA}" -ne 40 ] || ', ''), 'trailing-newline expected_sha everywhere'],
    ['length guard removed and pattern widened to 39-40', (run) => run.replace('[ "${#EXPECTED_SHA}" -ne 40 ] || ', '').replace("'^[0-9a-f]{40}$'", () => "'^[0-9a-f]{39,40}$'"), '39-character expected_sha everywhere'],
    ['head comparison removed', (run) => run.replace('if [ "$GITHUB_SHA" != "$EXPECTED_SHA" ]; then\n  fail "the dispatched head is not the reviewed expected_sha"\nfi\n', ''), 'dispatched head mismatch'],
    ['approval comparison removed', (run) => run.replace('elif [ "$DOCS_STANDALONE_DEPLOY_APPROVED_SHA" != "$EXPECTED_SHA" ]; then\n  fail "repository variable DOCS_STANDALONE_DEPLOY_APPROVED_SHA is armed for a different SHA than expected_sha"\n', ''), 'approval armed for another SHA'],
    ['diagnostic echoes the dispatched head', (run) => run.replace('fail "the dispatched head is not', 'fail "the dispatched head $GITHUB_SHA is not'), 'dispatched head mismatch'],
    ['unset approval defaulting removed', (run) => run.replace('DOCS_STANDALONE_DEPLOY_APPROVED_SHA="${DOCS_STANDALONE_DEPLOY_APPROVED_SHA:-}"\n', ''), 'approval unset'],
  ])('the admission harness rejects the program mutant: %s', (_label, mutate, failingCase) => {
    const run = standaloneAdmissionRun()
    const mutated = mutate(run)
    expect(mutated).not.toBe(run)
    const failures = standaloneAdmissionHarnessFailures(mutated)
    expect(failures.filter((failure) => failure.startsWith(`${failingCase}:`))).not.toEqual([])
    // Except for the always-refuse mutant, the mutant is still a working program that
    // admits the armed identity, so its rejection is specific rather than a syntax error.
    if (failingCase !== 'fully matching armed identity') {
      expect(failures.filter((failure) => failure.startsWith('fully matching armed identity:'))).toEqual([])
    }
  })

  it('the length guard alone still refuses a 39-character expected_sha when only the pattern is widened', () => {
    const run = standaloneAdmissionRun()
    const widened = run.replace("'^[0-9a-f]{40}$'", () => "'^[0-9a-f]{39,40}$'")
    expect(widened).not.toBe(run)
    expect(standaloneAdmissionHarnessFailures(widened)).toEqual([])
  })

  it('the standalone docs workflow satisfies its closed effective-controls envelope', () => {
    expect(standaloneEnvelopeViolations(parseWorkflow(workflow('deploy-docs-standalone.yml')))).toEqual([])
  })

  // Each fixture records which Stage 1 semantic contracts already reject it: [] marks a
  // genuine gap that only the envelope checker closes. Neither side consults a digest.
  it.each<[string, (source: string) => string, string, string[]]>([
    ['workflow-level Cloudflare secret env (row 25)', (source) => source.replace('\njobs:\n', '\nenv:\n  CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n\njobs:\n'), standaloneEnvelopeMessages.rootKeys, []],
    ['workflow-level BASH_ENV (row 25)', (source) => source.replace('\njobs:\n', '\nenv:\n  BASH_ENV: /tmp/startup.sh\n\njobs:\n'), standaloneEnvelopeMessages.rootKeys, []],
    ['workflow-level defaults (row 29)', (source) => source.replace('\njobs:\n', "\ndefaults:\n  run:\n    shell: 'bash --noprofile --norc -eo pipefail {0}'\n\njobs:\n"), standaloneEnvelopeMessages.rootKeys, []],
    ['workflow-level write-all permissions (row 29)', (source) => source.replace('\njobs:\n', '\npermissions: write-all\n\njobs:\n'), standaloneEnvelopeMessages.rootKeys, []],
    ['Cloudflare secret in build job env (row 26)', (source) => source.replace(standaloneJobEnvLine('build'), `${standaloneJobEnvLine('build')}      CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n`), standaloneEnvelopeMessages.jobEnv('build'), []],
    ['BASH_ENV in build job env (row 26)', (source) => source.replace(standaloneJobEnvLine('build'), `${standaloneJobEnvLine('build')}      BASH_ENV: /tmp/startup.sh\n`), standaloneEnvelopeMessages.jobEnv('build'), []],
    ['Cloudflare secret in admission job env (row 27)', (source) => source.replace('      DOCS_STANDALONE_DEPLOY_APPROVED_SHA: ${{ vars.DOCS_STANDALONE_DEPLOY_APPROVED_SHA }}\n    steps:\n', '      DOCS_STANDALONE_DEPLOY_APPROVED_SHA: ${{ vars.DOCS_STANDALONE_DEPLOY_APPROVED_SHA }}\n      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n    steps:\n'), standaloneEnvelopeMessages.jobEnv('admission'), ['admission-preflight']],
    ['Cloudflare secret in deploy job env (row 28)', (source) => source.replace(standaloneJobEnvLine('deploy'), `${standaloneJobEnvLine('deploy')}      CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n`), standaloneEnvelopeMessages.jobEnv('deploy'), []],
    ['Cloudflare secret in deploy job env (row 28) breaks secret locality', (source) => source.replace(standaloneJobEnvLine('deploy'), `${standaloneJobEnvLine('deploy')}      CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n`), standaloneEnvelopeMessages.secretLocality, []],
    ['Cloudflare secret on a non-Wrangler deploy step (row 28)', (source) => source.replace('        run: pnpm run check:public-analytics\n\n      - name: Re-assert owner approval', '        run: pnpm run check:public-analytics\n        env:\n          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n\n      - name: Re-assert owner approval'), standaloneEnvelopeMessages.secretLocality, ['mirror']],
    ['extra GH_TOKEN on a build step (row 30)', (source) => source.replace('      - name: Install dependencies\n        run: pnpm install --frozen-lockfile\n', '      - name: Install dependencies\n        run: pnpm install --frozen-lockfile\n        env:\n          GH_TOKEN: ${{ github.token }}\n'), standaloneEnvelopeMessages.githubToken, ['mirror']],
    ['secrets.GITHUB_TOKEN on a build step (row 30)', (source) => source.replace('      - name: Install dependencies\n        run: pnpm install --frozen-lockfile\n', '      - name: Install dependencies\n        run: pnpm install --frozen-lockfile\n        env:\n          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n'), standaloneEnvelopeMessages.secretLocality, ['mirror']],
    ['index-syntax Cloudflare secret on a build step', (source) => source.replace("          SILENTSUITE_HOSTED_DOCS_ANALYTICS: '1'\n", "          SILENTSUITE_HOSTED_DOCS_ANALYTICS: '1'\n          CF: ${{ secrets['CLOUDFLARE_API_TOKEN'] }}\n"), standaloneEnvelopeMessages.secretLocality, ['mirror']],
    ['build job moved to a self-hosted runner', (source) => source.replace('    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    environment: docs-production\n    permissions:\n      contents: read\n', '    runs-on: self-hosted\n    timeout-minutes: 10\n    environment: docs-production\n    permissions:\n      contents: read\n'), standaloneEnvelopeMessages.jobControls('build'), []],
    ['deploy job given a container', (source) => source.replace('    needs: build\n', '    needs: build\n    container: node:22\n'), standaloneEnvelopeMessages.jobControls('deploy'), []],
    ['deploy job given job-level run defaults', (source) => source.replace('    needs: build\n', "    needs: build\n    defaults:\n      run:\n        shell: 'bash --noprofile --norc -eo pipefail {0}'\n"), standaloneEnvelopeMessages.jobControls('deploy'), []],
    ['admission job moved to a self-hosted runner', (source) => source.replace('  admission:\n    runs-on: ubuntu-latest\n', '  admission:\n    runs-on: self-hosted\n'), standaloneEnvelopeMessages.jobControls('admission'), []],
    ['admission step given an env map', (source) => source.replace('      - name: Refuse an unarmed or mismatched standalone docs dispatch with an explicit diagnostic per condition\n        shell: bash\n', '      - name: Refuse an unarmed or mismatched standalone docs dispatch with an explicit diagnostic per condition\n        shell: bash\n        env:\n          BASH_ENV: /tmp/startup.sh\n'), standaloneEnvelopeMessages.stepEnv('admission', 0), []],
    ['workflow renamed', (source) => source.replace('name: Deploy Docs standalone (production, no annual Stage A)', 'name: Deploy Docs (production)'), standaloneEnvelopeMessages.name, ['no-annual-material']],
    ['extra dispatch input', (source) => source.replace('        type: string\n\nconcurrency:', '        type: string\n      other_sha:\n        required: false\n        type: string\n\nconcurrency:'), standaloneEnvelopeMessages.dispatch, ['no-annual-material']],
    ['concurrency group detached', (source) => source.replace('  group: deploy-docs-production\n', '  group: deploy-docs-standalone\n'), standaloneEnvelopeMessages.concurrency, ['mirror']],
    ['extra job', (source) => `${source}\n  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo extra\n`, standaloneEnvelopeMessages.jobs, ['manual-only']],
  ])('rejects a standalone envelope escape: %s', (_label, mutate, violation, stage1Rejections) => {
    const source = workflow('deploy-docs-standalone.yml')
    const mutated = mutate(source)
    expect(mutated).not.toBe(source)
    expect(standaloneStage1Rejections(mutated)).toEqual(stage1Rejections)
    expect(standaloneEnvelopeViolations(parseWorkflow(mutated))).toContain(violation)
  })

  it('runs server migrations from the exact image before replacing the server', async () => {
    const source = workflow('deploy-server.yml')
    const migrationCommand = 'run --rm --no-deps --interactive=false -T silentsuite-server python manage.py migrate --noinput'
    const migration = source.indexOf(migrationCommand)
    const replacement = source.indexOf('up -d --force-recreate --no-deps --no-build silentsuite-server')

    expect(source).toContain(migrationCommand)
    expect(source).not.toContain('run --rm --no-deps silentsuite-server python manage.py migrate --noinput')
    expect(migration).toBeGreaterThan(-1)
    expect(replacement).toBeGreaterThan(migration)
    await expect(executeStreamingDeployScript(migrationCommand)).resolves.toContain('__AFTER_MIGRATION__')
    await expect(executeStreamingDeployScript(migrationCommand.replace('--interactive=false -T ', ''))).resolves.not.toContain('__AFTER_MIGRATION__')
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

  it('deploy-web.yml verifies the SSH server host key from protected custody before the mutation', () => {
    expect(sshHostVerificationViolations(parseWorkflow(workflow('deploy-web.yml')))).toEqual([])
  })

  it.each<[string, (source: string) => string, string]>([
    ['fingerprint input removed', (source) => source.replace('          fingerprint: ${{ secrets.VPS_SSH_FINGERPRINT }}\n', ''), 'SSH mutation must bind with.fingerprint to the protected VPS_SSH_FINGERPRINT secret'],
    ['fingerprint bound to another secret', (source) => source.replace('fingerprint: ${{ secrets.VPS_SSH_FINGERPRINT }}', 'fingerprint: ${{ secrets.VPS_HOST }}'), 'SSH mutation must bind with.fingerprint to the protected VPS_SSH_FINGERPRINT secret'],
    ['fingerprint bound to an unprotected variable', (source) => source.replace('fingerprint: ${{ secrets.VPS_SSH_FINGERPRINT }}', 'fingerprint: ${{ vars.VPS_SSH_FINGERPRINT }}'), 'SSH mutation must bind with.fingerprint to the protected VPS_SSH_FINGERPRINT secret'],
    ['fingerprint with an empty fallback', (source) => source.replace('fingerprint: ${{ secrets.VPS_SSH_FINGERPRINT }}', "fingerprint: ${{ inputs.expected_sha == '' && secrets.VPS_SSH_FINGERPRINT || '' }}"), 'SSH mutation must bind with.fingerprint to the protected VPS_SSH_FINGERPRINT secret'],
    ['transport fingerprint overridden through the step environment', (source) => source.replace('          DEPLOY_SHA: ${{ github.sha }}\n', "          DEPLOY_SHA: ${{ github.sha }}\n          PLUGIN_FINGERPRINT: ''\n"), 'SSH mutation must not proxy or override the transport fingerprint'],
    ['mutable transport pin', (source) => source.replace(pinnedSshAction, 'appleboy/ssh-action@v1'), 'SSH mutation must be the single unconditional reviewed appleboy/ssh-action pin'],
    ['preflight turned into a no-op', (source) => source.replace('            exit 1\n          fi\n          echo "Protected SSH', '            true\n          fi\n          echo "Protected SSH'), 'fingerprint custody preflight must be the exact reviewed fail-closed validation'],
    ['preflight detached from the protected secret', (source) => source.replace('          VPS_SSH_FINGERPRINT: ${{ secrets.VPS_SSH_FINGERPRINT }}\n        run:', `          VPS_SSH_FINGERPRINT: SHA256:${'A'.repeat(43)}\n        run:`), 'fingerprint custody preflight must be the exact reviewed fail-closed validation'],
    ['preflight allowed to fail', (source) => source.replace(`      - name: ${sshFingerprintPreflightName}\n`, `      - name: ${sshFingerprintPreflightName}\n        continue-on-error: true\n`), 'fingerprint custody preflight must be the exact reviewed fail-closed validation'],
    ['preflight removed', (source) => source.replace(`      - name: ${sshFingerprintPreflightName}\n`, '      - name: Renamed inert step\n'), 'fingerprint custody preflight must run immediately before final authorization'],
    ['preflight reordered between final authorization and SSH', (source) => moveStep(source, sshFingerprintPreflightName, 'Deploy via SSH'), 'final authorization must remain directly adjacent to the SSH mutation'],
    ['preflight reordered ahead of the Stage A re-verification', (source) => moveStep(source, sshFingerprintPreflightName, 'Checkout exact approved commit for deployment'), 'fingerprint custody preflight must run immediately before final authorization'],
    ['reusable secret declaration removed', (source) => source.replace('      VPS_SSH_FINGERPRINT: { required: true }\n', ''), 'reusable workflow must declare VPS_SSH_FINGERPRINT as a required secret'],
    ['reusable secret made optional', (source) => source.replace('VPS_SSH_FINGERPRINT: { required: true }', 'VPS_SSH_FINGERPRINT: { required: false }'), 'reusable workflow must declare VPS_SSH_FINGERPRINT as a required secret'],
  ])('rejects an SSH host-verification bypass: %s', (_label, mutate, violation) => {
    const source = workflow('deploy-web.yml')
    const mutated = mutate(source)
    expect(mutated).not.toBe(source)
    expect(sshHostVerificationViolations(parseWorkflow(mutated))).toContain(violation)
  })

  it('the fingerprint custody preflight refuses missing or malformed values and admits one strict fingerprint', () => {
    const steps = parseWorkflow(workflow('deploy-web.yml')).jobs.deploy.steps ?? []
    const run = steps.find((step) => step.name === sshFingerprintPreflightName)?.run
    expect(run).toBeTypeOf('string')
    // A syntactically valid fingerprint of a synthetic value; it is not any real host key.
    const body = createHash('sha256').update('synthetic-ssh-host-verification-sentinel').digest('base64').replace(/=+$/, '')
    const sentinel = `SHA256:${body}`
    const refused = [
      undefined, '', `${sentinel}=`, sentinel.slice(0, -1), `${sentinel}A`, `sha256:${body}`, `MD5:${body}`, body, ` ${sentinel}`, `${sentinel} `,
      `${sentinel}\n`, `${sentinel}\n${sentinel}`, `junk\n${sentinel}`, `SHA256:${body.slice(0, -1)}B`, `SHA256:${'-'.repeat(42)}A`,
      'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99', `256 ${sentinel} synthetic (ED25519)`,
    ]
    for (const value of refused) {
      const result = runSshFingerprintPreflight(run ?? 'exit 97', value)
      expect(result.status, JSON.stringify(value)).toBe(1)
      expect(result.stderr).toContain('Refusing deploy: VPS_SSH_FINGERPRINT is missing or is not one strict unpadded SHA256 host-key fingerprint')
      expect(`${result.stdout}${result.stderr}`).not.toContain(body.slice(0, 20))
    }
    const accepted = runSshFingerprintPreflight(run ?? 'exit 97', sentinel)
    expect(accepted.status).toBe(0)
    expect(`${accepted.stdout}${accepted.stderr}`).not.toContain(body.slice(0, 20))
  })

  it('the reusable cutover caller maps exactly the secrets deploy-web.yml declares, including the host-key fingerprint', () => {
    const declared = Object.keys(parseWorkflow(workflow('deploy-web.yml')).on?.workflow_call?.secrets ?? {})
    const caller = parseWorkflow(workflow('annual-only-public-cutover.yml')).jobs['deploy-web']

    expect(declared).toContain('VPS_SSH_FINGERPRINT')
    expect(caller.uses).toBe('./.github/workflows/deploy-web.yml')
    expect(caller.secrets).toEqual(Object.fromEntries(declared.map((name) => [name, `\${{ secrets.${name} }}`])))
  })

  it('no workflow, including the annual cutover caller, invokes the standalone docs workflow', () => {
    const directory = resolve(process.cwd(), '../../.github/workflows')
    const callers = readdirSync(directory).filter((entry) => /\.ya?ml$/.test(entry))
      .flatMap((entry) => standaloneDocsCallers(entry, readFileSync(join(directory, entry), 'utf8')))

    expect(callers).toEqual([])
    expectCutoverInvokesOnlyAnnualDocs(workflow('annual-only-public-cutover.yml'))
  })

  it('rejects an annual cutover caller redirected to the standalone docs workflow (matrix row 22)', () => {
    const source = workflow('annual-only-public-cutover.yml')
    const mutated = source.replace('    uses: ./.github/workflows/deploy-docs.yml\n', '    uses: ./.github/workflows/deploy-docs-standalone.yml\n')
    expect(mutated).not.toBe(source)
    expect(standaloneDocsCallers('annual-only-public-cutover.yml', mutated)).toEqual(['annual-only-public-cutover.yml:deploy-docs'])
    expect(() => expectCutoverInvokesOnlyAnnualDocs(mutated)).toThrow()
  })

  it('binds any edit of the annual deploy-docs.yml to its unchanged digest and Stage A contract (matrix row 23)', () => {
    const source = workflow('deploy-docs.yml')
    const retimed = source.replace('    timeout-minutes: 10\n', '    timeout-minutes: 30\n')
    const ungated = removeStep(source, 'Fetch and verify exact timestamp-free Stage A before docs publication')
    for (const mutated of [retimed, ungated]) {
      expect(mutated).not.toBe(source)
      expect(sha256(JSON.stringify(parseWorkflow(mutated)))).not.toBe(workflowContracts['deploy-docs.yml'])
    }
    expectManualOnlyContract('deploy-docs.yml', source, 'docs-production', 'DOCS_DEPLOY_APPROVED_SHA', docsAuthorizationRunDigests)
    expect(() => expectManualOnlyContract('deploy-docs.yml', ungated, 'docs-production', 'DOCS_DEPLOY_APPROVED_SHA', docsAuthorizationRunDigests)).toThrow()
  })

  it('the unmutated standalone workflow satisfies every Stage 1 semantic contract', () => {
    expect(standaloneStage1Rejections(workflow('deploy-docs-standalone.yml'))).toEqual([])
  })

  it.each<[string, (source: string) => string, string]>([
    ['1: workflow_call trigger', (source) => source.replace('\n\nconcurrency:', '\n  workflow_call:\n    inputs:\n      expected_sha: { required: true, type: string }\n\nconcurrency:'), 'no-annual-material'],
    ['2: push trigger', (source) => source.replace('\n\nconcurrency:', '\n  push:\n    branches: [main]\n\nconcurrency:'), 'manual-only'],
    ['2: schedule trigger', (source) => source.replace('\n\nconcurrency:', "\n  schedule:\n    - cron: '0 3 * * *'\n\nconcurrency:"), 'no-annual-material'],
    ['3: private admission input', (source) => source.replace('        type: string\n\nconcurrency:', '        type: string\n      private_admission_run_id:\n        required: true\n        type: string\n\nconcurrency:'), 'no-annual-material'],
    ['4: build predicate without the approval clause', (source) => source.replace(' && vars.DOCS_STANDALONE_DEPLOY_APPROVED_SHA == inputs.expected_sha\n    needs: admission', '\n    needs: admission'), 'manual-only'],
    ['5: annual approval variable', (source) => source.replaceAll('DOCS_STANDALONE_DEPLOY_APPROVED_SHA', 'DOCS_DEPLOY_APPROVED_SHA'), 'no-annual-material'],
    ['6: unprotected environment', (source) => source.replace('    environment: docs-production\n', '    environment: production\n'), 'manual-only'],
    ['7: checkout of a mutable ref', (source) => source.replace('          ref: ${{ inputs.expected_sha }}', '          ref: refs/heads/main'), 'manual-only'],
    ['8: no-op final reauthorization', (source) => insertBeforeStep(removeStep(source, 'Re-assert owner approval immediately before deployment'), 'Deploy to production Worker', '      - name: Re-assert owner approval immediately before deployment\n        shell: bash\n        run: exit 0\n\n'), 'mirror'],
    ['9: step between reauthorization and mutation', (source) => insertBeforeStep(source, 'Deploy to production Worker', '      - name: Inserted step\n        run: echo inserted\n\n'), 'no-annual-material'],
    ['10: mutation allowed to fail', (source) => source.replace('      - name: Deploy to production Worker\n', '      - name: Deploy to production Worker\n        continue-on-error: true\n'), 'no-annual-material'],
    ['11: rebuild in the deploy job', (source) => source.replace('        run: pnpm run check:public-analytics\n\n      - name: Re-assert owner approval', '        run: pnpm run check:public-analytics && pnpm run build\n\n      - name: Re-assert owner approval'), 'build-once'],
    ['12: download-artifact action in the deploy job', (source) => insertBeforeStep(source, 'Download and verify admitted docs artifact', '      - name: Download through the action\n        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c\n        with:\n          name: docs-standalone-production-${{ inputs.expected_sha }}\n\n'), 'build-once'],
    ['13: digest comparison removed', (source) => source.replace('          test "$ACTUAL_ARTIFACT_DIGEST" = "$EXPECTED_ARTIFACT_DIGEST"\n', ''), 'build-once'],
    ['14: annual artifact name', (source) => source.replace('name: docs-standalone-production-${{ inputs.expected_sha }}', 'name: annual-only-pre-public-admission-${{ inputs.expected_sha }}'), 'no-annual-material'],
    ['15: annual HMAC secret env', (source) => source.replace("          SILENTSUITE_HOSTED_DOCS_ANALYTICS: '1'\n", "          SILENTSUITE_HOSTED_DOCS_ANALYTICS: '1'\n          ANNUAL_PRIVATE_ADMISSION_HMAC_KEY: ${{ secrets.ANNUAL_PRIVATE_ADMISSION_HMAC_KEY }}\n"), 'no-annual-material'],
    ['16: App token step', (source) => insertBeforeStep(source, 'Test Android distribution documentation', '      - name: Mint token\n        uses: actions/create-github-app-token@0f859bf9e69e887678d5bbfbee594437cb440ffe\n        with:\n          owner: silent-suite\n\n'), 'no-annual-material'],
    ['17: analytics check dropped before build', (source) => removeStep(source, 'Verify public analytics and relay contract before build'), 'mirror'],
    ['18: billing copy guard dropped', (source) => removeStep(source, 'Enforce annual billing copy'), 'mirror'],
    ['19: mutable action tag', (source) => source.replace('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/checkout@v7'), 'mirror'],
    ['20: admission granted repository read', (source) => source.replace('    permissions: {}\n', '    permissions:\n      contents: read\n'), 'admission-preflight'],
    ['21: build detached from admission', (source) => source.replace('    needs: admission\n', ''), 'mirror'],
  ])('rejects standalone docs admission drift, matrix row %s', (_label, mutate, rejector) => {
    const source = workflow('deploy-docs-standalone.yml')
    const mutated = mutate(source)
    expect(mutated).not.toBe(source)
    expect(standaloneStage1Rejections(mutated)).toContain(rejector)
  })

  it('rejects a duplicate standalone environment key before any contract can read it (matrix row 24)', () => {
    const source = workflow('deploy-docs-standalone.yml')
    const mutated = source.replace('    environment: docs-production\n', '    environment: docs-production\n    environment: attacker\n')
    expect(mutated).not.toBe(source)
    expect(() => parseWorkflow(mutated)).toThrow()
    expect(standaloneStage1Rejections(mutated)).toEqual(Object.keys(standaloneStage1Contracts))
  })

  it('documents that Web dispatch is blocked until the host-key fingerprint is commissioned from trusted custody', () => {
    expect(deployRunbook).toContain('## SSH server verification for the Web mutation')
    expect(deployRunbook).toContain('Web production dispatch, standalone or through the annual public cutover, is blocked until `VPS_SSH_FINGERPRINT` is commissioned')
    expect(deployRunbook).toContain('Never derive the value from a fresh unauthenticated `ssh-keyscan`')
    expect(deployRunbook).toContain('do not remove, blank, or bypass the fingerprint to recover')
    expect(deployRunbook).toContain('A names-only secret inventory does not verify the value')
  })

  it('documents standalone Docs admission as a component deployment that is never annual proof', () => {
    expect(deployRunbook).toContain('## Standalone Docs admission (no annual Stage A)')
    expect(deployRunbook).toContain('Deploy Docs standalone (production, no annual Stage A)')
    expect(deployRunbook).toContain('A standalone Docs deployment is a component deployment, not an annual cutover; it produces no Stage A, Stage B, or final manifest and must never be cited as annual proof')
    expect(deployRunbook).toContain('Clear `DOCS_STANDALONE_DEPLOY_APPROVED_SHA` after the run reaches a terminal state; clearing affects only future runs.')
  })
})
