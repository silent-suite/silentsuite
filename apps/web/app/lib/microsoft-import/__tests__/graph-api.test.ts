import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ token: 'EwBIA8l6BAAU.secret-access-token' as string | null }))
vi.mock('../oauth', () => ({ getMicrosoftAccessToken: () => auth.token }))

import { GRAPH_API, GraphApiError, MAX_PAGES, graphGet, graphGetAllPages } from '../graph-api'

const TOKEN = 'EwBIA8l6BAAU.secret-access-token'
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init })

function fakeFetch(...responses: (Response | (() => Response))[]) {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => {
    const next = responses.shift()
    if (!next) throw new Error('unexpected request')
    return typeof next === 'function' ? next() : next
  })
  return fetcher
}

const noSleep = () => vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined)

function expectNoLeak(err: unknown) {
  expect(err).toBeInstanceOf(GraphApiError)
  const text = `${(err as Error).message} ${(err as Error).stack ?? ''} ${JSON.stringify(err)}`
  for (const leak of [TOKEN, 'graph.microsoft.com', 'Bearer', 'Ann Lee']) expect(text).not.toContain(leak)
}

describe('Microsoft Graph reads', () => {
  beforeEach(() => {
    auth.token = TOKEN
  })

  it('sends the token only to Graph, with the fixed headers and fetch options', async () => {
    const fetcher = fakeFetch(json({ id: 'cal-1' }))
    const controller = new AbortController()
    await expect(graphGet(`${GRAPH_API}/me/calendars/cal-1`, { fetcher: fetcher as unknown as typeof fetch, signal: controller.signal })).resolves.toEqual({ id: 'cal-1' })
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe(`${GRAPH_API}/me/calendars/cal-1`)
    expect(init).toEqual({
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/json',
        Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"',
      },
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    })
  })

  it.each([
    'https://graph.microsoft.com/beta/me/events',
    'https://graph.microsoft.com/v1.0',
    'https://graph.microsoft.com/v1.0/../beta/me/events',
    'https://graph.microsoft.com.evil.example/v1.0/me',
    'https://evil.example/v1.0/me?u=https://graph.microsoft.com/v1.0/',
    'http://graph.microsoft.com/v1.0/me',
  ])('refuses %s before any request', async (url) => {
    const fetcher = fakeFetch(json({}))
    const err = await graphGet(url, { fetcher: fetcher as unknown as typeof fetch }).catch((e: unknown) => e)
    expect(err).toMatchObject({ name: 'GraphApiError', status: 0 })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('accepts a URL object', async () => {
    const fetcher = fakeFetch(json({ ok: 1 }))
    const url = new URL(`${GRAPH_API}/me/contactFolders`)
    url.searchParams.set('$top', '100')
    await graphGet(url, { fetcher: fetcher as unknown as typeof fetch })
    expect(fetcher.mock.calls[0]![0]).toBe(`${GRAPH_API}/me/contactFolders?%24top=100`)
  })

  it('fails as signed out without a token, before any request', async () => {
    auth.token = null
    const fetcher = fakeFetch(json({}))
    await expect(graphGet(`${GRAPH_API}/me/calendars`, { fetcher: fetcher as unknown as typeof fetch })).rejects.toMatchObject({ status: 401 })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('follows @odata.nextLink through every page', async () => {
    const fetcher = fakeFetch(
      json({ value: [{ id: 'a' }, { id: 'b' }], '@odata.nextLink': `${GRAPH_API}/me/calendars?$skiptoken=p2` }),
      json({ value: [{ id: 'c' }], '@odata.nextLink': `${GRAPH_API}/me/calendars?$skiptoken=p3` }),
      json({ value: [] }),
    )
    const items = await graphGetAllPages<{ id: string }>(`${GRAPH_API}/me/calendars`, { fetcher: fetcher as unknown as typeof fetch })
    expect(items.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `${GRAPH_API}/me/calendars`,
      `${GRAPH_API}/me/calendars?$skiptoken=p2`,
      `${GRAPH_API}/me/calendars?$skiptoken=p3`,
    ])
  })

  it('reads another items key', async () => {
    const fetcher = fakeFetch(json({ exceptionOccurrences: [{ id: 'x' }] }))
    await expect(graphGetAllPages(`${GRAPH_API}/me/events/e1`, { fetcher: fetcher as unknown as typeof fetch }, 'exceptionOccurrences')).resolves.toEqual([{ id: 'x' }])
  })

  it.each([
    'https://evil.example/v1.0/me/calendars?$skiptoken=p2',
    'https://graph.microsoft.com/beta/me/calendars?$skiptoken=p2',
    42,
  ])('refuses a next link to %s without sending the token there', async (link) => {
    const fetcher = fakeFetch(json({ value: [{ id: 'a' }], '@odata.nextLink': link }), json({ value: [] }))
    const err = await graphGetAllPages(`${GRAPH_API}/me/calendars`, { fetcher: fetcher as unknown as typeof fetch }).catch((e: unknown) => e)
    expect(err).toMatchObject({ status: 0 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('fails on a page without the items array', async () => {
    const fetcher = fakeFetch(json({ error: 'nope' }))
    await expect(graphGetAllPages(`${GRAPH_API}/me/calendars`, { fetcher: fetcher as unknown as typeof fetch })).rejects.toMatchObject({ status: 0 })
  })

  it('stops after MAX_PAGES', async () => {
    const fetcher = vi.fn(async () => json({ value: [], '@odata.nextLink': `${GRAPH_API}/me/calendars?$skiptoken=again` }))
    await expect(graphGetAllPages(`${GRAPH_API}/me/calendars`, { fetcher: fetcher as unknown as typeof fetch })).rejects.toMatchObject({ status: 0 })
    expect(fetcher).toHaveBeenCalledTimes(MAX_PAGES)
  })

  it.each([
    ['seconds', '7', 7000],
    ['a value above 30 s, clamped', '120', 30_000],
    ['zero, clamped to 1 s', '0', 1000],
    ['an unparseable value, the default', 'soon', 2000],
  ])('waits Retry-After as %s, then retries', async (_, header, waited) => {
    const sleep = noSleep()
    const fetcher = fakeFetch(new Response(null, { status: 429, headers: { 'Retry-After': header } }), json({ ok: true }))
    await expect(graphGet(`${GRAPH_API}/me/calendars`, { fetcher: fetcher as unknown as typeof fetch, sleep })).resolves.toEqual({ ok: true })
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([waited])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('accepts Retry-After as an HTTP date', async () => {
    const sleep = noSleep()
    const at = new Date(Date.now() + 10_000).toUTCString()
    const fetcher = fakeFetch(new Response(null, { status: 503, headers: { 'Retry-After': at } }), json({ ok: true }))
    await graphGet(`${GRAPH_API}/me/calendars`, { fetcher: fetcher as unknown as typeof fetch, sleep })
    expect(sleep.mock.calls[0]![0]).toBeGreaterThanOrEqual(8000)
    expect(sleep.mock.calls[0]![0]).toBeLessThanOrEqual(10_000)
  })

  it.each([429, 503, 504])('retries %s at most three times with the 2/4/8 s default, then fails as limiting', async (status) => {
    const sleep = noSleep()
    const fetcher = vi.fn(async () => new Response(null, { status }))
    const err = await graphGet(`${GRAPH_API}/me/calendars`, { fetcher: fetcher as unknown as typeof fetch, sleep }).catch((e: unknown) => e)
    expect(err).toMatchObject({ name: 'GraphApiError', status, message: 'Microsoft is limiting requests right now. Please try again in a few minutes.' })
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 4000, 8000])
    expectNoLeak(err)
  })

  it('aborts a throttling wait and sends no further request', async () => {
    const controller = new AbortController()
    const fetcher = fakeFetch(new Response(null, { status: 429, headers: { 'Retry-After': '30' } }), json({ ok: true }))
    const pending = graphGet(`${GRAPH_API}/me/calendars`, { fetcher: fetcher as unknown as typeof fetch, signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('passes the signal to the injected sleep', async () => {
    const controller = new AbortController()
    const sleep = vi.fn(async (_ms: number, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal)
      controller.abort()
      throw signal!.reason
    })
    const fetcher = fakeFetch(new Response(null, { status: 429 }), json({ ok: true }))
    await expect(graphGet(`${GRAPH_API}/me/calendars`, { fetcher: fetcher as unknown as typeof fetch, sleep, signal: controller.signal })).rejects.toBeDefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([
    [401, 'Your Microsoft sign-in expired. Please start the import again.'],
    [403, 'Microsoft refused access to this data.'],
    [404, 'Microsoft could not be reached. Please try again.'],
    [500, 'Microsoft could not be reached. Please try again.'],
  ])('fails on %s with a fixed message and no URL, token or body', async (status, message) => {
    const sleep = noSleep()
    const body = { error: { code: 'ErrorAccessDenied', message: `Bearer ${TOKEN} https://graph.microsoft.com/v1.0/me Ann Lee` } }
    const fetcher = fakeFetch(json(body, { status }))
    const err = await graphGet(`${GRAPH_API}/me/calendars`, { fetcher: fetcher as unknown as typeof fetch, sleep }).catch((e: unknown) => e)
    expect(err).toMatchObject({ name: 'GraphApiError', status, message })
    expect(sleep).not.toHaveBeenCalled()
    expectNoLeak(err)
  })

  it('turns a network failure or an unreadable body into a fixed error', async () => {
    const down = vi.fn(async () => { throw new TypeError(`Failed to fetch ${GRAPH_API}/me Bearer ${TOKEN}`) })
    const err = await graphGet(`${GRAPH_API}/me/calendars`, { fetcher: down as unknown as typeof fetch }).catch((e: unknown) => e)
    expect(err).toMatchObject({ status: 0 })
    expectNoLeak(err)

    const garbled = fakeFetch(new Response('<html>Ann Lee</html>', { status: 200 }))
    const err2 = await graphGet(`${GRAPH_API}/me/calendars`, { fetcher: garbled as unknown as typeof fetch }).catch((e: unknown) => e)
    expect(err2).toMatchObject({ status: 0 })
    expectNoLeak(err2)
  })

  it('rethrows the abort error when the request is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => { throw init.signal!.reason })
    await expect(graphGet(`${GRAPH_API}/me/calendars`, { fetcher: fetcher as unknown as typeof fetch, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
