import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

import {
  DOCS_PLAUSIBLE_ENDPOINT,
  DOCS_RELAY_MAX_BODY_BYTES,
  DOCS_RELAY_PATH,
  createDocsRelayWorker,
} from './index.mts'

const RELAY_URL = `https://docs.silentsuite.io${DOCS_RELAY_PATH}`
const ORIGIN = 'https://docs.silentsuite.io'
const CONTENT_TYPE = 'text/plain;charset=UTF-8'

type UpstreamCall = { url: string; init: RequestInit }

function harness(upstream: () => Promise<Response> = async () => new Response('ok', { status: 202 })) {
  const upstreamCalls: UpstreamCall[] = []
  const assetRequests: Request[] = []
  const pending: Promise<unknown>[] = []

  const worker = createDocsRelayWorker(async (url: string, init: RequestInit) => {
    upstreamCalls.push({ url, init })
    return upstream()
  })

  const env = {
    ASSETS: {
      fetch: async (request: Request) => {
        assetRequests.push(request)
        return new Response('static asset', { status: 200 })
      },
    },
  }

  const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) }

  return {
    upstreamCalls,
    assetRequests,
    async send(request: Request) {
      const response = await worker.fetch(request, env, ctx)
      await Promise.allSettled(pending)
      return response
    },
  }
}

function relayRequest(body: string, overrides: {
  url?: string
  method?: string
  headers?: Record<string, string>
} = {}) {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    'content-type': CONTENT_TYPE,
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Docs/1.0',
    'cf-connecting-ip': '203.0.113.7',
    ...overrides.headers,
  }
  // A string body makes the runtime infer text/plain;charset=UTF-8, exactly as Beacon
  // does, so an absent Content-Type has to be expressed with an untyped Blob body.
  const contentTypeCleared = headers['content-type'] === ''
  for (const [key, value] of Object.entries(headers)) if (value === '') delete headers[key]
  const method = overrides.method ?? 'POST'
  return new Request(overrides.url ?? RELAY_URL, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: contentTypeCleared ? new Blob([body]) : body }),
  })
}

const PAGEVIEW = JSON.stringify({
  domain: 'docs.silentsuite.io',
  name: 'pageview',
  url: 'https://docs.silentsuite.io/user-guide/faq',
  referrer: 'https://twitter.com/',
})

const EVENT = JSON.stringify({
  domain: 'docs.silentsuite.io',
  name: 'Android Download Click',
  url: 'https://docs.silentsuite.io/',
  props: { surface: 'docs_android', channel: 'google_play' },
})

async function forwardedBody(upstreamCalls: UpstreamCall[]) {
  assert.equal(upstreamCalls.length, 1)
  return JSON.parse(String(upstreamCalls[0].init.body))
}

test('admits a canonical pageview and rebuilds it server-side', async () => {
  const relay = harness()

  const response = await relay.send(relayRequest(PAGEVIEW))

  assert.equal(response.status, 204)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(relay.upstreamCalls[0].url, DOCS_PLAUSIBLE_ENDPOINT)
  assert.equal(relay.upstreamCalls[0].init.method, 'POST')
  assert.deepEqual(await forwardedBody(relay.upstreamCalls), {
    domain: 'docs.silentsuite.io',
    name: 'pageview',
    url: 'https://docs.silentsuite.io/user-guide/faq',
    referrer: 'https://twitter.com/',
  })
})

test('rebuilds referrer-free pageviews without any property payload', async () => {
  const relay = harness()

  await relay.send(relayRequest(JSON.stringify({
    domain: 'docs.silentsuite.io',
    name: 'pageview',
    url: 'https://docs.silentsuite.io/self-hosting/quick-start',
  })))

  const forwarded = await forwardedBody(relay.upstreamCalls)
  assert.deepEqual(Object.keys(forwarded).sort(), ['domain', 'name', 'url'])
  assert.equal(forwarded.url, 'https://docs.silentsuite.io/self-hosting/quick-start')
})

test('classifies every registered outbound route and href server-side', async () => {
  for (const [path, href, expected] of [
    ['/user-guide/getting-started', 'https://app.silentsuite.io', { name: 'Hosted App Click', props: { surface: 'docs', route_class: 'app_home' } }],
    ['/user-guide/apps', 'https://app.silentsuite.io/signup', { name: 'Hosted App Click', props: { surface: 'docs', route_class: 'signup' } }],
    ['/user-guide/apps/android', 'https://play.google.com/store/apps/details?id=io.silentsuite.android', { name: 'Android Download Click', props: { surface: 'docs_android', channel: 'google_play' } }],
    ['/user-guide/apps/android', 'https://zapstore.dev/apps/io.silentsuite.android', { name: 'Android Download Click', props: { surface: 'docs_android', channel: 'zapstore' } }],
    ['/user-guide/apps/android', 'https://f-droid.org/packages/io.silentsuite.android', { name: 'Android Download Click', props: { surface: 'docs_android', channel: 'fdroid' } }],
    ['/user-guide/apps/android', 'obtainium://add/https://github.com/silent-suite/silentsuite', { name: 'Android Download Click', props: { surface: 'docs_android', channel: 'obtainium' } }],
    ['/user-guide/apps/android', 'https://github.com/silent-suite/silentsuite/releases/latest', { name: 'Android Download Click', props: { surface: 'docs_android', channel: 'github_release' } }],
    ['/user-guide/apps/android', 'https://github.com/silent-suite/silentsuite/tree/main/android', { name: 'GitHub Click', props: { surface: 'docs_android', channel: 'repository' } }],
  ] as const) {
    const relay = harness()
    await relay.send(relayRequest(JSON.stringify({ domain: 'docs.silentsuite.io', name: 'outbound', path, href })))
    assert.deepEqual(await forwardedBody(relay.upstreamCalls), {
      domain: 'docs.silentsuite.io', ...expected, url: 'https://docs.silentsuite.io/',
    })
  }
})

test('classifies outbound route and href server-side before rebuilding the fixed event', async () => {
  const relay = harness()
  await relay.send(relayRequest(JSON.stringify({
    domain: 'docs.silentsuite.io', name: 'outbound', path: '/user-guide/getting-started', href: 'https://app.silentsuite.io',
  })))
  assert.deepEqual(await forwardedBody(relay.upstreamCalls), {
    domain: 'docs.silentsuite.io', name: 'Hosted App Click', url: 'https://docs.silentsuite.io/',
    props: { surface: 'docs', route_class: 'app_home' },
  })
})

test('never forwards client-supplied domain, url, referrer, name, or property injection', async () => {
  const rejected = [
    // Foreign or tampered measurement identity.
    { domain: 'silentsuite.io', name: 'pageview', url: 'https://docs.silentsuite.io/' },
    { domain: 'docs.silentsuite.io', name: 'pageview', url: 'https://evil.example/user-guide/faq' },
    { domain: 'docs.silentsuite.io', name: 'pageview', url: 'http://docs.silentsuite.io/user-guide/faq' },
    // Unregistered, query-bearing, or fragment-bearing routes.
    { domain: 'docs.silentsuite.io', name: 'pageview', url: 'https://docs.silentsuite.io/not-a-document' },
    { domain: 'docs.silentsuite.io', name: 'pageview', url: 'https://docs.silentsuite.io/user-guide/faq?q=private' },
    { domain: 'docs.silentsuite.io', name: 'pageview', url: 'https://docs.silentsuite.io/user-guide/faq#secret' },
    { domain: 'docs.silentsuite.io', name: 'pageview', url: 'https://docs.silentsuite.io/user-guide/faq/' },
    // Raw or unregistered referrers.
    { domain: 'docs.silentsuite.io', name: 'pageview', url: 'https://docs.silentsuite.io/', referrer: 'https://evil.example/campaign' },
    { domain: 'docs.silentsuite.io', name: 'pageview', url: 'https://docs.silentsuite.io/', referrer: 'https://www.google.com/search?q=private' },
    { domain: 'docs.silentsuite.io', name: 'pageview', url: 'https://docs.silentsuite.io/', referrer: 'https://x.com/' },
    // Properties are never admitted on canonical pageviews.
    { domain: 'docs.silentsuite.io', name: 'pageview', url: 'https://docs.silentsuite.io/', props: { surface: 'docs' } },
    // Unknown or tampered event taxonomy.
    { domain: 'docs.silentsuite.io', name: 'Custom Event', url: 'https://docs.silentsuite.io/', props: { surface: 'docs' } },
    { domain: 'docs.silentsuite.io', name: 'GitHub Click', url: 'https://docs.silentsuite.io/', props: { surface: 'docs_android', channel: 'private' } },
    { domain: 'docs.silentsuite.io', name: 'GitHub Click', url: 'https://docs.silentsuite.io/', props: { surface: 'docs_android', channel: 'repository', utm_content: 'leak' } },
    { domain: 'docs.silentsuite.io', name: 'GitHub Click', url: 'https://docs.silentsuite.io/', props: { channel: 'repository' } },
    { domain: 'docs.silentsuite.io', name: 'GitHub Click', url: 'https://docs.silentsuite.io/user-guide/faq', props: { surface: 'docs_android', channel: 'repository' } },
    { domain: 'docs.silentsuite.io', name: 'GitHub Click', url: 'https://docs.silentsuite.io/' },
    // Unknown top-level keys and prototype smuggling.
    { domain: 'docs.silentsuite.io', name: 'pageview', url: 'https://docs.silentsuite.io/', screen_width: 1920 },
    { domain: 'docs.silentsuite.io', name: 'pageview', url: 'https://docs.silentsuite.io/', meta: { uid: 'private' } },
  ]

  for (const payload of rejected) {
    const relay = harness()
    const response = await relay.send(relayRequest(JSON.stringify(payload)))
    assert.equal(response.status, 204, JSON.stringify(payload))
    assert.deepEqual(relay.upstreamCalls, [], JSON.stringify(payload))
  }
})

test('rejects malformed bodies without forwarding', async () => {
  for (const body of [
    '', 'not json', '[]', 'null', '"pageview"', '42',
    '{"domain":"docs.silentsuite.io","name":"pageview","url":"https://docs.silentsuite.io/"',
    '{"__proto__":{"admin":true},"domain":"docs.silentsuite.io","name":"pageview","url":"https://docs.silentsuite.io/"}',
    '{"domain":"docs.silentsuite.io","name":"pageview","url":123}',
    '{"domain":"docs.silentsuite.io","name":123,"url":"https://docs.silentsuite.io/"}',
  ]) {
    const relay = harness()
    const response = await relay.send(relayRequest(body))
    assert.equal(response.status, 204, body)
    assert.deepEqual(relay.upstreamCalls, [], body)
  }
})

test('rejects host and origin lookalikes on the relay path', async () => {
  for (const overrides of [
    { url: `https://docs.silentsuite.io.evil.example${DOCS_RELAY_PATH}` },
    { url: `https://evil-docs.silentsuite.io${DOCS_RELAY_PATH}` },
    { url: `https://silentsuite.io${DOCS_RELAY_PATH}` },
    { url: `http://docs.silentsuite.io${DOCS_RELAY_PATH}` },
    { url: `https://docs.silentsuite.io:8443${DOCS_RELAY_PATH}` },
    { headers: { origin: 'https://docs.silentsuite.io.evil.example' } },
    { headers: { origin: 'https://silentsuite.io' } },
    { headers: { origin: 'http://docs.silentsuite.io' } },
    { headers: { origin: 'https://docs.silentsuite.io/' } },
    { headers: { origin: 'null' } },
    { headers: { origin: '' } },
  ]) {
    const relay = harness()
    const response = await relay.send(relayRequest(PAGEVIEW, overrides))
    assert.equal(response.status, 204, JSON.stringify(overrides))
    assert.deepEqual(relay.upstreamCalls, [], JSON.stringify(overrides))
    assert.deepEqual(relay.assetRequests, [], JSON.stringify(overrides))
  }
})

test('does not admit query-bearing relay paths', async () => {
  const relay = harness()
  const response = await relay.send(relayRequest(PAGEVIEW, { url: `${RELAY_URL}?secret=value` }))
  assert.equal(response.status, 200)
  assert.deepEqual(relay.upstreamCalls, [])
  assert.equal(relay.assetRequests.length, 1)
})

test('rejects content types outside the CORS-simple text vocabulary', async () => {
  for (const contentType of ['application/json', 'text/plain', 'multipart/form-data', 'application/x-www-form-urlencoded', '']) {
    const relay = harness()
    const response = await relay.send(relayRequest(PAGEVIEW, { headers: { 'content-type': contentType } }))
    assert.equal(response.status, 204, contentType)
    assert.deepEqual(relay.upstreamCalls, [], contentType)
  }
})

test('admits the content type regardless of casing and optional whitespace', async () => {
  for (const contentType of ['text/plain;charset=UTF-8', 'text/plain; charset=utf-8', 'TEXT/PLAIN;CHARSET=UTF-8']) {
    const relay = harness()
    await relay.send(relayRequest(PAGEVIEW, { headers: { 'content-type': contentType } }))
    assert.equal(relay.upstreamCalls.length, 1, contentType)
  }
})

test('caps the admitted request body size', async () => {
  const oversized = `{"domain":"docs.silentsuite.io","name":"pageview","url":"https://docs.silentsuite.io/","pad":"${'a'.repeat(DOCS_RELAY_MAX_BODY_BYTES)}"}`
  assert.ok(oversized.length > DOCS_RELAY_MAX_BODY_BYTES)

  for (const headers of [{}, { 'content-length': String(oversized.length) }]) {
    const relay = harness()
    const response = await relay.send(relayRequest(oversized, { headers }))
    assert.equal(response.status, 204)
    assert.deepEqual(relay.upstreamCalls, [])
  }
})

test('rejects a declared content length above the cap before reading the body', async () => {
  const relay = harness()

  const response = await relay.send(relayRequest(PAGEVIEW, {
    headers: { 'content-length': String(DOCS_RELAY_MAX_BODY_BYTES + 1) },
  }))

  assert.equal(response.status, 204)
  assert.deepEqual(relay.upstreamCalls, [])
})

test('forwards the Cloudflare client IP as X-Plausible-IP and passes the User-Agent', async () => {
  const relay = harness()

  await relay.send(relayRequest(PAGEVIEW))

  const headers = new Headers(relay.upstreamCalls[0].init.headers)
  assert.equal(headers.get('x-plausible-ip'), '203.0.113.7')
  assert.equal(headers.get('user-agent'), 'Mozilla/5.0 (X11; Linux x86_64) Docs/1.0')
  assert.equal(headers.get('content-type'), 'application/json')
  assert.equal(headers.get('x-forwarded-for'), null)
})

test('rebuilds forwarded headers instead of trusting client-supplied identity headers', async () => {
  const relay = harness()

  await relay.send(relayRequest(PAGEVIEW, {
    headers: {
      'x-plausible-ip': '198.51.100.9',
      'x-forwarded-for': '198.51.100.9',
      cookie: 'session=private',
      authorization: 'Bearer private',
      referer: 'https://docs.silentsuite.io/user-guide/faq?q=private',
    },
  }))

  const headers = new Headers(relay.upstreamCalls[0].init.headers)
  assert.equal(headers.get('x-plausible-ip'), '203.0.113.7')
  assert.equal(headers.get('x-forwarded-for'), null)
  assert.equal(headers.get('cookie'), null)
  assert.equal(headers.get('authorization'), null)
  assert.equal(headers.get('referer'), null)
})

test('omits forwarded headers entirely when the edge supplies none', async () => {
  const relay = harness()

  await relay.send(relayRequest(PAGEVIEW, { headers: { 'cf-connecting-ip': '', 'user-agent': '' } }))

  const headers = new Headers(relay.upstreamCalls[0].init.headers)
  assert.equal(headers.get('x-plausible-ip'), null)
  assert.equal(headers.get('user-agent'), null)
})

test('returns a fixed no-store 204 when the upstream fails or throws', async () => {
  for (const upstream of [
    async () => new Response('upstream detail', { status: 500, headers: { 'x-upstream': 'leak' } }),
    async () => new Response('rate limited', { status: 429 }),
    async () => { throw new Error('upstream unreachable') },
  ]) {
    const relay = harness(upstream)
    const response = await relay.send(relayRequest(PAGEVIEW))
    assert.equal(response.status, 204)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-upstream'), null)
    assert.equal(await response.text(), '')
    assert.equal(relay.upstreamCalls.length, 1)
  }
})

test('answers non-POST relay requests with 405 and never forwards them', async () => {
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
    const relay = harness()
    const response = await relay.send(relayRequest(PAGEVIEW, { method }))
    assert.equal(response.status, 405, method)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(relay.upstreamCalls, [], method)
    assert.deepEqual(relay.assetRequests, [], method)
  }
})

test('falls through to the assets binding for every ordinary docs request', async () => {
  for (const [url, method] of [
    ['https://docs.silentsuite.io/', 'GET'],
    ['https://docs.silentsuite.io/user-guide/faq', 'GET'],
    ['https://docs.silentsuite.io/assets/app.js', 'GET'],
    ['https://docs.silentsuite.io/api/event/extra', 'GET'],
    ['https://docs.silentsuite.io/api/events', 'POST'],
    ['https://docs.silentsuite.io/deployment-identity.json', 'GET'],
  ] as const) {
    const relay = harness()
    const response = await relay.send(new Request(url, method === 'POST' ? { method, body: '{}' } : { method }))
    assert.equal(response.status, 200, url)
    assert.equal(await response.text(), 'static asset', url)
    assert.equal(relay.assetRequests.length, 1, url)
    assert.deepEqual(relay.upstreamCalls, [], url)
  }
})

test('relay source neither logs nor persists request data', async () => {
  const directory = new URL('./', import.meta.url)
  for (const entry of await readdir(directory)) {
    if (!entry.endsWith('.mts') || entry.endsWith('.test.mts')) continue
    const source = await readFile(new URL(entry, directory), 'utf8')
    for (const forbidden of ['console.', 'caches', 'KVNamespace', 'D1Database', 'X-Forwarded-For', 'x-forwarded-for']) {
      assert.equal(source.includes(forbidden), false, `${entry} contains ${forbidden}`)
    }
  }
})
