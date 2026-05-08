'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

const PLAUSIBLE_EVENT_ENDPOINT = 'https://plausible.silentsuite.io/api/event'
const PLAUSIBLE_DOMAIN = 'app.silentsuite.io'
const MARKETING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']

function signupAnalyticsUrl() {
  const current = new URL(window.location.href)
  const sanitized = new URL(`${current.origin}${current.pathname}`)

  if (current.pathname === '/signup') {
    for (const param of MARKETING_PARAMS) {
      const value = current.searchParams.get(param)
      if (value) sanitized.searchParams.set(param, value)
    }
  }

  return sanitized.toString()
}

function sanitizedReferrer() {
  if (!document.referrer) return undefined

  try {
    const referrer = new URL(document.referrer)
    return `${referrer.origin}${referrer.pathname}`
  } catch {
    return undefined
  }
}

export function SignupAnalytics() {
  const pathname = usePathname()

  useEffect(() => {
    if (!pathname?.startsWith('/signup')) return

    const payload = JSON.stringify({
      domain: PLAUSIBLE_DOMAIN,
      name: 'pageview',
      url: signupAnalyticsUrl(),
      referrer: sanitizedReferrer(),
    })

    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' })
      navigator.sendBeacon(PLAUSIBLE_EVENT_ENDPOINT, blob)
      return
    }

    void fetch(PLAUSIBLE_EVENT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    })
  }, [pathname])

  return null
}
