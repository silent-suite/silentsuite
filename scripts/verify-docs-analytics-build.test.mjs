import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { verifyDocsAnalyticsBuild } from './verify-docs-analytics-build.mjs'

async function fixture(contents) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'docs-analytics-'))
  await writeFile(path.join(directory, 'index.html'), contents)
  return directory
}

test('admits only an enabled artifact with the approved endpoint and taxonomy', async () => {
  const directory = await fixture('https://plausible.silentsuite.io/api/event docs.silentsuite.io pageview Hosted App Click Android Download Click GitHub Click')
  try {
    await assert.doesNotReject(() => verifyDocsAnalyticsBuild(directory, 'enabled'))
  } finally { await rm(directory, { recursive: true }) }
})

test('fails closed for disabled endpoint, unresolved values, wrong endpoints, and forbidden properties', async () => {
  for (const [mode, contents] of [
    ['disabled', 'https://plausible.silentsuite.io/api/event'],
    ['enabled', '__SILENTSUITE_DOCS_ANALYTICS_ENDPOINT__ docs.silentsuite.io pageview'],
    ['enabled', 'https://evil.example/api/event docs.silentsuite.io pageview'],
    ['enabled', 'https://plausible.silentsuite.io/api/event docs.silentsuite.io pageview utm_content'],
  ]) {
    const directory = await fixture(contents)
    try { await assert.rejects(() => verifyDocsAnalyticsBuild(directory, mode)) }
    finally { await rm(directory, { recursive: true }) }
  }
})
