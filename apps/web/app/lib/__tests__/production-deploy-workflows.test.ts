import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import { parseDocument, stringify } from 'yaml'

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

function expectAuthorizedJob(job: WorkflowJob, environment: string, approvalVariable: string, authorizationName: string, expectedRunSha256: string, expectedPredicate?: string) {
  const steps = job.steps ?? []
  expect(job.if).toBe(
    expectedPredicate ?? `github.ref == 'refs/heads/main' && github.sha == inputs.expected_sha && vars.${approvalVariable} == inputs.expected_sha`,
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

// Complete parsed-object binding and separately readable effective controls for standalone Web.
const standaloneWebWorkflowDigest = 'c30d62b61b238a1c8432c5d5a980f3a8b6902d4cc2500efacfffbf2eb759a1d6'
const standaloneWebAuthorizationDigest = 'b7eb5ce5bef0fba7ece1736fee05cbf1b4cfd86b27d3a88ef6320c130774a069'
const standaloneWebPredicates = {
  "build": "needs.admission.result == 'success' && github.event_name == 'workflow_dispatch' && github.repository == 'silent-suite/silentsuite' && github.ref == 'refs/heads/main' && github.sha == inputs.expected_sha && github.workflow_sha == inputs.expected_sha && vars.WEB_STANDALONE_DEPLOY_APPROVED_SHA == inputs.expected_sha",
  "deploy": "needs['build-and-push'].result == 'success' && github.event_name == 'workflow_dispatch' && github.repository == 'silent-suite/silentsuite' && github.ref == 'refs/heads/main' && github.sha == inputs.expected_sha && github.workflow_sha == inputs.expected_sha && vars.WEB_STANDALONE_DEPLOY_APPROVED_SHA == inputs.expected_sha"
}
const standaloneWebControls = {
  "name": "Deploy Web standalone (production, no annual Stage A)",
  "on": {
    "workflow_dispatch": {
      "inputs": {
        "expected_sha": {
          "description": "Exact reviewed live main commit to build and deploy",
          "required": true,
          "type": "string"
        }
      }
    }
  },
  "concurrency": {
    "group": "deploy-web-production",
    "cancel-in-progress": false
  },
  "env": {
    "IMAGE_NAME": "ghcr.io/silent-suite/silentsuite-web"
  },
  "jobs": {
    "admission": {
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 5,
      "permissions": {},
      "env": {
        "EXPECTED_SHA": "${{ inputs.expected_sha }}",
        "WEB_STANDALONE_DEPLOY_APPROVED_SHA": "${{ vars.WEB_STANDALONE_DEPLOY_APPROVED_SHA }}"
      },
      "steps": [
        {
          "name": "Refuse an unarmed or mismatched standalone Web dispatch",
          "shell": "bash",
          "run": "<reviewed shell program>"
        }
      ]
    },
    "build-and-push": {
      "if": "needs.admission.result == 'success' && github.event_name == 'workflow_dispatch' && github.repository == 'silent-suite/silentsuite' && github.ref == 'refs/heads/main' && github.sha == inputs.expected_sha && github.workflow_sha == inputs.expected_sha && vars.WEB_STANDALONE_DEPLOY_APPROVED_SHA == inputs.expected_sha",
      "needs": "admission",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 35,
      "environment": "web-production",
      "permissions": {
        "contents": "read",
        "packages": "write"
      },
      "outputs": {
        "image-digest": "${{ steps.publish.outputs.image-digest }}",
        "image-config-id": "${{ steps.publish.outputs.image-config-id }}",
        "image-revision": "${{ steps.publish.outputs.image-revision }}"
      },
      "env": {
        "WEB_STANDALONE_DEPLOY_APPROVED_SHA": "${{ vars.WEB_STANDALONE_DEPLOY_APPROVED_SHA }}",
        "DOCKER_BUILD_SUMMARY": "false",
        "DOCKER_BUILD_RECORD_UPLOAD": "false",
        "DOCKER_BUILD_CHECKS_ANNOTATIONS": "false"
      },
      "steps": [
        {
          "name": "Checkout exact standalone Web commit for build",
          "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          "with": {
            "ref": "${{ inputs.expected_sha }}",
            "fetch-depth": 0,
            "persist-credentials": false
          }
        },
        {
          "name": "Assert this is the live main commit",
          "shell": "bash",
          "env": {
            "EXPECTED_SHA": "${{ inputs.expected_sha }}",
            "GH_TOKEN": "${{ github.token }}"
          },
          "run": "<reviewed shell program>"
        },
        {
          "name": "Setup pnpm",
          "uses": "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86"
        },
        {
          "name": "Setup Node.js",
          "uses": "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
          "with": {
            "node-version": "22",
            "cache": "pnpm"
          }
        },
        {
          "name": "Install frozen dependencies",
          "shell": "bash",
          "run": "<reviewed shell program>"
        },
        {
          "name": "Enforce billing copy",
          "shell": "bash",
          "run": "<reviewed shell program>"
        },
        {
          "name": "Verify public analytics and privacy boundary",
          "shell": "bash",
          "run": "<reviewed shell program>"
        },
        {
          "name": "Audit dependencies",
          "shell": "bash",
          "run": "<reviewed shell program>"
        },
        {
          "name": "Test source and deployment boundaries",
          "shell": "bash",
          "run": "<reviewed shell program>"
        },
        {
          "name": "Validate production arguments before build",
          "shell": "bash",
          "env": {
            "WEB_BUILD_ARGS": "NEXT_PUBLIC_BILLING_API_URL=https://api.silentsuite.io\nNEXT_PUBLIC_ETEBASE_SERVER_URL=https://server.silentsuite.io\nNEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=${{ secrets.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY }}\nNEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED=true\nNEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED=true\nNEXT_PUBLIC_LOCAL_CACHE_ENABLED=false\nNEXT_PUBLIC_SELF_HOSTED=false\nNEXT_PUBLIC_OWNER_REGISTRATION=false\nVCS_REF=${{ inputs.expected_sha }}",
            "NEXT_PUBLIC_APP_STRIPE_PUBLISHABLE_KEY": "${{ secrets.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY }}",
            "EXPECTED_SHA": "${{ inputs.expected_sha }}"
          },
          "run": "<reviewed shell program>"
        },
        {
          "name": "Setup Docker Buildx",
          "uses": "docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c"
        },
        {
          "name": "Build Web image once",
          "id": "image",
          "uses": "docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a",
          "env": {
            "WEB_BUILD_ARGS": "NEXT_PUBLIC_BILLING_API_URL=https://api.silentsuite.io\nNEXT_PUBLIC_ETEBASE_SERVER_URL=https://server.silentsuite.io\nNEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=${{ secrets.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY }}\nNEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED=true\nNEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED=true\nNEXT_PUBLIC_LOCAL_CACHE_ENABLED=false\nNEXT_PUBLIC_SELF_HOSTED=false\nNEXT_PUBLIC_OWNER_REGISTRATION=false\nVCS_REF=${{ inputs.expected_sha }}"
          },
          "with": {
            "context": ".",
            "file": "Dockerfile.web",
            "platforms": "linux/amd64",
            "push": false,
            "load": true,
            "tags": "${{ env.IMAGE_NAME }}:standalone-${{ inputs.expected_sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
            "provenance": false,
            "sbom": false,
            "build-args": "${{ env.WEB_BUILD_ARGS }}"
          }
        },
        {
          "name": "Verify exact production image before publication",
          "shell": "bash",
          "env": {
            "WEB_BUILD_ARGS": "NEXT_PUBLIC_BILLING_API_URL=https://api.silentsuite.io\nNEXT_PUBLIC_ETEBASE_SERVER_URL=https://server.silentsuite.io\nNEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=${{ secrets.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY }}\nNEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED=true\nNEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED=true\nNEXT_PUBLIC_LOCAL_CACHE_ENABLED=false\nNEXT_PUBLIC_SELF_HOSTED=false\nNEXT_PUBLIC_OWNER_REGISTRATION=false\nVCS_REF=${{ inputs.expected_sha }}",
            "NEXT_PUBLIC_APP_STRIPE_PUBLISHABLE_KEY": "${{ secrets.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY }}",
            "TESTED_SHA": "${{ inputs.expected_sha }}",
            "PR_HEAD_SHA": "",
            "EVENT_NAME": "${{ github.event_name }}",
            "EXPECTED_SHA": "${{ inputs.expected_sha }}",
            "WEB_IMAGE_ID": "${{ steps.image.outputs.imageid }}"
          },
          "run": "<reviewed shell program>"
        },
        {
          "name": "Login to GHCR",
          "uses": "docker/login-action@dbcb813823bdd20940b903addbd779551569679f",
          "with": {
            "registry": "ghcr.io",
            "username": "${{ github.actor }}",
            "password": "${{ secrets.GITHUB_TOKEN }}"
          }
        },
        {
          "name": "Re-assert live main immediately before publication",
          "shell": "bash",
          "env": {
            "EXPECTED_SHA": "${{ inputs.expected_sha }}",
            "GH_TOKEN": "${{ github.token }}"
          },
          "run": "<reviewed shell program>"
        },
        {
          "name": "Publish verified image and bind registry identity",
          "id": "publish",
          "shell": "bash",
          "env": {
            "EXPECTED_SHA": "${{ inputs.expected_sha }}",
            "VERIFIED_IMAGE_ID": "${{ steps.image.outputs.imageid }}"
          },
          "run": "<reviewed shell program>"
        }
      ]
    },
    "deploy": {
      "if": "needs['build-and-push'].result == 'success' && github.event_name == 'workflow_dispatch' && github.repository == 'silent-suite/silentsuite' && github.ref == 'refs/heads/main' && github.sha == inputs.expected_sha && github.workflow_sha == inputs.expected_sha && vars.WEB_STANDALONE_DEPLOY_APPROVED_SHA == inputs.expected_sha",
      "needs": "build-and-push",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 20,
      "environment": "web-production",
      "permissions": {
        "contents": "read"
      },
      "env": {
        "WEB_STANDALONE_DEPLOY_APPROVED_SHA": "${{ vars.WEB_STANDALONE_DEPLOY_APPROVED_SHA }}"
      },
      "steps": [
        {
          "name": "Checkout exact standalone Web commit for deployment",
          "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          "with": {
            "ref": "${{ inputs.expected_sha }}",
            "fetch-depth": 0,
            "persist-credentials": false
          }
        },
        {
          "name": "Validate immutable build handoff",
          "shell": "bash",
          "env": {
            "EXPECTED_SHA": "${{ inputs.expected_sha }}",
            "IMAGE_DIGEST": "${{ needs.build-and-push.outputs.image-digest }}",
            "IMAGE_CONFIG_ID": "${{ needs.build-and-push.outputs.image-config-id }}",
            "IMAGE_REVISION": "${{ needs.build-and-push.outputs.image-revision }}"
          },
          "run": "<reviewed shell program>"
        },
        {
          "name": "Require protected SSH host-key fingerprint before final authorization",
          "shell": "bash",
          "env": {
            "VPS_SSH_FINGERPRINT": "${{ secrets.VPS_SSH_FINGERPRINT }}"
          },
          "run": "<reviewed shell program>"
        },
        {
          "name": "Re-assert live main immediately before deployment",
          "shell": "bash",
          "env": {
            "EXPECTED_SHA": "${{ inputs.expected_sha }}",
            "GH_TOKEN": "${{ github.token }}"
          },
          "run": "<reviewed shell program>"
        },
        {
          "name": "Deploy via SSH",
          "uses": "appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2",
          "env": {
            "IMAGE_NAME": "${{ env.IMAGE_NAME }}",
            "DEPLOY_SHA": "${{ inputs.expected_sha }}",
            "IMAGE_DIGEST": "${{ needs.build-and-push.outputs.image-digest }}",
            "IMAGE_CONFIG_ID": "${{ needs.build-and-push.outputs.image-config-id }}"
          },
          "with": {
            "host": "${{ secrets.VPS_HOST }}",
            "username": "${{ secrets.VPS_USER }}",
            "key": "${{ secrets.VPS_SSH_KEY }}",
            "fingerprint": "${{ secrets.VPS_SSH_FINGERPRINT }}",
            "timeout": "30s",
            "command_timeout": "15m",
            "envs": "IMAGE_NAME,DEPLOY_SHA,IMAGE_DIGEST,IMAGE_CONFIG_ID",
            "script": "<reviewed remote program>"
          }
        },
        {
          "name": "Verify public served identity from the runner",
          "shell": "bash",
          "env": {
            "EXPECTED_SHA": "${{ inputs.expected_sha }}"
          },
          "run": "<reviewed shell program>"
        }
      ]
    }
  }
}
const standaloneWebPolicyPrograms: Record<string, string> = {
  "Install frozen dependencies": "pnpm install --frozen-lockfile",
  "Enforce billing copy": "pnpm run check:billing-copy",
  "Verify public analytics and privacy boundary": "pnpm run check:public-analytics",
  "Audit dependencies": "pnpm run audit:security",
  "Test source and deployment boundaries": "pnpm run test\npnpm --filter @silentsuite/web test app/lib/__tests__/production-deploy-workflows.test.ts\nnode --test scripts/verify-web-image.test.mjs",
  "Verify exact production image before publication": "node scripts/verify-web-image.mjs"
}

function standaloneWebControlEnvelope(parsed: ParsedWorkflow) {
  const copy = JSON.parse(JSON.stringify(parsed)) as ParsedWorkflow
  for (const job of Object.values(copy.jobs)) {
    for (const step of job.steps ?? []) {
      if ('run' in step) { expect(typeof step.run).toBe('string'); step.run = '<reviewed shell program>' }
      if (step.with && 'script' in step.with) {
        expect(typeof step.with.script).toBe('string')
        step.with.script = '<reviewed remote program>'
      }
    }
  }
  return copy
}

function expectStandaloneWebContract(source: string) {
  const parsed = parseWorkflow(source)
  expect(standaloneWebControlEnvelope(parsed)).toEqual(standaloneWebControls)
  expectManualOnlyContract('deploy-web-standalone.yml', source, 'web-production', 'WEB_STANDALONE_DEPLOY_APPROVED_SHA',
    [standaloneWebAuthorizationDigest, standaloneWebAuthorizationDigest], standaloneWebPredicates)
  const build = parsed.jobs['build-and-push']
  expectAuthorizedJob(build, 'web-production', 'WEB_STANDALONE_DEPLOY_APPROVED_SHA',
    'Re-assert live main immediately before publication', standaloneWebAuthorizationDigest, standaloneWebPredicates.build)
  for (const [name, run] of Object.entries(standaloneWebPolicyPrograms)) {
    expect(build.steps?.find(step => step.name === name)?.run).toBe(run)
  }
  const publication = build.steps?.findIndex(step => step.name === 'Publish verified image and bind registry identity') ?? -1
  expect(publication).toBe((build.steps?.length ?? 0) - 1)
  expect(build.steps?.[publication - 1]?.name).toBe('Re-assert live main immediately before publication')
  const deploy = parsed.jobs.deploy.steps ?? []
  // The runner-side identity check follows the only mutation; it cannot authorize or mutate.
  expect(deploy.at(-1)?.name).toBe('Verify public served identity from the runner')
  expect(deploy.at(-1)?.uses).toBeUndefined()
  expect(deploy.at(-1)?.run).toContain('.publicSha == $sha')
  expect(deploy.at(-1)?.run).not.toMatch(/secrets\.|ssh|docker/)
  expect(deploy.at(-2)?.uses).toBe(pinnedSshAction)
  expect(deploy.at(-3)?.name).toBe('Re-assert live main immediately before deployment')
  expect(deploy.at(-4)?.name).toBe(sshFingerprintPreflightName)
  expect(source).not.toMatch(/ANNUAL_|annual-only|private_admission|create-github-app-token|verify-annual-pre-public-admission|secrets:\s*inherit/)
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
function expectManualOnlyContract(name: string, source: string, environment: string, approvalVariable: string, runDigests: string[], standaloneWebAdmission?: { build: string; deploy: string }) {
  const parsed = parseWorkflow(source)
  const docs = name === 'deploy-docs.yml' || name === 'deploy-docs-standalone.yml'
  const jobNames = standaloneWebAdmission ? ['admission', 'build-and-push', 'deploy'] : name === 'deploy-docs-standalone.yml' ? ['admission', 'build', 'deploy'] : docs ? ['build', 'deploy'] : ['build-and-push', 'deploy']
  expect(Object.keys(parsed.jobs).sort()).toEqual([...jobNames].sort())

  expect(source).toContain('workflow_dispatch:')
  expect(source).toContain('expected_sha:')
  expect(source).not.toMatch(/^  push:/m)
  if (name === 'deploy-web-standalone.yml') {
    expect(Object.keys(parsed.on ?? {})).toEqual(['workflow_dispatch'])
  }
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
    expectAuthorizedJob(parsed.jobs[jobName], environment, approvalVariable, authorizationName, runDigests[index], standaloneWebAdmission?.[jobName === 'deploy' ? 'deploy' : 'build'])
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

// Execute the real parsed SSH scalar against owned synthetic transports only.
// Until the standalone workflow exists, deploy-web.yml is the old-source witness;
// its successful root-only health check must not define standalone acceptance.
const webCutoverIdentities = {
  imageName: 'ghcr.io/silent-suite/silentsuite-web',
  candidateSha: 'a'.repeat(40), previousSha: 'b'.repeat(40), wrongSha: 'c'.repeat(40),
  manifestDigest: 'sha256:' + 'd'.repeat(64),
  candidateConfigId: 'sha256:' + 'e'.repeat(64), previousConfigId: 'sha256:' + 'f'.repeat(64),
}

type WebCutoverTrace = {
  command: string
  args: string[]
  operation?: string
  service?: string
  target?: string
  returned?: string
  imageId?: string
  revision?: string
  publicSha?: string
}

// The production deploy host has no jq. 'absent' runs the script with PATH limited to
// the synthetic transports plus an explicit allowlist of real system tools without jq;
// 'broken' additionally shadows jq with an executable that exits 127.
const remoteHostTools = ['bash', 'timeout', 'mktemp', 'rm', 'cat', 'grep', 'python3']

type WebCutoverOptions = {
  // Start with the failed candidate running and serving a wrong identity (post-SSH failure).
  failedCandidateRunning?: boolean
  env?: Record<string, string>
}

function runWebCutoverFixture(script: string, wrongPublicSha: boolean, remoteJq?: 'absent' | 'broken', options: WebCutoverOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'silentsuite-web-cutover-'))
  const bin = join(directory, 'bin')
  const tools = join(directory, 'tools')
  const fixtureHome = join(directory, 'home')
  const fixtureTmp = join(directory, 'tmp')
  const stateFile = join(directory, 'state.json')
  const traceFile = join(directory, 'trace.jsonl')
  const config = { ...webCutoverIdentities, directory, stateFile, traceFile, wrongPublicSha }
  const program = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const config = JSON.parse(process.env.WEB_CUTOVER_FIXTURE)
const command = path.basename(process.argv[1])
const args = process.argv.slice(2)
const state = JSON.parse(fs.readFileSync(config.stateFile, 'utf8'))
const exactImage = config.imageName + '@' + config.manifestDigest
const rollbackTag = config.imageName + ':rollback-' + config.candidateSha
const record = extra => fs.appendFileSync(config.traceFile, JSON.stringify({ command, args, imageId: state.imageId,
  revision: state.revision, publicSha: state.publicSha, ...extra }) + '\n')
const refuse = () => { throw new Error('unsupported synthetic ' + command + ' arguments') }
const same = expected => JSON.stringify(args) === JSON.stringify(expected)
const owned = file => {
  const resolved = fs.realpathSync(file)
  if (!resolved.startsWith(config.directory + path.sep)) refuse()
  return resolved
}
try {
  if (command === 'docker') {
    if (same(['compose', 'ps', '-q', 'web'])) {
      record({ operation: 'container' })
      process.stdout.write(state.containerId + '\n')
    } else if (same(['pull', exactImage])) {
      record({ operation: 'pull' })
    } else if (same(['tag', config.previousConfigId, rollbackTag])) {
      state.rollbackTagged = true
      fs.writeFileSync(config.stateFile, JSON.stringify(state))
      record({ operation: 'tag-predecessor' })
    } else if (args.length === 4 && args[0] === 'inspect' && args[2] === '--format') {
      const target = args[1], format = args[3]
      const container = target === state.containerId
      // Cached predecessor by config ID, or its local restore tag once tagged.
      const predecessor = target === config.previousConfigId || (target === rollbackTag && state.rollbackTagged)
      if (!container && !predecessor && /^sha256:[0-9a-f]{64}$/.test(target)) {
        record({ operation: 'missing-image' })
        process.stderr.write('Error: No such object: ' + target + '\n')
        process.exit(1)
      }
      if (!container && !predecessor && target !== exactImage) refuse()
      const imageId = container ? state.imageId : predecessor ? config.previousConfigId : config.candidateConfigId
      const revision = container ? state.revision : predecessor ? config.previousSha : config.candidateSha
      let value, operation
      if (container && format === '{{.Image}}') {
        value = imageId; operation = 'running-config'
      } else if (!container && format === '{{.Id}}') {
        value = imageId; operation = 'pulled-config'
      } else if (format === '{{ index .Config.Labels "org.opencontainers.image.revision" }}') {
        value = revision; operation = container ? 'running-revision' : 'pulled-revision'
      } else refuse()
      record({ operation, returned: value })
      process.stdout.write(value + '\n')
    } else if (args.length === 11 && args[0] === 'compose' && args[1] === '-f' && args[2] === 'docker-compose.yml' &&
      args[3] === '-f' && JSON.stringify(args.slice(5)) === JSON.stringify(['up', '-d', '--force-recreate', '--no-deps', '--no-build', 'web'])) {
      const override = fs.readFileSync(owned(args[4]), 'utf8')
      const match = /^services:\n  web:\n    image: (\S+)\n$/.exec(override)
      if (!match || (match[1] !== exactImage && match[1] !== rollbackTag)) refuse()
      const previous = match[1] === rollbackTag
      if (previous && !state.rollbackTagged) refuse()
      state.containerId = (previous ? '3' : '2').repeat(64)
      state.imageId = previous ? config.previousConfigId : config.candidateConfigId
      state.revision = previous ? config.previousSha : config.candidateSha
      state.publicSha = previous ? config.previousSha : config.wrongPublicSha ? config.wrongSha : config.candidateSha
      fs.writeFileSync(config.stateFile, JSON.stringify(state))
      record({ operation: 'recreate', service: 'web', target: previous ? 'predecessor' : 'candidate' })
    } else refuse()
  } else if (command === 'curl') {
    let url, output, headers, writeOut
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (['-sf', '-fsS', '-sSf', '-f', '-s', '-S', '--fail', '--silent', '--show-error'].includes(arg)) continue
      if (['--proto', '--connect-timeout', '--max-time', '-H', '--header'].includes(arg)) {
        const value = args[++i]
        if (!value) refuse()
        if (arg === '--proto' && value !== '=https') refuse()
        if ((arg === '-H' || arg === '--header') && value !== 'Cache-Control: no-cache') refuse()
        if ((arg === '--connect-timeout' || arg === '--max-time') && !/^[1-9][0-9]?$/.test(value)) refuse()
      } else if (arg === '-o' || arg === '--output') output = args[++i]
      else if (arg === '-D' || arg === '--dump-header') headers = args[++i]
      else if (arg === '-w' || arg === '--write-out') writeOut = args[++i]
      else if (arg === 'https://app.silentsuite.io/' || arg === 'https://app.silentsuite.io/api/deployment-identity') {
        if (url) refuse()
        url = arg
      } else refuse()
    }
    if (!url || (writeOut !== undefined && writeOut !== '%{http_code}')) refuse()
    const identity = url.endsWith('/api/deployment-identity')
    const body = identity ? JSON.stringify({ publicSha: state.publicSha }) + '\n' : 'synthetic healthy root\n'
    const header = 'HTTP/1.1 200 OK\r\nCache-Control: no-store, max-age=0\r\nContent-Type: application/json\r\n\r\n'
    if (headers) fs.writeFileSync(owned(headers), header)
    if (output && output !== '/dev/null') fs.writeFileSync(owned(output), body)
    else if (!output) process.stdout.write(body)
    if (writeOut) process.stdout.write('200')
    record({ operation: identity ? 'http-identity' : 'http-root', returned: '200' })
  } else if (command === 'sleep' && args.length === 1 && /^(?:[0-9]|10)$/.test(args[0])) {
    record({ operation: 'no-wait' })
  } else refuse()
} catch (error) {
  record({ operation: 'unsupported' })
  process.stderr.write(error.message + '\n')
  process.exitCode = 64
}
`
  try {
    mkdirSync(bin)
    mkdirSync(join(fixtureHome, 'etebase'), { recursive: true })
    mkdirSync(fixtureTmp)
    writeFileSync(stateFile, JSON.stringify(options.failedCandidateRunning ? {
      containerId: '2'.repeat(64), imageId: config.candidateConfigId,
      revision: config.candidateSha, publicSha: config.wrongSha, rollbackTagged: false,
    } : {
      containerId: '1'.repeat(64), imageId: config.previousConfigId,
      revision: config.previousSha, publicSha: config.previousSha, rollbackTagged: false,
    }))
    writeFileSync(traceFile, '')
    for (const name of ['docker', 'curl', 'sleep']) {
      const path = join(bin, name)
      writeFileSync(path, '#!' + process.execPath + '\n' + program)
      chmodSync(path, 0o700)
    }
    let fixturePath = bin + ':/usr/bin:/bin'
    let jqResolution: number | null | undefined
    if (remoteJq) {
      mkdirSync(tools)
      for (const name of remoteHostTools) {
        const real = ['/usr/bin', '/bin'].map(root => join(root, name)).find(candidate => existsSync(candidate))
        if (!real) throw new Error('fixture host lacks required real tool: ' + name)
        symlinkSync(real, join(tools, name))
      }
      if (remoteJq === 'broken') {
        const jq = join(bin, 'jq')
        writeFileSync(jq, '#!/bin/sh\nprintf \'%s\\n\' \'{"command":"jq","args":[],"operation":"nonworking-jq"}\' >> ' +
          JSON.stringify(traceFile) + '\necho "jq: synthetic nonworking dependency" >&2\nexit 127\n')
        chmodSync(jq, 0o700)
      }
      fixturePath = bin + ':' + tools
      jqResolution = spawnSync(join(tools, 'bash'), ['--noprofile', '--norc', '-c', 'command -v jq >/dev/null'],
        { env: { PATH: fixturePath }, encoding: 'utf8' }).status
    }
    const result = spawnSync(remoteJq ? join(tools, 'bash') : 'bash', ['--noprofile', '--norc', '-se'], {
      input: script, cwd: fixtureHome, encoding: 'utf8', timeout: 8000,
      env: {
        PATH: fixturePath, HOME: fixtureHome, TMPDIR: fixtureTmp, LC_ALL: 'C',
        WEB_CUTOVER_FIXTURE: JSON.stringify(config), IMAGE_NAME: config.imageName,
        DEPLOY_SHA: config.candidateSha, IMAGE_DIGEST: config.manifestDigest, IMAGE_CONFIG_ID: config.candidateConfigId,
        ...options.env,
      },
    })
    const trace = readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) as WebCutoverTrace[]
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { imageId: string; revision: string; publicSha: string }
    return { result, trace, state, jqResolution }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const standaloneWebArmedEnvironment: Record<string, string> = {
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'silent-suite/silentsuite',
  GITHUB_WORKFLOW_REF: 'silent-suite/silentsuite/.github/workflows/deploy-web-standalone.yml@refs/heads/main',
  GITHUB_WORKFLOW_SHA: admittedSha, GITHUB_REF: 'refs/heads/main', GITHUB_SHA: admittedSha,
  EXPECTED_SHA: admittedSha, WEB_STANDALONE_DEPLOY_APPROVED_SHA: admittedSha,
}

function runStandaloneWebProgram(run: string, changes: Record<string, string | undefined> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'silentsuite-web-authorize-'))
  try {
    const git = join(directory, 'git')
    writeFileSync(git, String.raw`#!/bin/sh
case "$*" in
  'fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main') exit 0 ;;
  'rev-parse origin/main') printf '%s\n' "$FIXTURE_MAIN_SHA" ;;
  'rev-parse HEAD') printf '%s\n' "$FIXTURE_CHECKOUT_SHA" ;;
  *) echo 'unsupported synthetic Git invocation' >&2; exit 64 ;;
esac
`)
    chmodSync(git, 0o700)
    const env: Record<string, string> = {
      PATH: directory + ':/usr/bin:/bin', ...standaloneWebArmedEnvironment,
      GH_TOKEN: 'synthetic-contents-read', FIXTURE_MAIN_SHA: admittedSha, FIXTURE_CHECKOUT_SHA: admittedSha,
    }
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined) delete env[name]
      else env[name] = value
    }
    return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run], { env, encoding: 'utf8', timeout: 2000 })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const standaloneWebAdmissionCases: [string, Record<string, string | undefined>][] = [
  ['unarmed', { WEB_STANDALONE_DEPLOY_APPROVED_SHA: undefined }],
  ['empty approval', { WEB_STANDALONE_DEPLOY_APPROVED_SHA: '' }],
  ['wrong approval', { WEB_STANDALONE_DEPLOY_APPROVED_SHA: otherSha }],
  ['Annual-only arming', { WEB_STANDALONE_DEPLOY_APPROVED_SHA: undefined, WEB_DEPLOY_APPROVED_SHA: admittedSha, ANNUAL_PUBLIC_CUTOVER_APPROVED_SHA: admittedSha }],
  ['event', { GITHUB_EVENT_NAME: 'push' }],
  ['ref', { GITHUB_REF: 'refs/heads/attacker' }],
  ['repository', { GITHUB_REPOSITORY: 'silent-suite/other' }],
  ['workflow path', { GITHUB_WORKFLOW_REF: 'silent-suite/silentsuite/.github/workflows/deploy-web.yml@refs/heads/main' }],
  ['workflow source', { GITHUB_WORKFLOW_SHA: otherSha }],
  ['dispatch head', { GITHUB_SHA: otherSha }],
  ['unset expected', { EXPECTED_SHA: undefined }],
  ...['', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40), admittedSha + '\n', admittedSha + '\n' + admittedSha]
    .map(value => ['malformed ' + JSON.stringify(value), { EXPECTED_SHA: value, GITHUB_SHA: value, GITHUB_WORKFLOW_SHA: value, WEB_STANDALONE_DEPLOY_APPROVED_SHA: value }] as [string, Record<string, string>]),
]

function standaloneWebProgramFailures(run: string, authorization: boolean): string[] {
  const failures: string[] = []
  const control = runStandaloneWebProgram(run)
  if (control.error || control.status !== 0) failures.push('matching armed control')
  const cases = authorization ? [
    ...standaloneWebAdmissionCases,
    ['moved main', { FIXTURE_MAIN_SHA: otherSha }] as [string, Record<string, string>],
    ['wrong checkout', { FIXTURE_CHECKOUT_SHA: otherSha }] as [string, Record<string, string>],
  ] : standaloneWebAdmissionCases
  for (const [name, changes] of cases) {
    const result = runStandaloneWebProgram(run, changes)
    if (result.error || result.signal || result.status === 0 || result.stderr.includes('unsupported synthetic')) failures.push(name)
  }
  return failures
}

function runWebPublicationFixture(script: string, corruptConfig = false) {
  const directory = mkdtempSync(join(tmpdir(), 'silentsuite-web-publication-'))
  const bin = join(directory, 'bin')
  const output = join(directory, 'output')
  const trace = join(directory, 'trace')
  const imageId = 'sha256:' + 'e'.repeat(64)
  const sha = admittedSha, imageName = webCutoverIdentities.imageName
  const manifest = JSON.stringify({
    schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { digest: corruptConfig ? 'sha256:' + '9'.repeat(64) : imageId },
  })
  const manifestDigest = 'sha256:' + sha256(manifest)
  const config = { sha, imageName, imageId, manifest, manifestDigest, output, trace,
    imageRef: imageName + ':standalone-' + sha + '-7-1' }
  const program = String.raw`
const fs = require('node:fs')
const c = JSON.parse(process.env.WEB_PUBLICATION_FIXTURE)
const args = process.argv.slice(2)
const exact = c.imageName + '@' + c.manifestDigest
const same = value => JSON.stringify(args) === JSON.stringify(value)
fs.appendFileSync(c.trace, JSON.stringify(args) + '\n')
if (args.length === 3 && args[0] === 'image' && args[1] === 'inspect' && [c.imageId, c.imageRef, exact].includes(args[2])) {
  process.stdout.write(JSON.stringify([{ Id: c.imageId, Config: { Labels: { 'org.opencontainers.image.revision': c.sha } } }]))
} else if (same(['push', c.imageRef])) {
  process.stdout.write('synthetic: digest: ' + c.manifestDigest + ' size: 1234\n')
} else if (same(['buildx', 'imagetools', 'inspect', '--raw', exact])) {
  process.stdout.write(c.manifest + '\n')
} else if (same(['pull', exact])) {
  process.stdout.write('synthetic immutable pull\n')
} else {
  fs.appendFileSync(c.trace, '"UNSUPPORTED"\n')
  process.stderr.write('unsupported synthetic publication command\n')
  process.exitCode = 64
}
`
  try {
    mkdirSync(bin)
    writeFileSync(output, '')
    writeFileSync(trace, '')
    writeFileSync(join(bin, 'docker'), '#!' + process.execPath + '\n' + program)
    chmodSync(join(bin, 'docker'), 0o700)
    const result = spawnSync('bash', ['--noprofile', '--norc', '-se'], {
      input: script, cwd: directory, encoding: 'utf8', timeout: 5000,
      env: { PATH: bin + ':' + resolve(process.execPath, '..') + ':/usr/bin:/bin',
        EXPECTED_SHA: sha, VERIFIED_IMAGE_ID: imageId, GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1',
        GITHUB_OUTPUT: output, WEB_PUBLICATION_FIXTURE: JSON.stringify(config) },
    })
    return { result, receipt: readFileSync(output, 'utf8'), trace: readFileSync(trace, 'utf8'), config }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('production deployment workflow integrity', () => {
  it('standalone Web binds its whole effective workflow and readable three-job envelope', () => {
    const source = workflow('deploy-web-standalone.yml')
    expect(sha256(JSON.stringify(parseWorkflow(source)))).toBe(standaloneWebWorkflowDigest)
    expectStandaloneWebContract(source)
  })

  it('standalone Web semantic controls reject envelope escapes independently of the whole-workflow digest', () => {
    const source = workflow('deploy-web-standalone.yml')
    expectStandaloneWebContract(source)
    const mutations: [string, (string | number)[], unknown][] = [
      ['automatic trigger', ['on', 'push'], {}],
      ['reusable trigger', ['on', 'workflow_call'], {}],
      ['workflow shell defaults', ['defaults'], { run: { shell: "bash -c 'exit 0' {0}" } }],
      ['workflow startup injection', ['env', 'BASH_ENV'], '/tmp/startup'],
      ['broad token', ['jobs', 'build-and-push', 'permissions', 'contents'], 'write'],
      ['self-hosted runner', ['jobs', 'build-and-push', 'runs-on'], 'self-hosted'],
      ['job container', ['jobs', 'deploy', 'container'], 'node:22'],
      ['job shell defaults', ['jobs', 'deploy', 'defaults'], { run: { shell: 'sh' } }],
      ['weak predicate', ['jobs', 'build-and-push', 'if'], standaloneWebPredicates.build + ' || true'],
      ['detached dependency', ['jobs', 'deploy', 'needs'], 'admission'],
      ['Annual approval substitution', ['jobs', 'deploy', 'env', 'WEB_STANDALONE_DEPLOY_APPROVED_SHA'], '${{ vars.WEB_DEPLOY_APPROVED_SHA }}'],
      ['mutable checkout', ['jobs', 'build-and-push', 'steps', 0, 'with', 'ref'], 'refs/heads/main'],
      ['mutable action', ['jobs', 'build-and-push', 'steps', 0, 'uses'], 'actions/checkout@v7'],
      ['ineffective authorization shell', ['jobs', 'build-and-push', 'steps', 1, 'shell'], "bash -c 'exit 0' {0}"],
      ['skipped authorization', ['jobs', 'build-and-push', 'steps', 1, 'if'], 'false'],
      ['startup injection on authorization', ['jobs', 'build-and-push', 'steps', 1, 'env', 'BASH_ENV'], '/tmp/startup'],
      ['extra unnamed mutation', ['jobs', 'build-and-push', 'steps', 16], { run: 'docker push attacker/image' }],
      ['allowed mutation failure', ['jobs', 'deploy', 'steps', 4, 'continue-on-error'], true],
      ['fingerprint bypass', ['jobs', 'deploy', 'steps', 4, 'with', 'fingerprint'], ''],
      ['proxy transport', ['jobs', 'deploy', 'steps', 4, 'with', 'proxy_host'], 'attacker'],
      ['record upload override', ['jobs', 'build-and-push', 'steps', 11, 'env', 'DOCKER_BUILD_RECORD_UPLOAD'], 'true'],
      ['build summary enabled', ['jobs', 'build-and-push', 'env', 'DOCKER_BUILD_SUMMARY'], 'true'],
      ['raw provenance enabled', ['jobs', 'build-and-push', 'steps', 11, 'with', 'provenance'], true],
      ['publication before image admission', ['jobs', 'build-and-push', 'steps', 11, 'with', 'push'], true],
      ['manifest/config conflation', ['jobs', 'deploy', 'steps', 4, 'env', 'IMAGE_CONFIG_ID'], '${{ needs.build-and-push.outputs.image-digest }}'],
    ]
    for (const [label, path, value] of mutations) {
      const edited = JSON.parse(JSON.stringify(parseWorkflow(source))) as ParsedWorkflow
      let target = edited as unknown as Record<string, unknown>
      for (const key of path.slice(0, -1)) target = target[String(key)] as Record<string, unknown>
      target[String(path.at(-1))] = value
      expect(() => expectStandaloneWebContract(stringify(edited)), label).toThrow()
    }
    const reordered = parseWorkflow(source)
    const steps = reordered.jobs.deploy.steps ?? []
    ;[steps[3], steps[4]] = [steps[4], steps[3]]
    expect(() => expectStandaloneWebContract(stringify(reordered))).toThrow()
  })

  it('standalone Web refuses duplicate and merge keys before effective controls are interpreted', () => {
    const source = workflow('deploy-web-standalone.yml')
    const duplicate = source.replace('    environment: "web-production"', '    environment: "web-production"\n    environment: attacker')
    expect(duplicate).not.toBe(source)
    expect(() => parseWorkflow(duplicate)).toThrow()
    const merge = parseWorkflow(source)
    merge.env = { ...merge.env, '<<': 'unreviewed inherited values' }
    expect(() => parseWorkflow(stringify(merge))).toThrow()
  })

  it('the parsed standalone Web admission and all exact-source authorizations execute fail-closed', () => {
    const parsed = parseWorkflow(workflow('deploy-web-standalone.yml'))
    const admission = parsed.jobs.admission.steps?.[0].run ?? ''
    expect(standaloneWebProgramFailures(admission, false)).toEqual([])
    const runs = [
      parsed.jobs['build-and-push'].steps?.find(step => step.name === 'Assert this is the live main commit')?.run,
      parsed.jobs['build-and-push'].steps?.find(step => step.name === 'Re-assert live main immediately before publication')?.run,
      parsed.jobs.deploy.steps?.find(step => step.name === 'Re-assert live main immediately before deployment')?.run,
    ]
    for (const run of runs) {
      expect(typeof run).toBe('string')
      expect(standaloneWebProgramFailures(run ?? '', true)).toEqual([])
    }
    // An early-success/heredoc decoy still contains the entire reviewed text.
    const decoy = "exit 0\ncat <<'DECOY'\n" + admission + '\nDECOY\n'
    expect(standaloneWebProgramFailures(decoy, false)).toContain('unarmed')
    const auth = runs[0] ?? ''
    const weakened = auth.replace('[ "$GITHUB_SHA" != "$LIVE_MAIN_SHA" ]', '[ "" != "" ]')
    expect(weakened).not.toBe(auth)
    expect(standaloneWebProgramFailures(weakened, true)).toContain('dispatch head')
    const noOp = 'exit 0\n' + auth
    expect(standaloneWebProgramFailures(noOp, true)).toContain('wrong checkout')
  }, 20000)

  it('standalone Web publishes the verified config through an authenticated manifest digest mapping', () => {
    const parsed = parseWorkflow(workflow('deploy-web-standalone.yml'))
    const script = parsed.jobs['build-and-push'].steps?.find(step => step.name === 'Publish verified image and bind registry identity')?.run ?? ''
    expect(script).not.toBe('')
    const control = runWebPublicationFixture(script)
    expect(control.result.error).toBeUndefined()
    expect(control.trace).not.toContain('UNSUPPORTED')
    expect(control.result.status, control.result.stderr).toBe(0)
    expect(control.config.manifestDigest).not.toBe(control.config.imageId)
    expect(control.receipt).toBe('image-digest=' + control.config.manifestDigest + '\nimage-config-id=' + control.config.imageId + '\nimage-revision=' + admittedSha + '\n')
    const wrong = runWebPublicationFixture(script, true)
    expect(wrong.result.error).toBeUndefined()
    expect(wrong.trace).not.toContain('UNSUPPORTED')
    expect(wrong.trace).toContain('"push"')
    expect(wrong.trace).toContain('"--raw"')
    expect(wrong.result.status).not.toBe(0)
    expect(wrong.receipt).toBe('')
  }, 15000)

  it('standalone Web reuses protected fingerprint validation and has no Annual callers or evidence', () => {
    const parsed = parseWorkflow(workflow('deploy-web-standalone.yml'))
    const preflight = parsed.jobs.deploy.steps?.find(step => step.name === sshFingerprintPreflightName)?.run ?? ''
    const fingerprint = 'SHA256:' + createHash('sha256').update('synthetic-web-fingerprint').digest('base64').replace(/=+$/, '')
    expect(runSshFingerprintPreflight(preflight, fingerprint).status).toBe(0)
    for (const value of [undefined, '', fingerprint + '=', fingerprint + '\n', 'MD5:untrusted']) {
      expect(runSshFingerprintPreflight(preflight, value).status).not.toBe(0)
    }
    const directory = resolve(process.cwd(), '../../.github/workflows')
    for (const name of readdirSync(directory).filter(name => /\.ya?ml$/.test(name))) {
      const caller = parseWorkflow(readFileSync(join(directory, name), 'utf8'))
      expect(Object.values(caller.jobs).filter(job => job.uses?.includes('deploy-web-standalone.yml')), name).toEqual([])
    }
    const annual = parseWorkflow(workflow('annual-only-public-cutover.yml'))
    expect(annual.jobs['deploy-web'].uses).toBe('./.github/workflows/deploy-web.yml')
    expect(JSON.stringify(annual)).not.toContain('WEB_STANDALONE_DEPLOY_APPROVED_SHA')
    expect(deployRunbook).toContain('## Standalone Web admission (no annual Stage A)')
    const ci = parseWorkflow(workflow('ci.yml'))
    expect(ci.jobs.test.steps?.some(step => step.run === 'pnpm --filter @silentsuite/web test app/lib/__tests__/production-deploy-workflows.test.ts')).toBe(true)
    expect(Object.keys(ci.on ?? {}).sort()).toEqual(['pull_request', 'push'])
  })

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

  it('standalone Web admission rejects an added effective push trigger despite retained manual admission text', () => {
    const approvalVariable = 'WEB_STANDALONE_DEPLOY_APPROVED_SHA'
    const run = [
      'set -euo pipefail',
      '[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]',
      '[[ "$WEB_STANDALONE_DEPLOY_APPROVED_SHA" =~ ^[0-9a-f]{40}$ ]]',
      'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main',
      'LIVE_MAIN_SHA=$(git rev-parse origin/main)',
      'if [ "$GITHUB_REF" != "refs/heads/main" ] ||',
      '   [ "$GITHUB_SHA" != "$LIVE_MAIN_SHA" ] ||',
      '   [ "$(git rev-parse HEAD)" != "$EXPECTED_SHA" ] ||',
      '   [ "$EXPECTED_SHA" != "$LIVE_MAIN_SHA" ] ||',
      '   [ "$WEB_STANDALONE_DEPLOY_APPROVED_SHA" != "$EXPECTED_SHA" ]; then',
      '  exit 1',
      'fi',
      '',
    ].join('\n')
    const job = (authorizationName: string) => ({
      if: "github.ref == 'refs/heads/main' && github.sha == inputs.expected_sha && vars.WEB_STANDALONE_DEPLOY_APPROVED_SHA == inputs.expected_sha",
      'runs-on': 'ubuntu-latest', environment: 'web-production', permissions: { contents: 'read' },
      env: { WEB_STANDALONE_DEPLOY_APPROVED_SHA: '${{ vars.WEB_STANDALONE_DEPLOY_APPROVED_SHA }}' },
      steps: [
        { name: 'Checkout exact standalone Web commit', uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
          with: { ref: '${{ inputs.expected_sha }}', 'fetch-depth': 0 } },
        { name: authorizationName, shell: 'bash', env: { EXPECTED_SHA: '${{ inputs.expected_sha }}' }, run },
      ],
    })
    const dispatch = 'workflow_dispatch: { inputs: { expected_sha: { required: true, type: string } } }'
    const source = [
      'name: Standalone Web admission fixture',
      `on: { ${dispatch} }`,
      'jobs: ' + JSON.stringify({
        'build-and-push': job('Assert this is the live main commit'),
        deploy: job('Re-assert live main immediately before deployment'),
      }),
      '',
    ].join('\n')
    const runDigests = [sha256(run), sha256(run)]
    const control = parseWorkflow(source)
    expect(Object.keys(control.on ?? {})).toEqual(['workflow_dispatch'])
    expect(() => expectManualOnlyContract('deploy-web-standalone.yml', source, 'web-production', approvalVariable, runDigests)).not.toThrow()

    const mutatedSource = source.replace(`on: { ${dispatch} }`, `on: { ${dispatch}, push: {} }`)
    expect(mutatedSource).not.toBe(source)
    const mutated = parseWorkflow(mutatedSource)
    expect(Object.keys(mutated.on ?? {})).toEqual(['workflow_dispatch', 'push'])
    expect(mutatedSource).toContain('workflow_dispatch:')
    expect(mutated.jobs).toStrictEqual(control.jobs)
    for (const name of ['build-and-push', 'deploy']) {
      expect(sha256(mutated.jobs[name].steps?.[1].run ?? '')).toBe(sha256(run))
    }
    // Exercise the real new-path semantic call independently of workflow/job digests.
    expect(() => expectManualOnlyContract('deploy-web-standalone.yml', mutatedSource, 'web-production', approvalVariable, runDigests)).toThrow()
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

  it('standalone Web cutover restores the predecessor on a wrong served SHA (old Web scalar until standalone exists)', () => {
    const directory = resolve(process.cwd(), '../../.github/workflows')
    const sourceName = readdirSync(directory).includes('deploy-web-standalone.yml')
      ? 'deploy-web-standalone.yml' : 'deploy-web.yml'
    const parsed = parseWorkflow(workflow(sourceName))
    const mutations = (parsed.jobs.deploy.steps ?? []).filter(step => step.uses === pinnedSshAction && typeof step.with?.script === 'string')
    expect(mutations).toHaveLength(1)
    const script = mutations[0].with?.script ?? ''
    expect(script).not.toBe('')
    // The parsed scalar is passed byte-for-byte to Bash; no copied rollback body.
    const control = runWebCutoverFixture(script, false)
    const wrong = runWebCutoverFixture(script, true)
    const ids = webCutoverIdentities
    expect(ids.manifestDigest).not.toBe(ids.candidateConfigId)
    expect(ids.previousConfigId).not.toBe(ids.candidateConfigId)
    for (const scenario of [control, wrong]) {
      expect(scenario.result.error).toBeUndefined()
      expect(scenario.result.signal).toBeNull()
      expect(scenario.trace.filter(call => call.operation === 'unsupported')).toEqual([])
      const recreations = scenario.trace.filter(call => call.operation === 'recreate')
      expect(recreations.length).toBeGreaterThan(0)
      expect(recreations.every(call => call.service === 'web')).toBe(true)
      const replacement = scenario.trace.findIndex(call => call.operation === 'recreate' && call.target === 'candidate')
      expect(replacement).toBeGreaterThanOrEqual(0)
      const configRead = scenario.trace.findIndex((call, index) => index > replacement &&
        call.operation === 'running-config' && call.returned === ids.candidateConfigId)
      const revisionRead = scenario.trace.findIndex((call, index) => index > replacement &&
        call.operation === 'running-revision' && call.returned === ids.candidateSha)
      expect(configRead).toBeGreaterThan(replacement)
      expect(revisionRead).toBeGreaterThan(replacement)
      expect(scenario.trace.some(call => call.operation === 'pulled-config' && call.returned === ids.candidateConfigId)).toBe(true)
      expect(scenario.trace.some((call, index) => index > configRead && index > revisionRead &&
        call.operation === 'http-root' && call.returned === '200' && call.imageId === ids.candidateConfigId)).toBe(true)
    }
    expect(control.result.status, control.result.stderr).toBe(0)
    expect(control.state).toMatchObject({ imageId: ids.candidateConfigId, revision: ids.candidateSha, publicSha: ids.candidateSha })
    expect(control.trace.filter(call => call.operation === 'recreate').map(call => call.target)).toEqual(['candidate'])
    expect(wrong.trace.some(call => call.operation === 'http-root' && call.returned === '200' &&
      call.imageId === ids.candidateConfigId && call.revision === ids.candidateSha && call.publicSha === ids.wrongSha)).toBe(true)

    // Old-source witness: deploy-web.yml currently exits successfully on this scenario.
    // Standalone acceptance requires the real transaction to fail and verify restoration.
    expect(wrong.result.status, sourceName + ' must reject a wrong public deployment identity').not.toBe(0)
    expect(wrong.state).toMatchObject({ imageId: ids.previousConfigId, revision: ids.previousSha, publicSha: ids.previousSha })
    const restored = wrong.trace.findIndex(call => call.operation === 'recreate' && call.target === 'predecessor')
    expect(restored).toBeGreaterThan(0)
    expect(wrong.trace.some((call, index) => index > restored &&
      call.operation === 'running-config' && call.returned === ids.previousConfigId)).toBe(true)
    expect(wrong.trace.some((call, index) => index > restored &&
      call.operation === 'http-identity' && call.publicSha === ids.previousSha && call.returned === '200')).toBe(true)
  }, 20000)

  it.each([
    ['absent from PATH', 'absent', 1],
    ['present on PATH but nonworking (exit 127)', 'broken', 0],
  ] as const)('standalone Web cutover deploys and rolls back on a production host where jq is %s', (_label, remoteJq, commandV) => {
    const parsed = parseWorkflow(workflow('deploy-web-standalone.yml'))
    const mutations = (parsed.jobs.deploy.steps ?? []).filter(step => step.uses === pinnedSshAction && typeof step.with?.script === 'string')
    expect(mutations).toHaveLength(1)
    const script = mutations[0].with?.script ?? ''
    const control = runWebCutoverFixture(script, false, remoteJq)
    const wrong = runWebCutoverFixture(script, true, remoteJq)
    const ids = webCutoverIdentities
    for (const scenario of [control, wrong]) {
      expect(scenario.result.error).toBeUndefined()
      expect(scenario.result.signal).toBeNull()
      // Real `command -v jq` under the fixture PATH: 1 when absent, 0 when only shadowed.
      expect(scenario.jqResolution).toBe(commandV)
      expect(scenario.trace.filter(call => call.operation === 'unsupported')).toEqual([])
    }
    expect(control.result.status, 'successful baseline without working remote jq: ' + control.result.stderr).toBe(0)
    expect(control.state).toMatchObject({ imageId: ids.candidateConfigId, revision: ids.candidateSha, publicSha: ids.candidateSha })
    expect(control.trace.filter(call => call.operation === 'recreate').map(call => call.target)).toEqual(['candidate'])
    const replaced = control.trace.findIndex(call => call.operation === 'recreate')
    expect(control.trace.some((call, index) => index > replaced &&
      call.operation === 'http-identity' && call.publicSha === ids.candidateSha && call.returned === '200')).toBe(true)

    expect(wrong.result.status, 'wrong served SHA must fail without working remote jq').not.toBe(0)
    expect(wrong.trace.filter(call => call.operation === 'recreate').map(call => call.target)).toEqual(['candidate', 'predecessor'])
    expect(wrong.state).toMatchObject({ imageId: ids.previousConfigId, revision: ids.previousSha, publicSha: ids.previousSha })
    const restored = wrong.trace.findIndex(call => call.operation === 'recreate' && call.target === 'predecessor')
    expect(wrong.trace.some((call, index) => index > restored &&
      call.operation === 'running-config' && call.returned === ids.previousConfigId)).toBe(true)
    expect(wrong.trace.some((call, index) => index > restored &&
      call.operation === 'http-identity' && call.publicSha === ids.previousSha && call.returned === '200')).toBe(true)
  }, 20000)

  it('a post-SSH Web failure is recoverable: re-dispatch refuses, the runbook restoration restores the captured predecessor', () => {
    const ids = webCutoverIdentities
    const parsed = parseWorkflow(workflow('deploy-web-standalone.yml'))
    const deployScript = (parsed.jobs.deploy.steps ?? []).find(step => step.uses === pinnedSshAction)?.with?.script ?? ''
    expect(deployScript).not.toBe('')
    // Why the generic revert-and-dispatch path cannot recover: the healthy-predecessor guard refuses first.
    const redispatch = runWebCutoverFixture(deployScript, false, undefined, { failedCandidateRunning: true })
    expect(redispatch.result.status).not.toBe(0)
    expect(redispatch.trace.filter(call => call.operation === 'recreate')).toEqual([])
    expect(redispatch.state).toMatchObject({ imageId: ids.candidateConfigId, publicSha: ids.wrongSha })

    // The deployment log must carry the non-secret predecessor identities the restoration consumes.
    const deployed = runWebCutoverFixture(deployScript, false)
    expect(deployed.result.status, deployed.result.stderr).toBe(0)
    expect(deployed.result.stdout).toContain(`Predecessor receipt: image-config-id=${ids.previousConfigId} revision=${ids.previousSha}\n`)

    const heading = deployRunbook.indexOf('### Restore the captured predecessor after a post-SSH failure')
    expect(heading, 'runbook must document an executable post-SSH restoration').toBeGreaterThan(-1)
    const blocks = [...deployRunbook.slice(heading).matchAll(/```bash\n([\s\S]*?)```/g)]
    const restore = blocks[0]?.[1] ?? ''
    expect(restore).toContain('--no-deps --no-build web')
    const receipt = { PREVIOUS_IMAGE_ID: ids.previousConfigId, PREVIOUS_REVISION: ids.previousSha }
    const restored = runWebCutoverFixture(restore, false, undefined, { failedCandidateRunning: true, env: receipt })
    expect(restored.result.error).toBeUndefined()
    expect(restored.trace.filter(call => call.operation === 'unsupported')).toEqual([])
    expect(restored.result.status, restored.result.stderr).toBe(0)
    const recreated = restored.trace.findIndex(call => call.operation === 'recreate')
    expect(restored.trace.filter(call => call.operation === 'recreate').map(call => call.target)).toEqual(['predecessor'])
    expect(restored.trace.findIndex(call => call.operation === 'tag-predecessor')).toBeLessThan(recreated)
    // Current health is not a precondition: no public request happens before the restoration.
    expect(restored.trace.findIndex(call => call.operation?.startsWith('http-'))).toBeGreaterThan(recreated)
    expect(restored.trace.some((call, index) => index > recreated && call.operation === 'running-config' && call.returned === ids.previousConfigId)).toBe(true)
    expect(restored.trace.some((call, index) => index > recreated && call.operation === 'running-revision' && call.returned === ids.previousSha)).toBe(true)
    expect(restored.trace.some((call, index) => index > recreated && call.operation === 'http-root' && call.returned === '200')).toBe(true)
    expect(restored.trace.some((call, index) => index > recreated && call.operation === 'http-identity' && call.publicSha === ids.previousSha)).toBe(true)
    expect(restored.state).toMatchObject({ imageId: ids.previousConfigId, revision: ids.previousSha, publicSha: ids.previousSha })

    const refusals: [string, Record<string, string>][] = [
      ['running image is not the failed candidate', { ...receipt, IMAGE_CONFIG_ID: 'sha256:' + '9'.repeat(64) }],
      ['running revision is not the failed candidate', { ...receipt, DEPLOY_SHA: ids.wrongSha }],
      ['predecessor image is not cached', { ...receipt, PREVIOUS_IMAGE_ID: 'sha256:' + '8'.repeat(64) }],
      ['cached predecessor has another revision', { ...receipt, PREVIOUS_REVISION: ids.wrongSha }],
      ['predecessor equals the failed candidate', { ...receipt, PREVIOUS_IMAGE_ID: ids.candidateConfigId }],
      ['missing receipt', { PREVIOUS_IMAGE_ID: '', PREVIOUS_REVISION: '' }],
    ]
    for (const [label, env] of refusals) {
      const refused = runWebCutoverFixture(restore, false, undefined, { failedCandidateRunning: true, env })
      expect(refused.result.status, label).not.toBe(0)
      expect(refused.trace.some(call => call.operation === 'recreate' || call.operation === 'tag-predecessor'), label).toBe(false)
      expect(refused.state, label).toMatchObject({ imageId: ids.candidateConfigId, revision: ids.candidateSha })
    }
  }, 30000)

  it('standalone Web remote identity parser admits only the exact single-key publicSha object (after-edit characterization)', () => {
    const parsed = parseWorkflow(workflow('deploy-web-standalone.yml'))
    const script = (parsed.jobs.deploy.steps ?? []).find(step => step.uses === pinnedSshAction)?.with?.script ?? ''
    expect(script).not.toMatch(/\bjq\b/)
    const calls = [...script.matchAll(/python3 -I -c '([^']+)' "\$HEALTH_BODY" "\$expected"/g)]
    expect(calls).toHaveLength(1)
    const program = calls[0][1]
    const sha = webCutoverIdentities.candidateSha
    const directory = mkdtempSync(join(tmpdir(), 'silentsuite-web-identity-'))
    try {
      const verdict = (body: string) => {
        const file = join(directory, 'body.json')
        writeFileSync(file, body)
        return spawnSync('python3', ['-I', '-c', program, file, sha], { cwd: directory, encoding: 'utf8' }).status
      }
      expect(verdict(JSON.stringify({ publicSha: sha }) + '\n')).toBe(0)
      for (const body of [
        JSON.stringify({ publicSha: webCutoverIdentities.wrongSha }),
        JSON.stringify({ publicSha: sha, extra: true }),
        `{"publicSha":"${webCutoverIdentities.wrongSha}","publicSha":"${sha}"}`,
        JSON.stringify([['publicSha', sha]]),
        JSON.stringify({ publicSha: [sha] }),
        JSON.stringify(sha),
        `{"publicSha":"${sha}"`,
        '',
      ]) expect(verdict(body), body).toBe(1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
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
