import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalDocsPath, createDocsPageviewTracker } from './public-analytics.mts'

test('registers only repository-owned canonical document paths', () => {
  assert.equal(canonicalDocsPath('/user-guide/faq/?q=private#answer'), '/user-guide/faq')
  assert.equal(canonicalDocsPath('/'), '/')
  assert.equal(canonicalDocsPath('/local-search?q=secret'), undefined)
  assert.equal(canonicalDocsPath('/not-a-document'), undefined)
})

test('sends initial and successful route pageviews without duplicate consecutive delivery', () => {
  const deliveries: string[] = []
  const tracker = createDocsPageviewTracker((path) => deliveries.push(path))

  tracker('/user-guide/faq?query=private#heading')
  tracker('/user-guide/faq/')
  tracker('/self-hosting')
  tracker('/not-a-document')
  tracker('/user-guide/faq')

  assert.deepEqual(deliveries, ['/user-guide/faq', '/self-hosting', '/user-guide/faq'])
})
