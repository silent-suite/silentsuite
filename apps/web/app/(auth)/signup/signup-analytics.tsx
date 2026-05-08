'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

const PLAUSIBLE_EVENT_ENDPOINT = 'https://plausible.silentsuite.io/api/event'
const PLAUSIBLE_DOMAIN = 'app.silentsuite.io'

export function SignupAnalytics() {
  const pathname = usePathname()

  useEffect(() => {
    if (!pathname?.startsWith('/signup')) return

    const payload = JSON.stringify({
      domain: PLAUSIBLE_DOMAIN,
      name: 'pageview',
      url: window.location.href,
      referrer: document.referrer || undefined,
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
