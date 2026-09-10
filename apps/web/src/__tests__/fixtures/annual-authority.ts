import { generateKeyPairSync, sign } from 'node:crypto'

// Test-only, ephemeral ES256 signatures. Matches HostedOfferAuthority's compact
// JWS profile; no production key or signing code is imported into the browser.
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
export function signedAuthorityFixture(profile: 'email-ownership' | 'checkout-intent', headerOverrides: Record<string, unknown> = {}, payloadOverrides: Record<string, unknown> = {}): string {
  const checkout = profile === 'checkout-intent'
  const header = { alg: 'ES256', typ: `ss-${profile}+jwt`, kid: 'ephemeral-test', ...headerOverrides }
  const payload = {
    ...(checkout ? {
      parentOfferJti: 'b56f3600-c799-4bb6-bd57-a07a5c717f3a', planId: 'early_annual', customerClass: 'early',
      billingInterval: 'annual', annualAmountMinor: 3600, monthlyEquivalentMinor: 300, currency: 'EUR',
      provider: 'btcpay', trialPath: 'immediate', behavior: 'prepaid_bitcoin', offerRevision: 1,
      kind: 'prepaid', firstChargeAmountMinor: 3600, renewalAmountMinor: null, trialEndsAt: null,
      firstChargeAt: null, cancelBy: null, cancelByInclusive: false, autoRenew: false, prepaid: true,
      refundWindowDays: 30, bonusDays: 0, periodEndRule: 'confirmation_plus_1_utc_calendar_year',
      renewalAt: null, entitlementEndsAt: null,
    } : {}),
    purpose: checkout ? 'checkout_intent' : 'email_ownership', contractVersion: 2,
    subjectKeyVersion: 1, requestId: 'e91a6d70-0d4e-4352-9bdc-426d1f76d771',
    iss: 'silentsuite-billing', aud: checkout ? 'silentsuite-billing-checkout' : 'silentsuite-billing-signup-email-ownership',
    sub: 'S'.repeat(43), jti: 'a2c4f872-01b7-4176-8325-522486b20cae',
    iat: 1786449600, nbf: 1786449600, exp: 1786449600 + (checkout ? 300 : 900),
    ...payloadOverrides,
  }
  const signingInput = [header, payload].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')
  return `${signingInput}.${sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}
export const emailOwnershipToken = signedAuthorityFixture('email-ownership')
export const checkoutIntentToken = signedAuthorityFixture('checkout-intent')
