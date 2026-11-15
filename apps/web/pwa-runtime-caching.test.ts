// @vitest-environment node
import Module, { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(path.join(__dirname, 'next.config.js'))
// Loaded by Node itself: the pinned next-pwa's own default runtime caching rules.
const nextPwaDefaults = (require('@ducanh2912/next-pwa') as { runtimeCaching: unknown[] }).runtimeCaching
type Rule = { urlPattern: RegExp | ((ctx: { url: URL; sameOrigin: boolean; request: Request }) => boolean) | string; handler: string; method?: string; options?: { cacheName?: string } }

/** The options next.config.js hands to next-pwa, captured without building. */
function pwaOptions(): { extendDefaultRuntimeCaching?: boolean; workboxOptions?: { runtimeCaching?: Rule[]; skipWaiting?: boolean; clientsClaim?: boolean } } {
  const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown }
  const original = loader._load
  let captured: unknown
  loader._load = function (request: string, ...rest: unknown[]) {
    if (request === '@ducanh2912/next-pwa') {
      return { default: (options: unknown) => { captured = options; return (config: unknown) => config } }
    }
    return original.call(this, request, ...rest)
  }
  try {
    delete require.cache[require.resolve('./next.config.js')]
    require('./next.config.js')
  } finally {
    loader._load = original
  }
  return captured as ReturnType<typeof pwaOptions>
}

/** Workbox picks the first registered route that matches; next-pwa registers ours before its defaults. */
function firstMatch(rules: Rule[], href: string): Rule | undefined {
  const url = new URL(href)
  const sameOrigin = url.origin === 'https://app.silentsuite.io'
  const request = new Request(href, { headers: { Authorization: 'Bearer x' } })
  return rules.find((rule) => {
    if (rule.method && rule.method !== 'GET') return false
    if (typeof rule.urlPattern === 'string') return url.href === new URL(rule.urlPattern || '/', 'https://app.silentsuite.io').href
    if (rule.urlPattern instanceof RegExp) {
      const match = rule.urlPattern.exec(url.href)
      // Workbox ignores a cross-origin RegExp match that does not start at index 0.
      return Boolean(match) && (sameOrigin || match!.index === 0)
    }
    return rule.urlPattern({ url, sameOrigin, request })
  })
}

describe('service worker never caches Google import traffic (#48)', () => {
  const options = pwaOptions()
  const routes = [...(options.workboxOptions?.runtimeCaching ?? []), ...(nextPwaDefaults as Rule[])]

  it('puts the Google API hosts first, as NetworkOnly without a cache, ahead of the defaults', () => {
    expect(options.extendDefaultRuntimeCaching).toBe(true)
    const ours = options.workboxOptions!.runtimeCaching!
    expect(ours[0]).toMatchObject({ handler: 'NetworkOnly', method: 'GET' })
    expect(ours[0]!.options).toBeUndefined()
    // skipWaiting / clientsClaim are left at next-pwa's defaults (true): a new worker takes over open pages.
    expect(options.workboxOptions!.skipWaiting).toBeUndefined()
    expect(options.workboxOptions!.clientsClaim).toBeUndefined()
  })

  it.each([
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250',
    'https://www.googleapis.com/calendar/v3/calendars/me%40example.com/events?pageToken=p2',
    'https://people.googleapis.com/v1/people/me/connections?pageSize=1000',
  ])('%s is NetworkOnly', (href) => {
    expect(firstMatch(nextPwaDefaults as Rule[], href)?.options?.cacheName).toBe('cross-origin')
    expect(firstMatch(routes, href)).toMatchObject({ handler: 'NetworkOnly' })
    expect(firstMatch(routes, href)?.options).toBeUndefined()
  })

  it.each([
    ['https://server.silentsuite.io/api/v1/collection/', 'cross-origin'],
    ['https://fonts.googleapis.com/css2?family=Inter', 'google-fonts-stylesheets'],
    ['https://evil.example/?u=https://www.googleapis.com/', 'cross-origin'],
  ])('leaves %s to the defaults', (href, cacheName) => {
    expect(firstMatch(routes, href)?.options?.cacheName).toBe(cacheName)
  })
})

describe('service worker never caches Microsoft import traffic (#48)', () => {
  const options = pwaOptions()
  const ours = options.workboxOptions?.runtimeCaching ?? []
  const routes = [...ours, ...(nextPwaDefaults as Rule[])]

  it('registers a NetworkOnly Graph route without a cache, ahead of the defaults', () => {
    const graph = ours.find((rule) => rule.urlPattern instanceof RegExp && rule.urlPattern.test('https://graph.microsoft.com/v1.0/me'))
    expect(graph).toMatchObject({ handler: 'NetworkOnly', method: 'GET' })
    expect(graph!.options).toBeUndefined()
  })

  it.each([
    'https://graph.microsoft.com/v1.0/me/calendars',
    'https://graph.microsoft.com/v1.0/me/calendars/AAMk%3D/events?$select=subject&$top=100',
    'https://graph.microsoft.com/v1.0/me/contactFolders?$skiptoken=abc',
  ])('%s is NetworkOnly', (href) => {
    expect(firstMatch(nextPwaDefaults as Rule[], href)?.options?.cacheName).toBe('cross-origin')
    expect(firstMatch(routes, href)).toMatchObject({ handler: 'NetworkOnly' })
    expect(firstMatch(routes, href)?.options).toBeUndefined()
  })

  it('leaves look-alike hosts to the defaults', () => {
    for (const href of ['https://graph.microsoft.com.evil.example/v1.0/me', 'https://evil.example/?u=https://graph.microsoft.com/']) {
      expect(firstMatch(routes, href)?.options?.cacheName).toBe('cross-origin')
    }
  })

  it('has no route for non-GET requests, so the token POST to login.microsoftonline.com is never handled', () => {
    for (const rule of routes) expect(rule.method ?? 'GET').toBe('GET')
  })
})
