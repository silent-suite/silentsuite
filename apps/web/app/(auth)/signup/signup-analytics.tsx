'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { buildSignupPageviewPayload } from '@/app/lib/public-analytics'

const PLAUSIBLE_EVENT_ENDPOINT = 'https://plausible.silentsuite.io/api/event'
export function SignupAnalytics() {
  const pathname = usePathname()

  useEffect(() => {
    if (!pathname?.startsWith('/signup')) return

    const payload = JSON.stringify(buildSignupPageviewPayload(window.location.href, document.referrer))

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
