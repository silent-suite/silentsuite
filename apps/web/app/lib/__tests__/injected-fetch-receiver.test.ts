import { describe, expect, it } from 'vitest'
import {
  activateAnnualCheckout,
  activateAuthenticatedAnnualCheckout,
  cancelAnonymousPaymentSessionRecovery,
  consumeSignupEmailOwnership,
  fetchAnonymousAnnualOffer,
  fetchAuthenticatedAnnualOffer,
  getAnonymousPaymentSessionRecovery,
  reconcileAnonymousPaymentSessionRecovery,
  requestSignupEmailOwnership,
  startAuthenticatedAnnualPayment,
  startSignupAnnualPayment,
  type BillingV2Fetch,
} from '../billing-v2'
import { cancelPaymentFlow } from '../payment-flow-cancellation'

const billingApiUrl = 'https://billing.example.test'
const requestId = 'e91a6d70-0d4e-4352-9bdc-426d1f76d771'
const requestKey = '5fd4d86d-34de-4b82-9a66-9598ddf6e02f'
const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const email = 'customer@example.test'
const offer = { contractVersion: 2, requestId, offer: { planId: 'early_annual', customerClass: 'early', billingInterval: 'annual', annualAmountMinor: 3600, monthlyEquivalentMinor: 300, currency: 'EUR', providers: ['stripe', 'btcpay'], offerRevision: 1, offerToken: 'signed-offer', expiresAt: '2026-08-10T12:10:00Z' } }
const disclosure = { kind: 'prepaid', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: null, monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: null, firstChargeAt: null, cancelBy: null, cancelByInclusive: false, autoRenew: false, prepaid: true, refundWindowDays: 30, bonusDays: 0, periodEndRule: 'confirmation_plus_1_utc_calendar_year', renewalAt: null, entitlementEndsAt: null }
const activation = { contractVersion: 2, checkoutIntentToken: token, expiresAt: '2026-08-10T12:05:00Z', disclosure }
const recovery = { contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

/**
 * The browser's `fetch` is a `Window` method: calling it with any receiver
 * other than the global object raises "Illegal invocation" (Chromium) or
 * "'fetch' called on an object that does not implement interface Window"
 * (Firefox). A plain mock accepts any receiver, so it cannot show whether a
 * helper invokes an injected fetcher as a bare call or as a method of its own
 * parameter object. This stand-in enforces the platform rule instead.
 */
function windowBoundFetcher(response: () => Response): BillingV2Fetch {
  return function fetchLike(this: unknown) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
    }
    return Promise.resolve(response())
  }
}

const recoveryParams = (fetcher: BillingV2Fetch) => ({ fetcher, billingApiUrl, paymentSessionToken: token, recoverySecret: token, requestKey, email })

const cases: ReadonlyArray<readonly [string, () => Response, (fetcher: BillingV2Fetch) => Promise<unknown>]> = [
  ['fetchAnonymousAnnualOffer', () => json(offer), fetcher => fetchAnonymousAnnualOffer({ fetcher, billingApiUrl, email, requestId })],
  ['activateAnnualCheckout', () => json(activation), fetcher => activateAnnualCheckout({ fetcher, billingApiUrl, offer, email, emailOwnershipToken: token, trialPath: 'immediate', provider: 'btcpay', behavior: 'prepaid_bitcoin' })],
  ['requestSignupEmailOwnership', () => new Response('{}', { status: 202 }), fetcher => requestSignupEmailOwnership({ fetcher, billingApiUrl, email, requestId })],
  ['consumeSignupEmailOwnership', () => json({ contractVersion: 2, emailOwnershipToken: token, expiresAt: '2026-08-10T12:05:00Z' }), fetcher => consumeSignupEmailOwnership({ fetcher, billingApiUrl, email, token })],
  ['fetchAuthenticatedAnnualOffer', () => json(offer), fetcher => fetchAuthenticatedAnnualOffer({ fetcher, billingApiUrl })],
  ['activateAuthenticatedAnnualCheckout', () => json(activation), fetcher => activateAuthenticatedAnnualCheckout({ fetcher, billingApiUrl, offer, trialPath: 'immediate', provider: 'stripe', behavior: 'immediate_card' })],
  ['startSignupAnnualPayment', () => json({ contractVersion: 2, kind: 'stripe', clientSecret: 'pi_secret', paymentSessionToken: token }), fetcher => startSignupAnnualPayment({ fetcher, billingApiUrl, checkoutIntentToken: token, email, requestKey, recoverySecret: token, wantsProductUpdates: true, rememberDevice: false, returnUrl: 'https://app.example.test/signup/success' })],
  ['startAuthenticatedAnnualPayment', () => json({ contractVersion: 2, kind: 'stripe', authorityId: requestKey, clientSecret: 'pi_secret' }), fetcher => startAuthenticatedAnnualPayment({ fetcher, billingApiUrl, checkoutIntentToken: token, expectedAuthorityId: requestKey, returnUrl: 'https://app.example.test/settings/subscription' })],
  ['getAnonymousPaymentSessionRecovery', () => json(recovery), fetcher => getAnonymousPaymentSessionRecovery(recoveryParams(fetcher))],
  ['cancelAnonymousPaymentSessionRecovery', () => json(recovery), fetcher => cancelAnonymousPaymentSessionRecovery(recoveryParams(fetcher))],
  ['reconcileAnonymousPaymentSessionRecovery', () => json(recovery), fetcher => reconcileAnonymousPaymentSessionRecovery(recoveryParams(fetcher))],
]

describe('injected fetchers are invoked with a browser-legal receiver', () => {
  it.each(cases)('%s does not pass its parameter object as the fetch receiver', async (_name, response, call) => {
    const settled = await call(windowBoundFetcher(response)).then(() => 'called with a legal receiver', (error: unknown) => String(error))
    expect(settled).toBe('called with a legal receiver')
  })

  it('cancelPaymentFlow does not pass its parameter object as the fetch receiver', async () => {
    const result = await cancelPaymentFlow({
      fetcher: windowBoundFetcher(() => json({ cancelled: true, flowKind: 'stripe_annual' })),
      billingApiUrl,
      provider: 'stripe',
      confirmNoBitcoinSent: false,
    })
    expect(result).toEqual({ cancelled: true, flowKind: 'stripe_annual' })
  })
})
