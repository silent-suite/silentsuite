import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createSignupStepRecorder,
  sendCommercialEvent,
  shouldSendCommercialAnalytics,
  signupStepFor,
} from '../commercial-funnel-analytics'
import { buildCheckoutInitiatedPayload, buildCheckoutReturnedPayload, buildPlanSelectedPayload, buildSignupStepPayload, SIGNUP_STEPS } from '@/app/lib/public-analytics'

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
    expect(endpoint).toBe('/api/event')
    expect(JSON.parse(await blob.text())).toEqual({
      domain: 'app.silentsuite.io', name: 'Plan Selected', url: 'https://app.silentsuite.io/signup', props: { plan_id: 'early_annual', customer_class: 'early', billing_interval: 'annual', annual_amount_minor: 3600, monthly_equivalent_minor: 300, currency: 'EUR' },
    })
  })

  it('uses fetch fallback only on the payload route', () => {
    const fetcher = vi.fn()
    sendCommercialEvent(buildPlanSelectedPayload(annualOffer), undefined, fetcher, new URL('https://app.silentsuite.io/signup'), 'true')
    expect(fetcher).toHaveBeenCalledWith('/api/event', expect.objectContaining({
      method: 'POST', keepalive: true,
      body: JSON.stringify({ domain: 'app.silentsuite.io', name: 'Plan Selected', url: 'https://app.silentsuite.io/signup', props: { plan_id: 'early_annual', customer_class: 'early', billing_interval: 'annual', annual_amount_minor: 3600, monthly_equivalent_minor: 300, currency: 'EUR' } }),
    }))
  })

  it('falls back to keepalive fetch when the beacon is refused', () => {
    const beacon = vi.fn(() => false)
    const fetcher = vi.fn()
    sendCommercialEvent(buildPlanSelectedPayload(annualOffer), beacon, fetcher, new URL('https://app.silentsuite.io/signup'), 'true')
    expect(beacon).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith('/api/event', expect.objectContaining({ method: 'POST', keepalive: true }))
  })

  it('sends nothing when the commercial flag is off', () => {
    const beacon = vi.fn(() => true)
    const fetcher = vi.fn()
    sendCommercialEvent(buildSignupStepPayload('plan_shown'), beacon, fetcher, new URL('https://app.silentsuite.io/signup'), 'false')
    expect(beacon).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('signup step events', () => {
  it('uses a fixed, identifier-free step enum', () => {
    expect(SIGNUP_STEPS).toEqual(['verification_requested', 'email_verified', 'plan_shown', 'account_created', 'completed'])
    expect(buildSignupStepPayload('email_verified')).toEqual({ domain: 'app.silentsuite.io', name: 'Signup Step', url: 'https://app.silentsuite.io/signup', props: { step: 'email_verified' } })
    expect(shouldSendCommercialAnalytics(new URL('https://app.silentsuite.io/signup'), buildSignupStepPayload('completed'), 'true')).toBe(true)
    expect(shouldSendCommercialAnalytics(new URL('https://app.silentsuite.io/signup/success'), buildSignupStepPayload('completed'), 'true')).toBe(false)
  })

  it.each([
    [{ step: 'account', awaitingEmailProof: false, usingSelfHostedServer: false }, null],
    [{ step: 'account', awaitingEmailProof: true, usingSelfHostedServer: false }, 'verification_requested'],
    [{ step: 'verifiedAccount', awaitingEmailProof: false, usingSelfHostedServer: false }, 'email_verified'],
    [{ step: 'plan', awaitingEmailProof: false, usingSelfHostedServer: false }, 'plan_shown'],
    [{ step: 'paidAccount', awaitingEmailProof: false, usingSelfHostedServer: false }, null],
    [{ step: 'vault', awaitingEmailProof: false, usingSelfHostedServer: false }, 'account_created'],
    [{ step: 'vault', awaitingEmailProof: false, usingSelfHostedServer: true }, null],
    [{ step: 'selfhost', awaitingEmailProof: false, usingSelfHostedServer: true }, null],
    [{ step: 'admin', awaitingEmailProof: false, usingSelfHostedServer: true }, null],
  ])('maps %o to %s', (view, expected) => {
    expect(signupStepFor(view)).toBe(expected)
  })

  it('records each step once per page load', () => {
    const send = vi.fn()
    const record = createSignupStepRecorder(send)
    for (const step of ['plan_shown', null, 'plan_shown', 'email_verified', 'plan_shown', 'completed'] as const) record(step)
    expect(send.mock.calls.map(([step]) => step)).toEqual(['plan_shown', 'email_verified', 'completed'])
  })
})
