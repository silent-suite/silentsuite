import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The self-host web image must be an explicit build input: Next inlines
// NEXT_PUBLIC_* values at build time, so a runtime env cannot change them.

const dockerfile = readFileSync(resolve(__dirname, '../../../../../Dockerfile.web'), 'utf8')
const builderStage = dockerfile.slice(dockerfile.indexOf('AS builder'), dockerfile.indexOf('AS runner'))

describe('Dockerfile.web self-host build contract', () => {
  it('declares NEXT_PUBLIC_SELF_HOSTED as a build argument defaulting to hosted mode', () => {
    expect(builderStage).toMatch(/^ARG NEXT_PUBLIC_SELF_HOSTED=false$/m)
    expect(builderStage).toMatch(/^ENV NEXT_PUBLIC_SELF_HOSTED=\$NEXT_PUBLIC_SELF_HOSTED$/m)
  })

  it('sets the build mode before the web build runs', () => {
    const env = builderStage.indexOf('ENV NEXT_PUBLIC_SELF_HOSTED=')
    const build = builderStage.indexOf('pnpm --filter @silentsuite/web build')
    expect(env).toBeGreaterThan(-1)
    expect(build).toBeGreaterThan(env)
  })

  it('keeps the hosted Etebase URL default for hosted builds', () => {
    expect(builderStage).toMatch(/^ARG NEXT_PUBLIC_ETEBASE_SERVER_URL=https:\/\/server\.silentsuite\.io$/m)
  })
})
