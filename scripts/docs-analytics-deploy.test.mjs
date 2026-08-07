import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('docs production workflow verifies both built and downloaded bytes', async () => {
  const workflow = await readFile('.github/workflows/deploy-docs.yml', 'utf8')
  assert.equal((workflow.match(/verify-docs-analytics-build\.mjs/g) ?? []).length, 2)
  assert.match(workflow, /pnpm --filter @silentsuite\/docs exec vitepress build/)
  assert.match(workflow, /Upload admitted docs artifact[\s\S]*path: apps\/docs\/\.vitepress\/dist/)
})

test('CI verifies enabled and disabled docs artifacts across Turbo cache ordering', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8')
  assert.match(workflow, /SILENTSUITE_HOSTED_DOCS_ANALYTICS=1 pnpm run build:docs/)
  assert.match(workflow, /pnpm run build:docs[\s\S]*--mode disabled/)
  assert.match(workflow, /--mode enabled/)
})
