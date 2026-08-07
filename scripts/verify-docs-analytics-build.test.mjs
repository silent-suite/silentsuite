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

test('rejects every unapproved event occurrence in enabled and disabled artifacts', async () => {
  const taxonomy = 'docs.silentsuite.io pageview Hosted App Click Android Download Click GitHub Click'
  const unapprovedOccurrences = [
    '/api/event',
    'http://plausible.silentsuite.io/api/event',
    '//plausible.silentsuite.io/api/event',
    'https://plausible.silentsuite.io/api/event/extra',
    'https://plausible.silentsuite.io/api/event?source=docs',
    'https://plausible.silentsuite.io/api/event#fragment',
    'https://plausible.silentsuite.io.evil.example/api/event',
    'https://plausible.silentsuite.io:8443/api/event',
    'https://plausible.silentsuite.io/api/event https://evil.example/api/event',
    '\\x2fapi\\x2fevent',
    'https:%2F%2Fevil.example%2Fapi%2Fevent',
  ]

  for (const occurrence of unapprovedOccurrences) {
    for (const [mode, contents] of [
      ['enabled', `${occurrence} ${taxonomy}`],
      ['disabled', occurrence],
    ]) {
      const directory = await fixture(contents)
      try { await assert.rejects(() => verifyDocsAnalyticsBuild(directory, mode), occurrence) }
      finally { await rm(directory, { recursive: true }) }
    }
  }
})
