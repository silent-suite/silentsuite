import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// The annual and standalone Docs production workflows must keep identical build-side guards.
const docsProductionWorkflows = ['deploy-docs.yml', 'deploy-docs-standalone.yml']

for (const name of docsProductionWorkflows) {
  test(`${name}: docs production workflow verifies both built and downloaded bytes`, async () => {
    const workflow = await readFile(`.github/workflows/${name}`, 'utf8')
    assert.equal((workflow.match(/verify-docs-analytics-build\.mjs/g) ?? []).length, 2)
    assert.match(workflow, /pnpm --filter @silentsuite\/docs exec vitepress build/)
    assert.match(workflow, /Upload admitted docs artifact[\s\S]*path: apps\/docs\/\.vitepress\/dist/)
  })
}

test('CI verifies enabled and disabled docs artifacts across Turbo cache ordering', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8')
  assert.match(workflow, /SILENTSUITE_HOSTED_DOCS_ANALYTICS=1 pnpm run build:docs/)
  assert.match(workflow, /pnpm run build:docs[\s\S]*--mode disabled/)
  assert.match(workflow, /--mode enabled/)
})

test('production wrangler topology binds the relay Worker and ASSETS fallback', async () => {
  const config = await readFile('apps/docs/wrangler.jsonc', 'utf8')
  assert.match(config, /"main"\s*:\s*"worker\/index\.mts"/)
  assert.match(config, /"assets"\s*:\s*\{[\s\S]*"directory"\s*:\s*"\.vitepress\/dist"[\s\S]*"binding"\s*:\s*"ASSETS"/)
  assert.match(config, /"observability"\s*:\s*\{[\s\S]*"enabled"\s*:\s*false/)
})

test('production Worker source is the sole upstream boundary', async () => {
  const source = await readFile('apps/docs/worker/index.mts', 'utf8')
  assert.equal((source.match(/plausible\.silentsuite\.io/g) ?? []).length, 1)
  assert.match(source, /DOCS_PLAUSIBLE_ENDPOINT\s*=\s*'https:\/\/plausible\.silentsuite\.io\/api\/event'/)
})

test('preview wrangler topology stays assets-only without a Worker entrypoint', async () => {
  const config = await readFile('apps/docs/wrangler.preview.jsonc', 'utf8')
  assert.doesNotMatch(config, /"main"\s*:/)
  assert.match(config, /"assets"\s*:\s*\{[\s\S]*"directory"\s*:\s*"\.vitepress\/dist"/)
})

for (const name of docsProductionWorkflows) {
  test(`${name}: production workflow runs public analytics checks before build and immediately before deploy`, async () => {
    const workflow = await readFile(`.github/workflows/${name}`, 'utf8')
    assert.equal((workflow.match(/pnpm run check:public-analytics/g) ?? []).length, 2)
    assert.match(workflow, /Verify public analytics and relay contract before build[\s\S]*pnpm run check:public-analytics/)
    const analyticsIndex = workflow.indexOf('name: Re-verify public analytics and relay topology immediately before deployment')
    const reauthorizationIndex = workflow.indexOf('name: Re-assert owner approval immediately before deployment')
    const deployIndex = workflow.indexOf('name: Deploy to production Worker')
    assert.ok(analyticsIndex >= 0)
    assert.ok(reauthorizationIndex > analyticsIndex)
    assert.equal(deployIndex, reauthorizationIndex + workflow.slice(reauthorizationIndex).indexOf('name: Deploy to production Worker'))
    assert.match(workflow.slice(reauthorizationIndex), /Re-assert owner approval immediately before deployment[\s\S]*Deploy to production Worker/)
  })

  test(`${name}: both deploy workflow setup-node actions use the exact immutable pin`, async () => {
    const workflow = await readFile(`.github/workflows/${name}`, 'utf8')
    assert.deepEqual(
      [...workflow.matchAll(/uses: actions\/setup-node@([0-9a-f]+)/g)].map((match) => match[1]),
      ['820762786026740c76f36085b0efc47a31fe5020', '820762786026740c76f36085b0efc47a31fe5020'],
    )
  })
}
