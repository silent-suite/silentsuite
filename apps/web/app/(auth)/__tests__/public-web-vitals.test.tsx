import { describe, expect, it, vi } from 'vitest'

import { createPublicVitalsSession, sendWebVital } from '../public-web-vitals'
import {
  buildWebVitalPayload,
  rateWebVital,
  WEB_VITALS_PAGES,
  webVitalsPageFor,
  type WebVitalPayload,
} from '@/app/lib/web-vitals'
import { SIGNUP_ANALYTICS_PATHS } from '@/app/lib/public-analytics'

/** A minimal window whose history moves the location like a browser does. */
function fakeWindow(start: string) {
  let href = new URL(start).href
  const listeners = new Map<string, Array<(event: Event) => void>>()
  const location = {
    get href() { return href },
    get pathname() { return new URL(href).pathname },
    get protocol() { return new URL(href).protocol },
    get hostname() { return new URL(href).hostname },
  }
  const move = (url?: string | URL | null) => { if (url !== undefined && url !== null) href = new URL(String(url), href).href }
  const history = {
    pushState: vi.fn((_data: unknown, _unused: string, url?: string | URL | null) => move(url)),
    replaceState: vi.fn((_data: unknown, _unused: string, url?: string | URL | null) => move(url)),
  }
  return {
    spies: { ...history },
    win: {
      location,
      history,
      addEventListener: (type: string, listener: (event: Event) => void) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    },
    dispatch(type: string, event: Partial<PageTransitionEvent> = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event as Event)
    },
    back(url: string) {
      href = new URL(url, href).href
      this.dispatch('popstate')
    },
  }
}

function session(start: string, entry: string | null = start) {
  const sent: WebVitalPayload[] = []
  const browser = fakeWindow(start)
  const vitals = createPublicVitalsSession({ win: browser.win, entryUrl: entry ?? undefined, send: (payload) => sent.push(payload) })
  return { sent, browser, vitals }
}

describe('web vitals contract', () => {
  it.each([
    ['LCP', 2500, 'good'], ['LCP', 2501, 'needs-improvement'], ['LCP', 4000, 'needs-improvement'], ['LCP', 4001, 'poor'],
    ['INP', 200, 'good'], ['INP', 201, 'needs-improvement'], ['INP', 500, 'needs-improvement'], ['INP', 501, 'poor'],
    ['CLS', 0.1, 'good'], ['CLS', 0.11, 'needs-improvement'], ['CLS', 0.25, 'needs-improvement'], ['CLS', 0.26, 'poor'],
    ['TTFB', 800, 'good'], ['TTFB', 801, 'needs-improvement'], ['TTFB', 1800, 'needs-improvement'], ['TTFB', 1801, 'poor'],
  ] as const)('rates %s %d as %s', (metric, value, rating) => {
    expect(rateWebVital(metric, value)).toBe(rating)
  })

  it('rejects impossible values', () => {
    expect(rateWebVital('LCP', -1)).toBeUndefined()
    expect(rateWebVital('LCP', Number.NaN)).toBeUndefined()
    expect(rateWebVital('CLS', Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  it('lists only public pages, separately from the pageview routes', () => {
    for (const page of WEB_VITALS_PAGES) expect(page).toMatch(/^\/(?:login|verify-email|signup(?:\/[a-z-]+)?)$/)
    for (const page of ['/', '/calendar', '/contacts', '/tasks', '/notes', '/settings', '/settings/subscription', '/admin', '/offline', '/login/', '/signup?x=1']) {
      expect(webVitalsPageFor(page)).toBeUndefined()
    }
    // Adding speed pages must not add pageview routes.
    expect(SIGNUP_ANALYTICS_PATHS).toEqual(['/signup', '/signup/pending-payment', '/signup/success', '/signup/cancel'])
  })

  it('builds a property-limited event without the measured value', () => {
    expect(buildWebVitalPayload('INP', 'poor', '/login')).toEqual({
      domain: 'app.silentsuite.io',
      name: 'Web Vital',
      url: 'https://app.silentsuite.io/login',
      props: { metric: 'INP', rating: 'poor', page: '/login' },
    })
  })
})

describe('public web vitals session', () => {
  it('sends each supported metric once, labelled with the public entry page', () => {
    const { sent, vitals } = session('https://app.silentsuite.io/login')
    vitals.report({ name: 'LCP', value: 1200, navigationType: 'navigate' })
    vitals.report({ name: 'LCP', value: 5200, navigationType: 'navigate' })
    vitals.report({ name: 'FCP', value: 100 })
    vitals.report({ name: 'FID', value: 10 })
    vitals.report({ name: 'TTFB', value: 900 })
    expect(sent).toEqual([buildWebVitalPayload('LCP', 'good', '/login'), buildWebVitalPayload('TTFB', 'needs-improvement', '/login')])
  })

  it('drops every vital once the sign-in page replaces itself with a logged-in screen', () => {
    const { sent, browser, vitals } = session('https://app.silentsuite.io/login')
    vitals.report({ name: 'LCP', value: 1000 })
    browser.win.history.replaceState(null, '', '/calendar')
    // Final INP and CLS arrive on pagehide, after the navigation.
    vitals.report({ name: 'INP', value: 100 })
    vitals.report({ name: 'CLS', value: 0.01 })
    expect(sent).toEqual([buildWebVitalPayload('LCP', 'good', '/login')])
    expect(browser.spies.replaceState).toHaveBeenCalledTimes(1)
  })

  it('stays stopped even when the user comes back to a public page', () => {
    const { sent, browser, vitals } = session('https://app.silentsuite.io/login')
    browser.win.history.pushState(null, '', '/notes')
    browser.win.history.pushState(null, '', '/login')
    vitals.report({ name: 'CLS', value: 0.5 })
    expect(sent).toEqual([])
  })

  it('stops when back/forward history leaves the public pages', () => {
    const { sent, browser, vitals } = session('https://app.silentsuite.io/signup')
    browser.back('/settings/subscription')
    browser.back('/signup')
    vitals.report({ name: 'INP', value: 50 })
    expect(sent).toEqual([])
  })

  it('keeps the entry label across public-to-public navigation', () => {
    const { sent, browser, vitals } = session('https://app.silentsuite.io/login')
    browser.win.history.pushState(null, '', '/signup?step=account')
    browser.win.history.replaceState({ __NA: true }, '')
    vitals.report({ name: 'CLS', value: 0.3 })
    expect(sent).toEqual([buildWebVitalPayload('CLS', 'poor', '/login')])
  })

  it('reports nothing for a document that entered on a logged-in screen', () => {
    const { sent, browser, vitals } = session('https://app.silentsuite.io/login', 'https://app.silentsuite.io/calendar')
    vitals.report({ name: 'LCP', value: 100 })
    expect(sent).toEqual([])
    // A stopped session leaves history alone.
    expect(browser.win.history.pushState).toBe(browser.spies.pushState)
    expect(browser.win.history.replaceState).toBe(browser.spies.replaceState)
  })

  it('reports nothing without a navigation entry', () => {
    const { sent, vitals } = session('https://app.silentsuite.io/login', null)
    vitals.report({ name: 'LCP', value: 100 })
    expect(sent).toEqual([])
  })

  it('starts no new reporting after a back/forward cache restore', () => {
    const { sent, browser, vitals } = session('https://app.silentsuite.io/signup')
    browser.dispatch('pageshow', { persisted: false })
    vitals.report({ name: 'TTFB', value: 100 })
    browser.dispatch('pageshow', { persisted: true })
    vitals.report({ name: 'LCP', value: 100, navigationType: 'back-forward-cache' })
    vitals.report({ name: 'INP', value: 100 })
    expect(sent).toEqual([buildWebVitalPayload('TTFB', 'good', '/signup')])
  })

  it('ignores metrics marked as restored from the back/forward cache', () => {
    const { sent, vitals } = session('https://app.silentsuite.io/signup')
    vitals.report({ name: 'LCP', value: 100, navigationType: 'back-forward-cache' })
    vitals.report({ name: 'LCP', value: 100, navigationType: 'navigate' })
    expect(sent).toEqual([buildWebVitalPayload('LCP', 'good', '/signup')])
  })
})

describe('web vital sender', () => {
  it('posts to the same-origin relay with beacon first and keepalive fetch as fallback', async () => {
    const payload = buildWebVitalPayload('LCP', 'good', '/login')
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }))
    sendWebVital(payload, () => true, fetcher)
    expect(fetcher).not.toHaveBeenCalled()
    sendWebVital(payload, () => false, fetcher)
    expect(fetcher).toHaveBeenCalledWith('/api/event', expect.objectContaining({ method: 'POST', keepalive: true, body: JSON.stringify(payload) }))
  })
})
