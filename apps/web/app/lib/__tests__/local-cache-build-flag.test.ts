import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { getCacheCapabilityStatus } from '../data-cache'

/**
 * Build-time contract for `NEXT_PUBLIC_LOCAL_CACHE_ENABLED`.
 *
 * Durable encrypted local caching is enabled for the shared preview only. The
 * image default must stay off so every production build path keeps caching
 * disabled without depending on any workflow remembering to pass `false`.
 */

type WorkflowStep = { name?: string; uses?: string; with?: Record<string, string> }
type ParsedWorkflow = { jobs: Record<string, { steps?: WorkflowStep[] }> }

const FLAG = 'NEXT_PUBLIC_LOCAL_CACHE_ENABLED'

function repoFile(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), '../..', relativePath), 'utf8')
}

function buildArgSteps(workflowName: string): WorkflowStep[] {
  const document = parseDocument(repoFile(`.github/workflows/${workflowName}`), { uniqueKeys: true })
  if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join('\n'))
  const parsed = document.toJS() as ParsedWorkflow
  return Object.values(parsed.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.uses?.startsWith('docker/build-push-action@') && step.with?.file === 'Dockerfile.web')
}

function buildArgLines(step: WorkflowStep): string[] {
  return (step.with?.['build-args'] ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
}

describe('local cache build flag', () => {
  const dockerfile = repoFile('Dockerfile.web')

  it('defaults the image build argument to off and forwards it to the Next.js build', () => {
    expect(dockerfile).toContain(`ARG ${FLAG}=false`)
    expect(dockerfile).toContain(`ENV ${FLAG}=$${FLAG}`)
    // Exactly one declaration of each, so no later stage can re-default it on.
    expect(dockerfile.match(new RegExp(`^ARG ${FLAG}=.*$`, 'gm'))).toEqual([`ARG ${FLAG}=false`])
    expect(dockerfile.match(new RegExp(`^ENV ${FLAG}=.*$`, 'gm'))).toEqual([`ENV ${FLAG}=$${FLAG}`])
    // The ARG must precede the ENV that expands it, and both must precede the build.
    const arg = dockerfile.indexOf(`ARG ${FLAG}=false`)
    const env = dockerfile.indexOf(`ENV ${FLAG}=$${FLAG}`)
    expect(arg).toBeLessThan(env)
    expect(env).toBeLessThan(dockerfile.indexOf('pnpm --filter @silentsuite/web build'))
  })

  it('enables the flag in every preview image build', () => {
    const steps = buildArgSteps('preview-web.yml')
    expect(steps).toHaveLength(2)
    for (const step of steps) {
      const lines = buildArgLines(step)
      expect(lines).toContain(`${FLAG}=true`)
      // Comments belong above the block scalar; a `#` line here would be passed
      // to the builder as a literal build argument.
      for (const line of lines) expect(line).toMatch(/^[A-Z][A-Z0-9_]*=/)
    }
    for (const step of steps) expect(step.with?.push).not.toBe(true)
  })

  it('leaves production web builds on the default-off value', () => {
    const deployWeb = repoFile('.github/workflows/deploy-web.yml')
    expect(deployWeb).not.toContain(FLAG)
    const steps = buildArgSteps('deploy-web.yml')
    expect(steps).toHaveLength(1)
    expect(buildArgLines(steps[0]).some((line) => line.startsWith(`${FLAG}=`))).toBe(false)
  })

  it.each([
    ['unset', undefined, false],
    ['false', 'false', false],
    ['empty', '', false],
    ['True', 'True', false],
    ['true', 'true', true],
  ])('reads the runtime gate as %s', (_label, value, expected) => {
    const previous = process.env[FLAG]
    try {
      if (value === undefined) delete process.env[FLAG]
      else process.env[FLAG] = value
      expect(getCacheCapabilityStatus().featureFlagEnabled).toBe(expected)
    } finally {
      if (previous === undefined) delete process.env[FLAG]
      else process.env[FLAG] = previous
    }
  })
})
