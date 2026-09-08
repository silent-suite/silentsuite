import { describe, expect, it, vi } from 'vitest'
import { checkoutIntentToken, emailOwnershipToken, signedAuthorityFixture } from '@/src/__tests__/fixtures/annual-authority'
import { activateAnnualCheckout, activateAuthenticatedAnnualCheckout, consumeSignupEmailOwnership, getAnonymousPaymentSessionRecovery, startSignupAnnualPayment, type AnnualOfferResponse } from '../billing-v2'

const requestId = 'e91a6d70-0d4e-4352-9bdc-426d1f76d771'
const base = { billingApiUrl: 'https://billing.example.test', email: 'customer@example.test' }
const offer: AnnualOfferResponse = { contractVersion: 2, requestId, offer: { planId: 'early_annual', customerClass: 'early', billingInterval: 'annual', annualAmountMinor: 3600, monthlyEquivalentMinor: 300, currency: 'EUR', providers: ['stripe', 'btcpay'], offerRevision: 1, offerToken: 'server-offer', expiresAt: '2026-08-11T12:10:00Z' } }
const disclosure = { kind: 'prepaid', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: null, monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: null, firstChargeAt: null, cancelBy: null, cancelByInclusive: false, autoRenew: false, prepaid: true, refundWindowDays: 30, bonusDays: 0, periodEndRule: 'confirmation_plus_1_utc_calendar_year', renewalAt: null, entitlementEndsAt: null }
const choice = { offer, trialPath: 'immediate' as const, provider: 'btcpay' as const, behavior: 'prepaid_bitcoin' as const }
const json = (body: unknown) => async () => new Response(JSON.stringify(body))
const proofResponse = (token: unknown) => ({ contractVersion: 2, emailOwnershipToken: token, expiresAt: '2026-08-11T12:15:00Z' })
const activationResponse = (token: unknown) => ({ contractVersion: 2, checkoutIntentToken: token, expiresAt: '2026-08-11T12:05:00Z', disclosure })

describe('signed authority versus opaque payment recovery wire profiles', () => {
  it('accepts ephemeral ES256 email proof and both checkout activation paths', async () => {
    await expect(consumeSignupEmailOwnership({ ...base, token: 'link-secret', fetcher: json(proofResponse(emailOwnershipToken)) })).resolves.toEqual(proofResponse(emailOwnershipToken))
    await expect(activateAnnualCheckout({ ...base, ...choice, emailOwnershipToken, fetcher: json(activationResponse(checkoutIntentToken)) })).resolves.toEqual(activationResponse(checkoutIntentToken))
    await expect(activateAuthenticatedAnnualCheckout({ ...base, ...choice, fetcher: json(activationResponse(checkoutIntentToken)) })).resolves.toEqual(activationResponse(checkoutIntentToken))
  })

  it.each(['email-ownership', 'checkout-intent'] as const)('rejects wrong profiles and malformed %s signed shape', async (profile) => {
    const valid = profile === 'email-ownership' ? emailOwnershipToken : checkoutIntentToken
    const [header, payload, signature] = valid.split('.')
    const wrong = profile === 'email-ownership' ? checkoutIntentToken : emailOwnershipToken
    const invalid: unknown[] = [null, 123, '', 'A'.repeat(43), wrong, 'arbitrary-string',
      signedAuthorityFixture(profile, { alg: 'none' }), signedAuthorityFixture(profile, { typ: 'ss-offer+jwt' }),
      signedAuthorityFixture(profile, { kid: '' }), signedAuthorityFixture(profile, { crit: ['unexpected'] }),
      signedAuthorityFixture(profile, {}, { purpose: 'offer' }), signedAuthorityFixture(profile, {}, { aud: 'other' }),
      signedAuthorityFixture(profile, {}, { iss: 'other' }), signedAuthorityFixture(profile, {}, { contractVersion: 1 }),
      `${header}.${payload}`, `${header}..${signature}`, `${header}.${payload}.${signature}.extra`,
      `${header}=.${payload}.${signature}`, `${header}.${payload}.AA`, `${header}.e30.${signature}`,
      `${header}.${Buffer.from('not json').toString('base64url')}.${signature}`,
      `${header}.${Buffer.from('[]').toString('base64url')}.${signature}`,
      `${header}.${Buffer.from([0xff]).toString('base64url')}.${signature}`,
      signedAuthorityFixture(profile, { kid: 'x'.repeat(1024) }), signedAuthorityFixture(profile, {}, { oversized: 'x'.repeat(8192) }),
    ]
    for (const token of invalid) {
      if (profile === 'email-ownership') {
        await expect(consumeSignupEmailOwnership({ ...base, token: 'link-secret', fetcher: json(proofResponse(token)) })).rejects.toThrow('valid email proof')
      } else {
        await expect(activateAnnualCheckout({ ...base, ...choice, emailOwnershipToken, fetcher: json(activationResponse(token)) })).rejects.toThrow('checkout authority')
        await expect(activateAuthenticatedAnnualCheckout({ ...base, ...choice, fetcher: json(activationResponse(token)) })).rejects.toThrow('checkout authority')
      }
    }
  })

  it('retains closed response and timestamp validation', async () => {
    for (const extra of [{ extra: true }, { contractVersion: 1 }, { expiresAt: 'not-a-date' }]) {
      await expect(consumeSignupEmailOwnership({ ...base, token: 'link-secret', fetcher: json({ ...proofResponse(emailOwnershipToken), ...extra }) })).rejects.toThrow('valid email proof')
      await expect(activateAuthenticatedAnnualCheckout({ ...base, ...choice, fetcher: json({ ...activationResponse(checkoutIntentToken), ...extra }) })).rejects.toThrow('checkout authority')
    }
  })

  it.each(['stripe', 'btcpay'] as const)('keeps %s payment recovery opaque and bounded', async (kind) => {
    for (const token of ['A'.repeat(43), 'A'.repeat(128), emailOwnershipToken, checkoutIntentToken, 'A'.repeat(42), 'A'.repeat(129), ' '.repeat(43)]) {
      const valid = /^[A-Za-z0-9_-]{43,128}$/.test(token)
      const payment = kind === 'stripe'
        ? { contractVersion: 2, kind, clientSecret: 'pi_secret', paymentSessionToken: token }
        : { contractVersion: 2, kind, cryptoCheckoutUrl: 'https://pay.example.test/invoice', cryptoInvoiceId: 'invoice', cryptoInvoiceLookupToken: token, paymentSessionToken: token }
      const result = startSignupAnnualPayment({ ...base, checkoutIntentToken, requestKey: requestId, recoverySecret: token, wantsProductUpdates: false, rememberDevice: false, returnUrl: 'https://app.example.test/signup', fetcher: json(payment) })
      if (valid) await expect(result).resolves.toEqual(payment)
      else await expect(result).rejects.toThrow('valid payment session')
      const fetcher = vi.fn(json({ contractVersion: 2, state: 'closed', flow: null }))
      const recovery = getAnonymousPaymentSessionRecovery({ ...base, requestKey: requestId, paymentSessionToken: token, recoverySecret: token, fetcher })
      if (valid) await expect(recovery).resolves.toMatchObject({ state: 'closed' })
      else { await expect(recovery).rejects.toThrow('recovery context'); expect(fetcher).not.toHaveBeenCalled() }
    }
  })

  it('rejects a signed Bitcoin lookup token even when payment recovery is opaque', async () => {
    const recoverySecret = 'A'.repeat(43)
    await expect(startSignupAnnualPayment({ ...base, checkoutIntentToken, requestKey: requestId, recoverySecret,
      wantsProductUpdates: false, rememberDevice: false, returnUrl: 'https://app.example.test/signup',
      fetcher: json({ contractVersion: 2, kind: 'btcpay', cryptoCheckoutUrl: 'https://pay.example.test/invoice',
        cryptoInvoiceId: 'invoice', cryptoInvoiceLookupToken: emailOwnershipToken, paymentSessionToken: recoverySecret }),
    })).rejects.toThrow('valid payment session')
  })
})
