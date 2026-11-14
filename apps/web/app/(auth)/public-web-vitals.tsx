'use client'

import { useEffect } from 'react'
import { useReportWebVitals } from 'next/web-vitals'
import {
  buildWebVitalPayload,
  isWebVitalMetric,
  rateWebVital,
  webVitalsPageFor,
  type WebVitalPayload,
} from '@/app/lib/web-vitals'

// Same-origin relay (app/api/event/route.ts); the browser never contacts the analytics host.
const ANALYTICS_RELAY_ENDPOINT = '/api/event'

// Own build gate, default off: no workflow sets it until the privacy page and
// the legal basis are settled. The relay has a second, server-side gate.
const WEB_VITALS_BUILD_ENABLED = process.env.NEXT_PUBLIC_WEB_VITALS_ENABLED === 'true'

type VitalMetric = { name: string; value: number; navigationType?: string }
type SessionWindow = {
  location: Pick<Location, 'href' | 'pathname' | 'protocol' | 'hostname'>
  history: Pick<History, 'pushState' | 'replaceState'>
  addEventListener: (type: string, listener: (event: Event) => void) => void
}

export type PublicVitalsSession = { report: (metric: VitalMetric) => void }

/*
 * One measurement session per document. Ratings are labelled with the page the
 * document was loaded on, and only when that page is public. The moment the
 * document heads for any other page (router push/replace, back/forward) the
 * session stops for good, so a logged-in screen reached from the sign-in page
 * is never measured, including the final INP/CLS reported on pagehide. A page
 * restored from the back/forward cache starts no new reporting. Each metric is
 * sent at most once.
 */
export function createPublicVitalsSession({
  win,
  entryUrl,
  send,
}: {
  win: SessionWindow
  entryUrl: string | undefined
  send: (payload: WebVitalPayload) => void
}): PublicVitalsSession {
  let entryPage: ReturnType<typeof webVitalsPageFor>
  try {
    entryPage = entryUrl ? webVitalsPageFor(new URL(entryUrl).pathname) : undefined
  } catch {
    entryPage = undefined
  }
  let stopped = entryPage === undefined
  const sent = new Set<string>()

  const stopUnlessPublic = (target: string | URL) => {
    try {
      if (!webVitalsPageFor(new URL(String(target), win.location.href).pathname)) stopped = true
    } catch {
      stopped = true
    }
  }

  if (!stopped) {
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = win.history[method]
      win.history[method] = function patched(this: History, data: unknown, unused: string, url?: string | URL | null) {
        if (url !== undefined && url !== null) stopUnlessPublic(url)
        return original.call(this, data, unused, url)
      }
    }
    win.addEventListener('popstate', () => stopUnlessPublic(win.location.href))
    win.addEventListener('pageshow', (event) => {
      if ((event as PageTransitionEvent).persisted) stopped = true
    })
  }

  return {
    report(metric) {
      if (stopped || !entryPage) return
      if (!webVitalsPageFor(win.location.pathname)) {
        stopped = true
        return
      }
      if (metric.navigationType === 'back-forward-cache' || metric.navigationType === 'restore') return
      if (!isWebVitalMetric(metric.name) || sent.has(metric.name)) return
      const rating = rateWebVital(metric.name, metric.value)
      if (!rating) return
      sent.add(metric.name)
      send(buildWebVitalPayload(metric.name, rating, entryPage))
    },
  }
}

export function sendWebVital(payload: WebVitalPayload, beacon = navigator.sendBeacon?.bind(navigator), fetcher: typeof fetch = fetch): void {
  const body = JSON.stringify(payload)
  try {
    if (beacon && beacon(ANALYTICS_RELAY_ENDPOINT, new Blob([body], { type: 'application/json' }))) return
    void fetcher(ANALYTICS_RELAY_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => undefined)
  } catch {
    // Measurement never affects the page.
  }
}

function documentEntryUrl(): string | undefined {
  try {
    const [navigation] = performance.getEntriesByType('navigation')
    return navigation?.name || undefined
  } catch {
    return undefined
  }
}

let session: PublicVitalsSession | undefined

function ensureSession(): PublicVitalsSession | undefined {
  if (session) return session
  if (window.location.protocol !== 'https:' || window.location.hostname !== 'app.silentsuite.io') return undefined
  session = createPublicVitalsSession({ win: window, entryUrl: documentEntryUrl(), send: (payload) => sendWebVital(payload) })
  return session
}

// Stable identity: useReportWebVitals re-registers observers when it changes.
function reportPublicVital(metric: VitalMetric) {
  ensureSession()?.report(metric)
}

function PublicWebVitalsReporter() {
  useEffect(() => {
    ensureSession()
  }, [])
  useReportWebVitals(reportPublicVital)
  return null
}

/** Mounted by the sign-in/sign-up layout only. Renders nothing. */
export function PublicWebVitals() {
  return WEB_VITALS_BUILD_ENABLED ? <PublicWebVitalsReporter /> : null
}
