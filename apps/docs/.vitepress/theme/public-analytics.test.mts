import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyDocsOutboundEvent } from './public-analytics.mts'

test('classifies approved hosted-app destinations by route class', () => {
  assert.deepEqual(classifyDocsOutboundEvent('https://app.silentsuite.io', '/user-guide/getting-started'), {
    event: 'Hosted App Click',
    props: { surface: 'docs', route_class: 'app_home' },
  })
  assert.deepEqual(classifyDocsOutboundEvent('https://app.silentsuite.io', '/user-guide/getting-started/'), {
    event: 'Hosted App Click',
    props: { surface: 'docs', route_class: 'app_home' },
  })
  assert.deepEqual(classifyDocsOutboundEvent('https://app.silentsuite.io/signup', '/user-guide/faq'), {
    event: 'Hosted App Click',
    props: { surface: 'docs', route_class: 'signup' },
  })
})

test('classifies Android destinations only on the Android guide', () => {
  assert.deepEqual(classifyDocsOutboundEvent('https://play.google.com/store/apps/details?id=io.silentsuite.android', '/user-guide/apps/android'), {
    event: 'Android Download Click',
    props: { surface: 'docs_android', channel: 'google_play' },
  })
  assert.deepEqual(classifyDocsOutboundEvent('https://zapstore.dev/apps/io.silentsuite.android', '/user-guide/apps/android'), {
    event: 'Android Download Click',
    props: { surface: 'docs_android', channel: 'zapstore' },
  })
  assert.deepEqual(classifyDocsOutboundEvent('https://f-droid.org/packages/io.silentsuite.android', '/user-guide/apps/android'), {
    event: 'Android Download Click',
    props: { surface: 'docs_android', channel: 'fdroid' },
  })
  assert.deepEqual(
    classifyDocsOutboundEvent(
      'obtainium://add/https://github.com/silent-suite/silentsuite',
      '/user-guide/apps/android',
    ),
    {
      event: 'Android Download Click',
      props: { surface: 'docs_android', channel: 'obtainium' },
    },
  )
  assert.deepEqual(classifyDocsOutboundEvent('https://github.com/silent-suite/silentsuite/releases/latest', '/user-guide/apps/android'), {
    event: 'Android Download Click',
    props: { surface: 'docs_android', channel: 'github_release' },
  })
  assert.deepEqual(classifyDocsOutboundEvent('https://github.com/silent-suite/silentsuite/tree/main/android', '/user-guide/apps/android'), {
    event: 'GitHub Click',
    props: { surface: 'docs_android', channel: 'repository' },
  })
  assert.equal(classifyDocsOutboundEvent('https://play.google.com/store/apps/details?id=io.silentsuite.android', '/user-guide/faq'), undefined)
  assert.equal(classifyDocsOutboundEvent('https://github.com/silent-suite/silentsuite/releases/latest', '/user-guide/faq'), undefined)
})

test('does not classify generic, credentialed, or path-bearing external links', () => {
  assert.equal(classifyDocsOutboundEvent('https://github.com/silent-suite/silentsuite/issues/1', '/user-guide/apps/android'), undefined)
  assert.equal(classifyDocsOutboundEvent('https://example.com/?campaign=download', '/user-guide/apps/android'), undefined)
  assert.equal(classifyDocsOutboundEvent('https://user@example.com/secret', '/user-guide/getting-started'), undefined)
  assert.equal(classifyDocsOutboundEvent('not a url', '/user-guide/getting-started'), undefined)
  assert.equal(classifyDocsOutboundEvent('https://app.silentsuite.io', '/contributing/testing'), undefined)
})

test('every docs page is a registered analytics path', async () => {
  const { readdir } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { REGISTERED_DOCS_PATHS } = await import('./public-analytics.mts')
  const docsRoot = fileURLToPath(new URL('../../', import.meta.url))
  const pages: string[] = []
  for (const entry of await readdir(docsRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const relative = `${entry.parentPath.slice(docsRoot.length)}/${entry.name}`.replace(/^\/+/, '')
    if (relative.split('/').some((part) => part === 'node_modules' || part.startsWith('.'))) continue
    pages.push(`/${relative}`.replace(/(?:\/index)?\.md$/, '') || '/')
  }
  assert.ok(pages.length > 40, 'docs pages were found')
  assert.deepEqual(pages.filter((path) => !REGISTERED_DOCS_PATHS.has(path)).sort(), [])
})
