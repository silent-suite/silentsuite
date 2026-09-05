import { describe, expect, it, vi } from 'vitest'
import { BillingResponseError, activateAnnualCheckout, activateAuthenticatedAnnualCheckout, buildSameOriginReturnUrl, cancelAnonymousPaymentSessionRecovery, consumeSignupEmailOwnership, fetchAnonymousAnnualOffer, fetchAuthenticatedAnnualOffer, getAnonymousPaymentSessionRecovery, isRenewableAnnualOfferError, reconcileAnonymousPaymentSessionRecovery, requestSignupEmailOwnership, startAuthenticatedAnnualPayment, startSignupAnnualPayment, type BillingV2Fetch } from '../billing-v2'

const requestId = 'e91a6d70-0d4e-4352-9bdc-426d1f76d771'
const requestKey = '5fd4d86d-34de-4b82-9a66-9598ddf6e02f'
const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const offer = { contractVersion: 2, requestId, offer: { planId: 'early_annual', customerClass: 'early', billingInterval: 'annual', annualAmountMinor: 3600, monthlyEquivalentMinor: 300, currency: 'EUR', providers: ['stripe', 'btcpay'], offerRevision: 1, offerToken: 'signed-offer', expiresAt: '2026-08-10T12:10:00Z' } }
const prepaidDisclosure = { kind: 'prepaid', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: null, monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: null, firstChargeAt: null, cancelBy: null, cancelByInclusive: false, autoRenew: false, prepaid: true, refundWindowDays: 30, bonusDays: 0, periodEndRule: 'confirmation_plus_1_utc_calendar_year', renewalAt: null, entitlementEndsAt: null }
const chargeNowDisclosure = { ...prepaidDisclosure, kind: 'charge_now', renewalAmountMinor: 3600, autoRenew: true, prepaid: false }

describe('billing v2 public authority client', () => {
  it('builds only absolute same-origin HTTP(S) return URLs', () => {
    expect(buildSameOriginReturnUrl('/signup', 'https://app.example.test')).toBe('https://app.example.test/signup')
    expect(buildSameOriginReturnUrl('/signup/pending-payment', 'https://app.example.test')).toBe('https://app.example.test/signup/pending-payment')
    expect(() => buildSameOriginReturnUrl('//evil.example/path', 'https://app.example.test')).toThrow('same-origin')
    expect(() => buildSameOriginReturnUrl('https://evil.example/path', 'https://app.example.test')).toThrow('same-origin')
  })

  it('rejects relative payment return URLs before fetch', async () => {
    const fetcher = vi.fn<BillingV2Fetch>()
    await expect(startAuthenticatedAnnualPayment({ fetcher, billingApiUrl: 'https://billing.example.test', checkoutIntentToken: token, expectedAuthorityId: requestId, returnUrl: '/settings/subscription' })).rejects.toThrow('absolute HTTP')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('renders only a server offer and sends no client-derived price, class or promotion', async () => {
    const fetcher = vi.fn<BillingV2Fetch>().mockResolvedValue(new Response(JSON.stringify(offer), { status: 200 }))
    const returned = await fetchAnonymousAnnualOffer({ fetcher, billingApiUrl: 'https://billing.example.test', email: 'Customer@example.test', requestId })
    expect(returned).toEqual(offer)
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, checkoutIntentToken: token, expiresAt: '2026-08-10T12:05:00Z', disclosure: prepaidDisclosure }), { status: 200 }))
    await activateAnnualCheckout({ fetcher, billingApiUrl: 'https://billing.example.test', offer: returned, email: 'Customer@example.test', emailOwnershipToken: token, trialPath: 'immediate', provider: 'btcpay', behavior: 'prepaid_bitcoin' })
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ contractVersion: 2, offerToken: 'signed-offer', requestId, email: 'Customer@example.test', emailOwnershipToken: token, trialPath: 'immediate', provider: 'btcpay', behavior: 'prepaid_bitcoin' })
  })

  it('fails closed for malformed offers, terms and provider identifiers', async () => {
    const fetcher = vi.fn<BillingV2Fetch>().mockResolvedValue(new Response(JSON.stringify({ ...offer, offer: { ...offer.offer, planId: 'early_monthly', annualAmountMinor: 3240, monthlyEquivalentMinor: 270 } }), { status: 200 }))
    await expect(fetchAnonymousAnnualOffer({ fetcher, billingApiUrl: 'https://billing.example.test', email: 'customer@example.test', requestId })).rejects.toThrow('annual offer')
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, checkoutIntentToken: token, expiresAt: '2026-08-10T12:05:00Z', disclosure: { kind: 'prepaid' } }), { status: 200 }))
    await expect(activateAnnualCheckout({ fetcher, billingApiUrl: 'https://billing.example.test', offer, email: 'customer@example.test', emailOwnershipToken: token, trialPath: 'immediate', provider: 'btcpay', behavior: 'prepaid_bitcoin' })).rejects.toThrow('terms')
  })

  it('uses the canonical closed email, signup and authenticated payment paths without a caller-selected provider', async () => {
    const fetcher = vi.fn<BillingV2Fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, emailOwnershipToken: token, expiresAt: '2026-08-10T12:05:00Z' })))
      .mockResolvedValueOnce(new Response(JSON.stringify(offer)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, checkoutIntentToken: token, expiresAt: '2026-08-10T12:05:00Z', disclosure: chargeNowDisclosure })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, kind: 'stripe', clientSecret: 'pi_secret', paymentSessionToken: token })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, kind: 'stripe', authorityId: requestKey, clientSecret: 'pi_secret' })))
    await requestSignupEmailOwnership({ fetcher, billingApiUrl: 'https://billing.example.test', email: 'customer@example.test', requestId })
    await consumeSignupEmailOwnership({ fetcher, billingApiUrl: 'https://billing.example.test', email: 'customer@example.test', token })
    const authenticatedOffer = await fetchAuthenticatedAnnualOffer({ fetcher, billingApiUrl: 'https://billing.example.test' })
    await activateAuthenticatedAnnualCheckout({ fetcher, billingApiUrl: 'https://billing.example.test', offer: authenticatedOffer, trialPath: 'immediate', provider: 'stripe', behavior: 'immediate_card' })
    await startSignupAnnualPayment({ fetcher, billingApiUrl: 'https://billing.example.test', checkoutIntentToken: token, email: 'customer@example.test', requestKey, recoverySecret: token, wantsProductUpdates: true, rememberDevice: false, returnUrl: 'https://app.example.test/signup/success' })
    await startAuthenticatedAnnualPayment({ fetcher, billingApiUrl: 'https://billing.example.test', checkoutIntentToken: token, expectedAuthorityId: requestKey, returnUrl: 'https://app.example.test/settings/subscription' })
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['https://billing.example.test/auth/signup-email-verifications/v2', 'https://billing.example.test/auth/signup-email-verifications/v2/consume', 'https://billing.example.test/subscription/offers/v2', 'https://billing.example.test/subscription/offers/v2/activate', 'https://billing.example.test/auth/signup/payment-session/v2', 'https://billing.example.test/subscription/payment-flows/v2'])
    expect(JSON.parse(String(fetcher.mock.calls[4][1]?.body))).toEqual({ contractVersion: 2, checkoutIntentToken: token, email: 'customer@example.test', requestKey, recoverySecret: token, wantsProductUpdates: true, rememberDevice: false, returnUrl: 'https://app.example.test/signup/success' })
    expect(JSON.parse(String(fetcher.mock.calls[5][1]?.body))).toEqual({ contractVersion: 2, checkoutIntentToken: token, returnUrl: 'https://app.example.test/settings/subscription' })
  })

  it.each([
    { kind: 'stripe', clientSecret: 'pi_secret' },
    { kind: 'btcpay', checkoutUrl: 'https://btcpay.example.test/i/invoice', invoiceId: 'invoice', invoiceLookupToken: token },
  ])('rejects an authenticated $kind response for another authority', async (providerFields) => {
    const fetcher = vi.fn<BillingV2Fetch>().mockResolvedValue(new Response(JSON.stringify({
      contractVersion: 2,
      authorityId: requestKey,
      ...providerFields,
    })))
    await expect(startAuthenticatedAnnualPayment({
      fetcher,
      billingApiUrl: 'https://billing.example.test',
      checkoutIntentToken: token,
      expectedAuthorityId: requestId,
      returnUrl: 'https://app.example.test/settings/subscription',
    })).rejects.toThrow('another annual authority')
  })

  it('accepts email-proof delivery only at 202', async () => {
    const fetcher = vi.fn<BillingV2Fetch>().mockResolvedValue(new Response('{}', { status: 200 }))
    await expect(requestSignupEmailOwnership({ fetcher, billingApiUrl: 'https://billing.example.test', email: 'customer@example.test', requestId }))
      .rejects.toThrow('acknowledge')
  })

  it('keeps status and problem type for recovery decisions', async () => {
    const fetcher = vi.fn<BillingV2Fetch>().mockResolvedValue(new Response(JSON.stringify({ detail: 'terminal', type: 'payment-already-confirmed' }), { status: 409 }))
    await expect(fetchAnonymousAnnualOffer({ fetcher, billingApiUrl: 'https://billing.example.test', email: 'customer@example.test', requestId }))
      .rejects.toMatchObject<BillingResponseError>({ billingStatus: 409, billingProblemType: 'payment-already-confirmed' })
  })

  it('recognizes only the canonical 409 plan-not-purchasable offer refresh signal', () => {
    expect(isRenewableAnnualOfferError(new BillingResponseError(
      'Offer expired',
      409,
      'https://api.silentsuite.io/errors/plan-not-purchasable',
    ))).toBe(true)
    expect(isRenewableAnnualOfferError(new BillingResponseError(
      'Wrong status',
      400,
      'https://api.silentsuite.io/errors/plan-not-purchasable',
    ))).toBe(false)
    expect(isRenewableAnnualOfferError(new BillingResponseError(
      'Wrong problem',
      409,
      'https://api.silentsuite.io/errors/payment-reconciliation-required',
    ))).toBe(false)
    expect(isRenewableAnnualOfferError(new TypeError('Failed to fetch'))).toBe(false)
  })

  it('rejects a signup payment response with a different recovery authority', async () => {
    const fetcher = vi.fn<BillingV2Fetch>().mockResolvedValue(new Response(JSON.stringify({
      contractVersion: 2,
      kind: 'btcpay',
      cryptoCheckoutUrl: 'https://btcpay.example.test/i/invoice',
      cryptoInvoiceId: 'invoice',
      cryptoInvoiceLookupToken: token,
      paymentSessionToken: 'different-authority-token-that-is-long-enough-123',
    })))
    await expect(startSignupAnnualPayment({
      fetcher,
      billingApiUrl: 'https://billing.example.test',
      checkoutIntentToken: token,
      email: 'customer@example.test',
      requestKey,
      recoverySecret: token,
      wantsProductUpdates: true,
      rememberDevice: false,
      returnUrl: 'https://app.example.test/signup/pending-payment',
    })).rejects.toThrow('another signup')
  })

  it('rejects a BTCPay lookup authority that differs from the recovery authority', async () => {
    const fetcher = vi.fn<BillingV2Fetch>().mockResolvedValue(new Response(JSON.stringify({
      contractVersion: 2,
      kind: 'btcpay',
      cryptoCheckoutUrl: 'https://btcpay.example.test/i/invoice',
      cryptoInvoiceId: 'invoice',
      cryptoInvoiceLookupToken: 'different-authority-token-that-is-long-enough-123',
      paymentSessionToken: token,
    })))
    await expect(startSignupAnnualPayment({
      fetcher,
      billingApiUrl: 'https://billing.example.test',
      checkoutIntentToken: token,
      email: 'customer@example.test',
      requestKey,
      recoverySecret: token,
      wantsProductUpdates: true,
      rememberDevice: false,
      returnUrl: 'https://app.example.test/signup/pending-payment',
    })).rejects.toThrow('BTCPay recovery')
  })

  it('uses the closed payment-session-owned anonymous recovery contract with capability-only credentials and every bound lineage field', async () => {
    const recovery = {
      contractVersion: 2,
      state: 'open',
      flow: { provider: 'btcpay', status: 'provider_pending' },
    }
    const fetcher = vi.fn<BillingV2Fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(recovery), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'closed', flow: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'confirmed', flow: { provider: 'stripe', status: 'provider_confirmed' } }), { status: 200 }))
    const params = { fetcher, billingApiUrl: 'https://billing.example.test', paymentSessionToken: token, recoverySecret: token, requestKey, email: 'customer@example.test' }
    await expect(getAnonymousPaymentSessionRecovery(params)).resolves.toEqual(recovery)
    await expect(cancelAnonymousPaymentSessionRecovery(params)).resolves.toEqual({ contractVersion: 2, state: 'closed', flow: null })
    await expect(reconcileAnonymousPaymentSessionRecovery(params)).resolves.toEqual({ contractVersion: 2, state: 'confirmed', flow: { provider: 'stripe', status: 'provider_confirmed' } })
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://billing.example.test/auth/signup/payment-session/v2/current',
      'https://billing.example.test/auth/signup/payment-session/v2/cancel',
      'https://billing.example.test/auth/signup/payment-session/v2/reconcile',
    ])
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'POST', credentials: 'omit' })
      expect(JSON.parse(String(init?.body))).toEqual({ contractVersion: 2, email: 'customer@example.test', requestKey, recoverySecret: token })
    }
  })

  it('fails closed for 404, 401, a non-200 success, response binding mismatch, and an unrecognized recovery state without trying authenticated endpoints', async () => {
    const fetcher = vi.fn<BillingV2Fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'missing', type: 'not-found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'unauthorized', type: 'authentication-failed' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'closed', flow: null }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'closed', flow: null, email: 'customer@example.test' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'unknown', flow: null }), { status: 200 }))
    const params = { fetcher, billingApiUrl: 'https://billing.example.test', paymentSessionToken: token, recoverySecret: token, requestKey, email: 'customer@example.test' }

    await expect(getAnonymousPaymentSessionRecovery(params)).rejects.toMatchObject<BillingResponseError>({ billingStatus: 404, billingProblemType: 'not-found' })
    await expect(cancelAnonymousPaymentSessionRecovery(params)).rejects.toMatchObject<BillingResponseError>({ billingStatus: 401, billingProblemType: 'authentication-failed' })
    await expect(reconcileAnonymousPaymentSessionRecovery(params)).rejects.toThrow('recovery response status')
    await expect(getAnonymousPaymentSessionRecovery(params)).rejects.toThrow('valid annual payment recovery')
    await expect(getAnonymousPaymentSessionRecovery(params)).rejects.toThrow('valid annual payment recovery')

    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).toMatch(/\/auth\/signup\/payment-session\/v2\/(current|cancel|reconcile)$/)
      expect(init).toMatchObject({ credentials: 'omit' })
      expect(String(url)).not.toContain('/subscription/')
    }
  })

  it('accepts the same generic closed response for unknown and terminal recovery capability proofs, and rejects mismatched local authority before request', async () => {
    const fetcher = vi.fn<BillingV2Fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'closed', flow: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'closed', flow: null }), { status: 200 }))
    const params = { fetcher, billingApiUrl: 'https://billing.example.test', paymentSessionToken: token, recoverySecret: token, requestKey, email: 'customer@example.test' }

    await expect(getAnonymousPaymentSessionRecovery(params)).resolves.toEqual({ contractVersion: 2, state: 'closed', flow: null })
    await expect(reconcileAnonymousPaymentSessionRecovery(params)).resolves.toEqual({ contractVersion: 2, state: 'closed', flow: null })
    await expect(cancelAnonymousPaymentSessionRecovery({ ...params, paymentSessionToken: 'Z'.repeat(43) })).rejects.toThrow('recovery context')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
