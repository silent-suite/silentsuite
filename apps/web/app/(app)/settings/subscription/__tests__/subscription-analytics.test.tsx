import { describe, expect, it, vi } from 'vitest'

import { sendCommercialEvent, shouldSendCommercialAnalytics } from '@/app/(auth)/signup/commercial-funnel-analytics'
import { buildSubscriptionManagementEntryPayload } from '@/app/lib/public-analytics'

describe('subscription analytics transport boundary', () => {
  it.each(['/settings', '/settings/account', '/calendar', '/contacts', '/tasks', '/signup'])('rejects subscription entry from %s', (pathname) => {
    expect(shouldSendCommercialAnalytics(new URL(`https://app.silentsuite.io${pathname}`), buildSubscriptionManagementEntryPayload(), 'true')).toBe(false)
  })

  it('uses fetch fallback with the fixed subscription key/value payload', () => {
    const fetcher = vi.fn()
    sendCommercialEvent(buildSubscriptionManagementEntryPayload(), undefined, fetcher, new URL('https://app.silentsuite.io/settings/subscription'), 'true')
    expect(fetcher).toHaveBeenCalledWith('https://plausible.silentsuite.io/api/event', expect.objectContaining({
      method: 'POST', keepalive: true,
      body: JSON.stringify({ domain: 'app.silentsuite.io', name: 'Subscription Management Entry', url: 'https://app.silentsuite.io/settings/subscription', props: { surface: 'subscription_settings' } }),
    }))
  })
})
