'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { buildSignupPageviewPayload } from '@/app/lib/public-analytics'

const PLAUSIBLE_EVENT_ENDPOINT = 'https://plausible.silentsuite.io/api/event'

export function shouldSendSignupAnalytics(
  location: URL,
  enabled = process.env.NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED,
): boolean {
  return enabled === 'true'
    && location.protocol === 'https:'
    && location.hostname === 'app.silentsuite.io'
    && (location.pathname === '/signup' || location.pathname.startsWith('/signup/'))
}

type SignupPageviewTransport = {
  pageUrl: string
  referrer: string
  beacon?: (url: string, data: Blob) => boolean
  fetcher?: typeof fetch
}

export function sendSignupPageview({
  pageUrl,
  referrer,
  beacon,
  fetcher = fetch,
}: SignupPageviewTransport): void {
  const payload = JSON.stringify(buildSignupPageviewPayload(pageUrl, referrer))

  if (beacon) {
    const blob = new Blob([payload], { type: 'application/json' })
    beacon(PLAUSIBLE_EVENT_ENDPOINT, blob)
    return
  }

  void fetcher(PLAUSIBLE_EVENT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  })
}

export function SignupAnalytics() {
  const pathname = usePathname()

  useEffect(() => {
    if (!pathname?.startsWith('/signup')) return
    const location = new URL(window.location.href)
    if (!shouldSendSignupAnalytics(location)) return

    sendSignupPageview({
      pageUrl: location.href,
      referrer: document.referrer,
      beacon: navigator.sendBeacon?.bind(navigator),
    })
  }, [pathname])

  return null
}
