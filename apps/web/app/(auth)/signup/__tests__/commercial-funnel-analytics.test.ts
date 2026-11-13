import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  sendCommercialEvent,
  shouldSendCommercialAnalytics,
} from '../commercial-funnel-analytics'
import { buildCheckoutInitiatedPayload, buildCheckoutReturnedPayload, buildPlanSelectedPayload } from '@/app/lib/public-analytics'

const annualOffer = {
  planId: 'early_annual' as const,
  customerClass: 'early' as const,
  billingInterval: 'annual' as const,
  annualAmountMinor: 3600 as const,
  monthlyEquivalentMinor: 300 as const,
  currency: 'EUR' as const,
  providers: ['stripe', 'btcpay'] as ('stripe' | 'btcpay')[],
  offerRevision: 1,
  offerToken: 'signed-offer',
  expiresAt: '2026-08-11T12:10:00Z',
}

describe('commercial funnel analytics transport boundary', () => {
  afterEach(() => vi.unstubAllEnvs())

  it.each([
    'https://app.silentsuite.io/calendar',
    'https://app.silentsuite.io/contacts',
    'https://app.silentsuite.io/tasks',
    'https://app.silentsuite.io/',
    'https://app.silentsuite.io/settings',
    'https://app.silentsuite.io/settings/subscription',
    'https://previewapp.silentsuite.io/signup',
    'http://app.silentsuite.io/signup',
  ])('rejects Plan Selected from %s', (href) => {
    expect(shouldSendCommercialAnalytics(new URL(href), buildPlanSelectedPayload(annualOffer), 'true')).toBe(false)
  })

  it('binds checkout initiation and returns to their individual registered routes', () => {
    expect(shouldSendCommercialAnalytics(new URL('https://app.silentsuite.io/signup'), buildCheckoutInitiatedPayload(annualOffer, 'stripe'), 'true')).toBe(true)
    const returned = buildCheckoutReturnedPayload('returned', 'stripe')
    expect(shouldSendCommercialAnalytics(new URL('https://app.silentsuite.io/signup/success'), returned, 'true')).toBe(true)
    expect(shouldSendCommercialAnalytics(new URL('https://app.silentsuite.io/signup'), returned, 'true')).toBe(false)
  })

  it('sends a route-bound beacon payload', async () => {
    const beacon = vi.fn(() => true)
    sendCommercialEvent(buildPlanSelectedPayload(annualOffer), beacon, vi.fn(), new URL('https://app.silentsuite.io/signup'), 'true')

    expect(beacon).toHaveBeenCalledTimes(1)
    const [endpoint, blob] = beacon.mock.calls[0]
    expect(endpoint).toBe('https://plausible.silentsuite.io/api/event')
    expect(JSON.parse(await blob.text())).toEqual({
      domain: 'app.silentsuite.io', name: 'Plan Selected', url: 'https://app.silentsuite.io/signup', props: { plan_id: 'early_annual', customer_class: 'early', billing_interval: 'annual', annual_amount_minor: 3600, monthly_equivalent_minor: 300, currency: 'EUR' },
    })
  })

  it('uses fetch fallback only on the payload route', () => {
    const fetcher = vi.fn()
    sendCommercialEvent(buildPlanSelectedPayload(annualOffer), undefined, fetcher, new URL('https://app.silentsuite.io/signup'), 'true')
    expect(fetcher).toHaveBeenCalledWith('https://plausible.silentsuite.io/api/event', expect.objectContaining({
      method: 'POST', keepalive: true,
      body: JSON.stringify({ domain: 'app.silentsuite.io', name: 'Plan Selected', url: 'https://app.silentsuite.io/signup', props: { plan_id: 'early_annual', customer_class: 'early', billing_interval: 'annual', annual_amount_minor: 3600, monthly_equivalent_minor: 300, currency: 'EUR' } }),
    }))
  })
})
