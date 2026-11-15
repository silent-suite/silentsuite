import { beforeEach, describe, expect, it, vi } from 'vitest'

const oauth = vi.hoisted(() => ({
  token: null as string | null,
  signInWithGoogle: vi.fn(),
  clearGoogleAccessToken: vi.fn(),
}))

vi.mock('../oauth', () => ({
  GOOGLE_CALENDAR_SCOPE: 'https://www.googleapis.com/auth/calendar.readonly',
  GOOGLE_CONTACTS_SCOPE: 'https://www.googleapis.com/auth/contacts.readonly',
  getGoogleAccessToken: () => oauth.token,
  signInWithGoogle: oauth.signInWithGoogle,
  clearGoogleAccessToken: oauth.clearGoogleAccessToken,
}))

import { GoogleApiError, googleGetAllPages } from '../google-api'
import { loadGoogleCalendars, loadGoogleContacts } from '../importer'
import { importSourceKey } from '../source-key'

const TOKEN = 'ya29.secret-access-token'

type Route = (url: URL) => unknown
function mockFetch(route: Route) {
  const calls: { url: URL; init: RequestInit }[] = []
  const fetcher = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input)
    calls.push({ url, init })
    const body = route(url)
    if (body instanceof Response) return body
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

beforeEach(() => {
  oauth.token = null
  oauth.signInWithGoogle.mockReset().mockImplementation(async () => { oauth.token = TOKEN })
  oauth.clearGoogleAccessToken.mockReset().mockImplementation(() => { oauth.token = null })
})

describe('Google API paging', () => {
  it('follows nextPageToken to the last page with the token only in the Authorization header', async () => {
    oauth.token = TOKEN
    const pages: Record<string, unknown> = {
      '': { items: [1, 2], nextPageToken: 'p2' },
      p2: { items: [3], nextPageToken: 'p3' },
      p3: { items: [4] },
    }
    const { fetcher, calls } = mockFetch((url) => pages[url.searchParams.get('pageToken') ?? ''])
    const items = await googleGetAllPages<number>(new URL('https://www.googleapis.com/calendar/v3/x?maxResults=2'), 'items', { fetcher })
    expect(items).toEqual([1, 2, 3, 4])
    expect(calls.map((c) => c.url.searchParams.get('pageToken'))).toEqual([null, 'p2', 'p3'])
    for (const call of calls) {
      expect(call.url.toString()).not.toContain(TOKEN)
      expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
      expect(call.init.credentials).toBe('omit')
      expect(call.init.referrerPolicy).toBe('no-referrer')
    }
  })

  it('never calls Google without a token, and errors carry no URL, body or token', async () => {
    const { fetcher } = mockFetch(() => ({}))
    await expect(googleGetAllPages(new URL('https://www.googleapis.com/a'), 'items', { fetcher })).rejects.toBeInstanceOf(GoogleApiError)
    expect(fetcher).not.toHaveBeenCalled()

    oauth.token = TOKEN
    const failing = mockFetch(() => new Response(`{"error":"${TOKEN} private data"}`, { status: 500 }))
    const err = await googleGetAllPages(new URL('https://www.googleapis.com/a?q=secret'), 'items', { fetcher: failing.fetcher }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(GoogleApiError)
    expect(`${(err as Error).message} ${(err as Error).stack}`).not.toMatch(/secret|private|googleapis/)
  })
})

describe('loadGoogleCalendars', () => {
  const calendarRoute: Route = (url) => {
    if (url.pathname.endsWith('/users/me/calendarList')) {
      return url.searchParams.get('pageToken') === 'c2'
        ? { items: [{ id: 'team@group.calendar.google.com', summary: 'Team', backgroundColor: '#336699' }, { id: 'addressbook#contacts@group.v.calendar.google.com', summary: 'Birthdays' }] }
        : { items: [{ id: 'me@example.com', summary: 'me@example.com', summaryOverride: 'Personal', primary: true, timeZone: 'Europe/Berlin' }], nextPageToken: 'c2' }
    }
    expect(url.searchParams.get('singleEvents')).toBe('false')
    if (url.pathname.includes('team%40group')) return { items: [{ id: 't1', iCalUID: 't1@google.com', summary: 'Team sync', start: { dateTime: '2026-06-02T10:00:00Z' }, end: { dateTime: '2026-06-02T11:00:00Z' } }] }
    if (url.pathname.includes('addressbook')) throw new Error('the birthday calendar is never read')
    return url.searchParams.get('pageToken') === 'e2'
      ? { items: [{ id: 'p2', iCalUID: 'p2@google.com', summary: 'Second page', start: { date: '2026-06-03' }, end: { date: '2026-06-04' } }] }
      : { items: [{ id: 'p1', iCalUID: 'p1@google.com', summary: 'First page', start: { dateTime: '2026-06-01T09:00:00+02:00', timeZone: 'Europe/Berlin' }, end: { dateTime: '2026-06-01T10:00:00+02:00', timeZone: 'Europe/Berlin' } }], nextPageToken: 'e2' }
  }

  it('reads every page of every calendar, keys units by account + calendar + iCalUID, and clears the token', async () => {
    const { fetcher } = mockFetch(calendarRoute)
    const result = await loadGoogleCalendars({ clientId: 'client', fetcher })
    expect(result.calendars.map((c) => [c.name, c.units.map((u) => u.summary)])).toEqual([
      ['Personal', ['First page', 'Second page']],
      ['Team', ['Team sync']],
    ])
    expect(result.calendars[1]!.color).toBe('#336699')
    expect(result.calendars[0]!.units[0]!.sourceKey).toBe(importSourceKey('google', 'me@example.com', 'me@example.com', 'p1@google.com'))
    expect(result.calendars[1]!.units[0]!.sourceKey).toBe(importSourceKey('google', 'me@example.com', 'team@group.calendar.google.com', 't1@google.com'))
    expect(oauth.clearGoogleAccessToken).toHaveBeenCalled()
    expect(oauth.token).toBeNull()
  })

  it('clears the token when reading fails', async () => {
    const { fetcher } = mockFetch(() => new Response('', { status: 403 }))
    await expect(loadGoogleCalendars({ clientId: 'client', fetcher })).rejects.toBeInstanceOf(GoogleApiError)
    expect(oauth.token).toBeNull()
  })

  it('clears the token when sign-in fails or the run is cancelled', async () => {
    oauth.signInWithGoogle.mockRejectedValueOnce(Object.assign(new Error('closed'), { name: 'GoogleAuthError' }))
    await expect(loadGoogleCalendars({ clientId: 'client' })).rejects.toThrow('closed')
    expect(oauth.clearGoogleAccessToken).toHaveBeenCalledTimes(1)

    const controller = new AbortController()
    controller.abort()
    const { fetcher } = mockFetch(calendarRoute)
    await expect(loadGoogleCalendars({ clientId: 'client', fetcher, signal: controller.signal })).rejects.toThrow(/cancelled/)
    expect(fetcher).not.toHaveBeenCalled()
    expect(oauth.token).toBeNull()
  })
})

describe('loadGoogleContacts', () => {
  it('reads the account, all group and connection pages, and clears the token', async () => {
    const { fetcher, calls } = mockFetch((url) => {
      if (url.pathname.endsWith('/people/me')) return { resourceName: 'people/1234' }
      if (url.pathname.endsWith('/contactGroups')) return { contactGroups: [{ resourceName: 'contactGroups/abc', name: 'Family', groupType: 'USER_CONTACT_GROUP' }] }
      return url.searchParams.get('pageToken') === 'n2'
        ? { connections: [{ resourceName: 'people/c2', names: [{ displayName: 'Bob' }] }] }
        : { connections: [{ resourceName: 'people/c1', names: [{ displayName: 'Ann' }], memberships: [{ contactGroupMembership: { contactGroupResourceName: 'contactGroups/abc' } }] }], nextPageToken: 'n2' }
    })
    const cards = await loadGoogleContacts({ clientId: 'client', fetcher })
    expect(cards.map((c) => [c.fn, c.categories ?? []])).toEqual([['Ann', ['Family']], ['Bob', []]])
    expect(cards[0]!.sourceKey).toBe(importSourceKey('google', 'people/1234', 'connections', 'people/c1'))
    expect(oauth.signInWithGoogle).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['https://www.googleapis.com/auth/contacts.readonly'] }))
    expect(calls.every((c) => c.url.hostname === 'people.googleapis.com')).toBe(true)
    expect(oauth.token).toBeNull()
  })
})
