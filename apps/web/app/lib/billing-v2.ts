/**
 * Closed public client for Billing's annual-only v2 contract.  Prices, class,
 * promotions, terms and provider authority are intentionally never inferred
 * by the client: an invalid or incomplete server reply is a visible failure.
 */

/**
 * The injected fetcher is normally the browser's `fetch`, which rejects any
 * receiver that is not the window ("Illegal invocation"). It must therefore be
 * called as a plain function, never as a method of a params object. `this: void`
 * states that contract and keeps receiver-dependent implementations out.
 */
export type BillingV2Fetch = (this: void, input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type AnnualProvider = 'stripe' | 'btcpay'
export type AnnualPlanId = 'early_annual' | 'standard_annual'
export type AnnualTrialPath = 'trial_7day_no_card' | 'trial_30day_card' | 'immediate'
export type AnnualBehavior = 'no_card_trial' | 'card_trial' | 'immediate_card' | 'prepaid_bitcoin'

export interface AnnualOffer {
  planId: AnnualPlanId
  customerClass: 'early' | 'standard'
  billingInterval: 'annual'
  annualAmountMinor: 3600 | 4800
  monthlyEquivalentMinor: 300 | 400
  currency: 'EUR'
  providers: AnnualProvider[]
  offerRevision: number
  offerToken: string
  expiresAt: string
}

export interface AnnualOfferResponse { contractVersion: 2; requestId: string; offer: AnnualOffer }

export interface AnnualDisclosure {
  kind: 'no_auto_charge' | 'card_trial' | 'charge_now' | 'prepaid'
  annualAmountMinor: 3600 | 4800
  firstChargeAmountMinor: number
  renewalAmountMinor: number | null
  monthlyEquivalentMinor: 300 | 400
  currency: 'EUR'
  trialEndsAt: string | null
  firstChargeAt: string | null
  cancelBy: string | null
  cancelByInclusive: false
  autoRenew: boolean
  prepaid: boolean
  refundWindowDays: 30 | null
  bonusDays: 0 | 14
  periodEndRule: 'activation_plus_trial' | 'first_charge_plus_1_utc_calendar_year' | 'confirmation_plus_1_utc_calendar_year' | 'confirmation_bonus_then_1_utc_calendar_year'
  renewalAt: string | null
  entitlementEndsAt: string | null
}

export interface AnnualCheckoutActivation {
  contractVersion: 2
  checkoutIntentToken: string
  expiresAt: string
  disclosure: AnnualDisclosure
}

export interface EmailOwnership { contractVersion: 2; emailOwnershipToken: string; expiresAt: string }

export interface AnnualSelectionRelease { contractVersion: 2; requestId: string; checkoutIntentJti: string; state: 'released' }

export type SignupAnnualPayment =
  | { contractVersion: 2; kind: 'stripe'; clientSecret: string; paymentSessionToken: string }
  | { contractVersion: 2; kind: 'btcpay'; cryptoCheckoutUrl: string; cryptoInvoiceId: string; cryptoInvoiceLookupToken: string; paymentSessionToken: string }

export type AuthenticatedAnnualPayment =
  | { contractVersion: 2; kind: 'stripe'; authorityId: string; clientSecret: string }
  | { contractVersion: 2; kind: 'btcpay'; authorityId: string; checkoutUrl: string; invoiceId: string; invoiceLookupToken: string }

export type AnonymousPaymentSessionRecovery = {
  contractVersion: 2
  // A closed response deliberately reveals no account, request, or provider
  // correlation. The local capability proves the recovery request instead.
  state: 'open' | 'confirmed' | 'closed' | 'released'
  release?: { requestKey: string; provider: AnnualProvider; providerObjectId: string | null }
  continuation?: { requestKey: string; provider: AnnualProvider; providerObjectId: string; disclosure: AnnualDisclosure; clientSecret?: string; checkoutUrl?: string }
  flow: { provider: AnnualProvider; status: string } | null
}

/**
 * A non-2xx Billing reply is still server authority.  Callers use the
 * allowlisted status/type pair to decide whether a persisted recovery
 * capability was consumed; malformed, network, or unknown failures retain it.
 */
export class BillingResponseError extends Error {
  readonly billingStatus: number
  readonly billingProblemType: string | null
  readonly retryAfterMs: number | null

  constructor(message: string, billingStatus: number, billingProblemType: string | null, retryAfterMs: number | null = null) {
    super(message)
    this.name = 'BillingResponseError'
    this.billingStatus = billingStatus
    this.billingProblemType = billingProblemType
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * Billing deliberately uses one stable Problem Details pair when an offer has
 * expired, its revision/terms are stale, or its provider is no longer
 * purchasable. Only that server-authoritative pair may send a client back to
 * renewed consent; transport and all other failures retain the current state.
 */
export const RENEWABLE_ANNUAL_OFFER_PROBLEM_TYPE = 'https://api.silentsuite.io/errors/plan-not-purchasable'

export function isRenewableAnnualOfferError(error: unknown): error is BillingResponseError {
  return error instanceof BillingResponseError
    && error.billingStatus === 409
    && error.billingProblemType === RENEWABLE_ANNUAL_OFFER_PROBLEM_TYPE
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) && !Number.isNaN(Date.parse(value))
}
function isNullableTimestamp(value: unknown): value is string | null { return value === null || isUtcTimestamp(value) }
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) }
function isRecoveryToken(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(value) }

/**
 * Transport/profile validation only, NOT signature verification. Billing's
 * HostedOfferAuthority verifies signatures, time, subject and request binding.
 * Signed authorities are compact ES256 JWS; payment recovery stays opaque.
 */
function isSignedAuthorityToken(value: unknown, profile: 'email-ownership' | 'checkout-intent'): value is string {
  // Bound decoding work before parsing untrusted JSON. Current closed profiles
  // fit comfortably below 8 KiB, including the larger checkout schedule.
  if (typeof value !== 'string' || value.length > 8192) return false
  const parts = value.split('.')
  if (parts.length !== 3 || parts[0].length > 1024 || parts[2].length !== 86) return false
  try {
    const decoded = parts.map(part => {
      if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('Invalid JWS encoding')
      const bytes = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
      // Reject padding and noncanonical trailing bits, including the signature.
      if (btoa(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') !== part) throw new Error('Invalid JWS encoding')
      return Uint8Array.from(bytes, character => character.charCodeAt(0))
    })
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const header: unknown = JSON.parse(decoder.decode(decoded[0]))
    const payload: unknown = JSON.parse(decoder.decode(decoded[1]))
    const checkout = profile === 'checkout-intent'
    return isObject(header) && hasExactKeys(header, ['alg', 'typ', 'kid'])
      && header.alg === 'ES256' && header.typ === `ss-${profile}+jwt`
      && typeof header.kid === 'string' && header.kid.length > 0
      && decoded[2].length === 64 && isObject(payload)
      && payload.iss === 'silentsuite-billing'
      && payload.aud === (checkout ? 'silentsuite-billing-checkout' : 'silentsuite-billing-signup-email-ownership')
      && payload.purpose === (checkout ? 'checkout_intent' : 'email_ownership')
      && payload.contractVersion === 2
  } catch { return false }
}
function isHttpsUrl(value: unknown): value is string { try { return typeof value === 'string' && new URL(value).protocol === 'https:' } catch { return false } }
function requireAbsoluteHttpUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Billing return URL must be an absolute HTTP(S) URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Billing return URL must be an absolute HTTP(S) URL')
  return url.toString()
}
export function buildSameOriginReturnUrl(path: string, origin: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Billing return URL must be a root-relative same-origin path')
  const base = requireAbsoluteHttpUrl(origin)
  const url = new URL(path, base)
  if (url.origin !== new URL(base).origin) throw new Error('Billing return URL must be same-origin')
  return url.toString()
}
function sameProviders(value: unknown, expected: AnnualProvider[]): value is AnnualProvider[] {
  return Array.isArray(value) && value.length === expected.length && value.every((provider, index) => provider === expected[index])
}

export function assertAnnualOfferResponse(value: unknown): asserts value is AnnualOfferResponse {
  if (!isObject(value) || !hasExactKeys(value, ['contractVersion', 'requestId', 'offer']) || value.contractVersion !== 2 || !isUuid(value.requestId) || !isObject(value.offer)) throw new Error('Billing did not return a valid annual offer')
  const offer = value.offer
  if (!hasExactKeys(offer, ['planId', 'customerClass', 'billingInterval', 'annualAmountMinor', 'monthlyEquivalentMinor', 'currency', 'providers', 'offerRevision', 'offerToken', 'expiresAt'])) throw new Error('Billing did not return a canonical annual offer')
  const early = offer.planId === 'early_annual' && offer.customerClass === 'early' && offer.annualAmountMinor === 3600 && offer.monthlyEquivalentMinor === 300 && sameProviders(offer.providers, ['stripe', 'btcpay'])
  const standard = offer.planId === 'standard_annual' && offer.customerClass === 'standard' && offer.annualAmountMinor === 4800 && offer.monthlyEquivalentMinor === 400 && sameProviders(offer.providers, ['stripe'])
  if ((!early && !standard) || offer.billingInterval !== 'annual' || offer.currency !== 'EUR' || !Number.isInteger(offer.offerRevision) || typeof offer.offerToken !== 'string' || !offer.offerToken || !isUtcTimestamp(offer.expiresAt)) throw new Error('Billing did not return a canonical annual offer')
}

export function assertAnnualDisclosure(value: unknown): asserts value is AnnualDisclosure {
  if (!isObject(value) || !hasExactKeys(value, ['kind', 'annualAmountMinor', 'firstChargeAmountMinor', 'renewalAmountMinor', 'monthlyEquivalentMinor', 'currency', 'trialEndsAt', 'firstChargeAt', 'cancelBy', 'cancelByInclusive', 'autoRenew', 'prepaid', 'refundWindowDays', 'bonusDays', 'periodEndRule', 'renewalAt', 'entitlementEndsAt'])) throw new Error('Billing did not return complete annual terms')
  const matchingTerms = (value.annualAmountMinor === 3600 && value.monthlyEquivalentMinor === 300) || (value.annualAmountMinor === 4800 && value.monthlyEquivalentMinor === 400)
  const scalar = matchingTerms && value.currency === 'EUR' && typeof value.firstChargeAmountMinor === 'number' && (typeof value.renewalAmountMinor === 'number' || value.renewalAmountMinor === null) && isNullableTimestamp(value.trialEndsAt) && isNullableTimestamp(value.firstChargeAt) && isNullableTimestamp(value.cancelBy) && value.cancelByInclusive === false && typeof value.autoRenew === 'boolean' && typeof value.prepaid === 'boolean' && (value.refundWindowDays === 30 || value.refundWindowDays === null) && (value.bonusDays === 0 || value.bonusDays === 14) && ['activation_plus_trial', 'first_charge_plus_1_utc_calendar_year', 'confirmation_plus_1_utc_calendar_year', 'confirmation_bonus_then_1_utc_calendar_year'].includes(String(value.periodEndRule)) && isNullableTimestamp(value.renewalAt) && isNullableTimestamp(value.entitlementEndsAt)
  if (!scalar) throw new Error('Billing did not return complete annual terms')
  const amount = value.annualAmountMinor
  const noCard = value.kind === 'no_auto_charge' && value.firstChargeAmountMinor === 0 && value.renewalAmountMinor === null && value.trialEndsAt !== null && value.firstChargeAt === null && value.cancelBy === null && !value.autoRenew && !value.prepaid && value.refundWindowDays === null && value.bonusDays === 0 && value.periodEndRule === 'activation_plus_trial' && value.renewalAt === null && value.entitlementEndsAt === value.trialEndsAt
  const cardTrial = value.kind === 'card_trial' && value.firstChargeAmountMinor === amount && value.renewalAmountMinor === amount && value.trialEndsAt !== null && value.firstChargeAt === value.trialEndsAt && value.cancelBy === value.trialEndsAt && value.autoRenew && !value.prepaid && value.refundWindowDays === 30 && value.bonusDays === 0 && value.periodEndRule === 'first_charge_plus_1_utc_calendar_year' && value.renewalAt !== null && value.entitlementEndsAt === value.renewalAt
  const confirmationRule = value.bonusDays === 14 ? 'confirmation_bonus_then_1_utc_calendar_year' : 'confirmation_plus_1_utc_calendar_year'
  const chargeNow = value.kind === 'charge_now' && value.firstChargeAmountMinor === amount && value.renewalAmountMinor === amount && value.trialEndsAt === null && value.firstChargeAt === null && value.cancelBy === null && value.autoRenew && !value.prepaid && value.refundWindowDays === 30 && value.periodEndRule === confirmationRule && value.renewalAt === null && value.entitlementEndsAt === null
  const prepaid = value.kind === 'prepaid' && value.firstChargeAmountMinor === amount && value.renewalAmountMinor === null && value.trialEndsAt === null && value.firstChargeAt === null && value.cancelBy === null && !value.autoRenew && value.prepaid && value.refundWindowDays === 30 && value.periodEndRule === confirmationRule && value.renewalAt === null && value.entitlementEndsAt === null
  if (!noCard && !cardTrial && !chargeNow && !prepaid) throw new Error('Billing returned inconsistent annual terms')
}

function assertActivation(value: unknown): asserts value is AnnualCheckoutActivation {
  if (!isObject(value) || !hasExactKeys(value, ['contractVersion', 'checkoutIntentToken', 'expiresAt', 'disclosure']) || value.contractVersion !== 2 || !isSignedAuthorityToken(value.checkoutIntentToken, 'checkout-intent') || !isUtcTimestamp(value.expiresAt)) throw new Error('Billing did not return a valid annual checkout authority')
  assertAnnualDisclosure(value.disclosure)
}

async function jsonOrThrow(response: Response): Promise<unknown> {
  const retryHeader = response.headers?.get('retry-after') ?? null
  const retryDelay = retryHeader === null ? NaN : /^\d+$/.test(retryHeader.trim())
    ? Number(retryHeader) * 1000 : Date.parse(retryHeader) - Date.now()
  const retryAfterMs = Number.isFinite(retryDelay) ? Math.max(0, retryDelay)
    : response.status === 429 ? 15 * 60_000 : null
  let body: unknown
  try { body = await response.json() } catch {
    if (!response.ok) throw new BillingResponseError('Billing returned an invalid error response', response.status, null, retryAfterMs)
    throw new Error('Billing returned an invalid response')
  }
  if (!response.ok) {
    throw new BillingResponseError(
      isObject(body) && typeof body.detail === 'string' ? body.detail : 'Billing request failed',
      response.status,
      isObject(body) && typeof body.type === 'string' ? body.type : null,
      retryAfterMs,
    )
  }
  return body
}

function api(url: string, path: string) { return `${url.replace(/\/$/, '')}${path}` }
function jsonInit(method: 'POST' | 'GET', body?: object): RequestInit { return { method, credentials: 'include', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) } }

export async function cancelUnclaimedAnnualSelection(params: {
  fetcher: BillingV2Fetch; billingApiUrl: string; email: string; requestId: string;
  checkoutIntentToken: string; emailOwnershipToken: string;
}): Promise<AnnualSelectionRelease> {
  const { fetcher } = params
  if (!isUuid(params.requestId) || !isSignedAuthorityToken(params.checkoutIntentToken, 'checkout-intent')
    || !isSignedAuthorityToken(params.emailOwnershipToken, 'email-ownership')) throw new Error('Invalid selection cancellation request')
  // Decode only a bounded transport-validated identity for response correlation.
  // This is not signature/expiry authority: Billing checks the exact stored token
  // and live ownership proof, including replay after checkout expiry.
  const claims: unknown = JSON.parse(atob(params.checkoutIntentToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
  if (!isObject(claims) || !isUuid(claims.jti) || claims.requestId !== params.requestId) throw new Error('Invalid selection cancellation identity')
  const response = await fetcher(api(params.billingApiUrl, '/auth/offers/v2/cancel'), jsonInit('POST', {
    contractVersion: 2, email: params.email, requestId: params.requestId,
    checkoutIntentToken: params.checkoutIntentToken, emailOwnershipToken: params.emailOwnershipToken,
  }))
  const body = await jsonOrThrow(response)
  if (response.status !== 200 || !isObject(body)
    || !hasExactKeys(body, ['contractVersion', 'requestId', 'checkoutIntentJti', 'state'])
    || body.contractVersion !== 2 || body.state !== 'released'
    || body.requestId !== params.requestId || body.checkoutIntentJti !== claims.jti) {
    throw new Error('Billing did not confirm cancellation of this exact selection')
  }
  return body as unknown as AnnualSelectionRelease
}

export async function fetchAnonymousAnnualOffer(params: {
  fetcher: BillingV2Fetch
  billingApiUrl: string
  email: string
  requestId: string
}): Promise<AnnualOfferResponse> {
  const { fetcher } = params
  const body = await jsonOrThrow(await fetcher(api(params.billingApiUrl, '/auth/offers/v2'), jsonInit('POST', { contractVersion: 2, email: params.email, requestId: params.requestId })))
  assertAnnualOfferResponse(body)
  if (body.requestId !== params.requestId) throw new Error('Billing returned an offer for another request')
  return body
}

export async function activateAnnualCheckout(params: { fetcher: BillingV2Fetch; billingApiUrl: string; offer: AnnualOfferResponse; email: string; emailOwnershipToken: string; trialPath: AnnualTrialPath; provider: 'none' | AnnualProvider; behavior: AnnualBehavior }): Promise<AnnualCheckoutActivation> {
  const { fetcher } = params
  assertAnnualOfferResponse(params.offer)
  const body = await jsonOrThrow(await fetcher(api(params.billingApiUrl, '/auth/offers/v2/activate'), jsonInit('POST', { contractVersion: 2, offerToken: params.offer.offer.offerToken, requestId: params.offer.requestId, email: params.email, emailOwnershipToken: params.emailOwnershipToken, trialPath: params.trialPath, provider: params.provider, behavior: params.behavior })))
  assertActivation(body)
  return body
}

export async function requestSignupEmailOwnership(params: { fetcher: BillingV2Fetch; billingApiUrl: string; email: string; requestId: string }) {
  const { fetcher } = params
  const response = await fetcher(api(params.billingApiUrl, '/auth/signup-email-verifications/v2'), jsonInit('POST', { contractVersion: 2, email: params.email, requestId: params.requestId }))
  if (response.status !== 202) {
    await jsonOrThrow(response)
    throw new Error('Billing did not acknowledge email proof delivery')
  }
}

export async function consumeSignupEmailOwnership(params: { fetcher: BillingV2Fetch; billingApiUrl: string; email: string; token: string }): Promise<EmailOwnership> {
  const { fetcher } = params
  const body = await jsonOrThrow(await fetcher(api(params.billingApiUrl, '/auth/signup-email-verifications/v2/consume'), jsonInit('POST', { contractVersion: 2, email: params.email, token: params.token })))
  if (!isObject(body) || !hasExactKeys(body, ['contractVersion', 'emailOwnershipToken', 'expiresAt']) || body.contractVersion !== 2 || !isSignedAuthorityToken(body.emailOwnershipToken, 'email-ownership') || !isUtcTimestamp(body.expiresAt)) throw new Error('Billing did not return valid email proof')
  return body as unknown as EmailOwnership
}

export async function fetchAuthenticatedAnnualOffer(params: { fetcher: BillingV2Fetch; billingApiUrl: string }): Promise<AnnualOfferResponse> {
  const { fetcher } = params
  const body = await jsonOrThrow(await fetcher(api(params.billingApiUrl, '/subscription/offers/v2'), jsonInit('GET')))
  assertAnnualOfferResponse(body)
  return body
}

export async function activateAuthenticatedAnnualCheckout(params: { fetcher: BillingV2Fetch; billingApiUrl: string; offer: AnnualOfferResponse; trialPath: AnnualTrialPath; provider: 'none' | AnnualProvider; behavior: AnnualBehavior }): Promise<AnnualCheckoutActivation> {
  const { fetcher } = params
  assertAnnualOfferResponse(params.offer)
  const body = await jsonOrThrow(await fetcher(api(params.billingApiUrl, '/subscription/offers/v2/activate'), jsonInit('POST', { contractVersion: 2, offerToken: params.offer.offer.offerToken, requestId: params.offer.requestId, trialPath: params.trialPath, provider: params.provider, behavior: params.behavior })))
  assertActivation(body)
  return body
}

function assertSignupPayment(value: unknown): asserts value is SignupAnnualPayment {
  if (!isObject(value) || value.contractVersion !== 2 || (value.kind !== 'stripe' && value.kind !== 'btcpay')) throw new Error('Billing did not return a valid payment session')
  if (value.kind === 'stripe') {
    if (!hasExactKeys(value, ['contractVersion', 'kind', 'clientSecret', 'paymentSessionToken']) || typeof value.clientSecret !== 'string' || !value.clientSecret || !isRecoveryToken(value.paymentSessionToken)) throw new Error('Billing did not return a valid payment session')
  } else if (!hasExactKeys(value, ['contractVersion', 'kind', 'cryptoCheckoutUrl', 'cryptoInvoiceId', 'cryptoInvoiceLookupToken', 'paymentSessionToken']) || !isHttpsUrl(value.cryptoCheckoutUrl) || typeof value.cryptoInvoiceId !== 'string' || !value.cryptoInvoiceId || !isRecoveryToken(value.cryptoInvoiceLookupToken) || !isRecoveryToken(value.paymentSessionToken)) throw new Error('Billing did not return a valid payment session')
}
function assertAuthenticatedPayment(value: unknown): asserts value is AuthenticatedAnnualPayment {
  if (!isObject(value) || value.contractVersion !== 2 || (value.kind !== 'stripe' && value.kind !== 'btcpay')) throw new Error('Billing did not return a valid payment session')
  if (value.kind === 'stripe') {
    if (!hasExactKeys(value, ['contractVersion', 'kind', 'authorityId', 'clientSecret']) || !isUuid(value.authorityId) || typeof value.clientSecret !== 'string' || !value.clientSecret) throw new Error('Billing did not return a valid payment session')
  } else if (!hasExactKeys(value, ['contractVersion', 'kind', 'authorityId', 'checkoutUrl', 'invoiceId', 'invoiceLookupToken']) || !isUuid(value.authorityId) || !isHttpsUrl(value.checkoutUrl) || typeof value.invoiceId !== 'string' || !value.invoiceId || typeof value.invoiceLookupToken !== 'string' || !value.invoiceLookupToken) throw new Error('Billing did not return a valid payment session')
}

export async function startSignupAnnualPayment(params: { fetcher: BillingV2Fetch; billingApiUrl: string; checkoutIntentToken: string; email: string; requestKey: string; recoverySecret: string; wantsProductUpdates: boolean; rememberDevice: boolean; returnUrl: string }): Promise<SignupAnnualPayment> {
  const { fetcher } = params
  const returnUrl = requireAbsoluteHttpUrl(params.returnUrl)
  const body = await jsonOrThrow(await fetcher(api(params.billingApiUrl, '/auth/signup/payment-session/v2'), jsonInit('POST', { contractVersion: 2, checkoutIntentToken: params.checkoutIntentToken, email: params.email, requestKey: params.requestKey, recoverySecret: params.recoverySecret, wantsProductUpdates: params.wantsProductUpdates, rememberDevice: params.rememberDevice, returnUrl })))
  assertSignupPayment(body)
  if (body.paymentSessionToken !== params.recoverySecret) throw new Error('Billing returned payment recovery for another signup')
  if (body.kind === 'btcpay' && body.cryptoInvoiceLookupToken !== params.recoverySecret) throw new Error('Billing returned cryptocurrency recovery for another signup')
  return body
}

export async function startAuthenticatedAnnualPayment(params: { fetcher: BillingV2Fetch; billingApiUrl: string; checkoutIntentToken: string; expectedAuthorityId: string; returnUrl: string }): Promise<AuthenticatedAnnualPayment> {
  const { fetcher } = params
  if (!isUuid(params.expectedAuthorityId)) throw new Error('The expected annual authority is invalid')
  const returnUrl = requireAbsoluteHttpUrl(params.returnUrl)
  const body = await jsonOrThrow(await fetcher(api(params.billingApiUrl, '/subscription/payment-flows/v2'), jsonInit('POST', { contractVersion: 2, checkoutIntentToken: params.checkoutIntentToken, returnUrl })))
  assertAuthenticatedPayment(body)
  if (body.authorityId !== params.expectedAuthorityId) throw new Error('Billing returned payment details for another annual authority')
  return body
}

function assertAnonymousPaymentRecovery(value: unknown): asserts value is AnonymousPaymentSessionRecovery {
  const invalid = () => { throw new Error('Billing did not return valid annual payment recovery') }
  if (!isObject(value) || !hasExactKeys(value, ['contractVersion', 'state', 'flow', ...('release' in value ? ['release'] : []), ...('continuation' in value ? ['continuation'] : [])])
    || value.contractVersion !== 2 || !['open', 'confirmed', 'closed', 'released'].includes(String(value.state))) return invalid()
  if (value.flow !== null && (!isObject(value.flow) || !hasExactKeys(value.flow, ['provider', 'status'])
    || !['stripe', 'btcpay'].includes(String(value.flow.provider)) || typeof value.flow.status !== 'string')) return invalid()
  if (value.state === 'released') {
    const r = value.release
    if (!isObject(r) || !hasExactKeys(r, ['requestKey', 'provider', 'providerObjectId']) || !isUuid(r.requestKey)
      || !isObject(value.flow) || r.provider !== value.flow.provider
      || (r.providerObjectId !== null && (typeof r.providerObjectId !== 'string' || !r.providerObjectId))) return invalid()
  } else if ('release' in value) return invalid()
  if ('continuation' in value) {
    const c = value.continuation
    if (value.state !== 'open' || !isObject(c) || !isObject(value.flow) || c.provider !== value.flow.provider
      || !isUuid(c.requestKey) || typeof c.providerObjectId !== 'string' || !c.providerObjectId) return invalid()
    const control = c.provider === 'stripe' ? 'clientSecret' : 'checkoutUrl'
    if (!hasExactKeys(c, ['requestKey', 'provider', 'providerObjectId', 'disclosure', control]) || typeof c[control] !== 'string' || !c[control]) return invalid()
    assertAnnualDisclosure(c.disclosure)
    if (c.provider === 'stripe' && !['card_trial', 'charge_now'].includes(c.disclosure.kind)) return invalid()
    if (c.provider === 'btcpay') {
      if (c.disclosure.kind !== 'prepaid') return invalid()
      try { const url = new URL(c.checkoutUrl as string); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return invalid() } catch { return invalid() }
    }
  }
}

export const ANONYMOUS_RECOVERY_SWITCHING_PROFILE = 'v1' as const

type AnonymousPaymentSessionRecoveryRequest = {
  fetcher: BillingV2Fetch
  billingApiUrl: string
  paymentSessionToken: string
  recoverySecret: string
  requestKey: string
  email: string
  confirmNoBitcoinSent?: boolean
}

async function anonymousPaymentSessionRecovery(
  path: '/current' | '/cancel' | '/reconcile',
  params: AnonymousPaymentSessionRecoveryRequest,
): Promise<AnonymousPaymentSessionRecovery> {
  const { fetcher } = params
  if ((params.confirmNoBitcoinSent !== undefined && typeof params.confirmNoBitcoinSent !== 'boolean')
    || !isRecoveryToken(params.paymentSessionToken)
    || !isRecoveryToken(params.recoverySecret)
    || params.paymentSessionToken !== params.recoverySecret
    || !isUuid(params.requestKey)
    || typeof params.email !== 'string'
    || params.email.length === 0
    || params.email.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(params.email)) {
    throw new Error('The annual payment recovery context is invalid')
  }
  const response = await fetcher(
    api(params.billingApiUrl, `/auth/signup/payment-session/v2${path}`),
    {
      method: 'POST',
      // The anonymous payment-session capability is the only credential. Do
      // not attach Billing cookies before a Billing user exists.
      credentials: 'omit',
      headers: { 'content-type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        contractVersion: 2,
        email: params.email,
        requestKey: params.requestKey,
        recoverySecret: params.recoverySecret,
        // Explicit opt-in to release receipts, payable continuation and
        // provider cancellation. A Billing release that ignores this literal
        // still answers with the legacy open/confirmed/closed shape, which the
        // validator below accepts without granting any switching authority.
        switchingProfile: ANONYMOUS_RECOVERY_SWITCHING_PROFILE,
        ...(path === '/cancel' && params.confirmNoBitcoinSent !== undefined ? { confirmNoBitcoinSent: params.confirmNoBitcoinSent } : {}),
      }),
    },
  )
  const body = await jsonOrThrow(response)
  if (response.status !== 200) throw new Error('Billing returned an invalid annual payment recovery response status')
  assertAnonymousPaymentRecovery(body)
  if ((body.release && body.release.requestKey !== params.requestKey) || (body.continuation && body.continuation.requestKey !== params.requestKey)) throw new Error('Billing returned mismatched payment recovery identity')
  return body
}

export function getAnonymousPaymentSessionRecovery(params: AnonymousPaymentSessionRecoveryRequest) {
  return anonymousPaymentSessionRecovery('/current', params)
}

export function cancelAnonymousPaymentSessionRecovery(params: AnonymousPaymentSessionRecoveryRequest) {
  return anonymousPaymentSessionRecovery('/cancel', params)
}

export function reconcileAnonymousPaymentSessionRecovery(params: AnonymousPaymentSessionRecoveryRequest) {
  return anonymousPaymentSessionRecovery('/reconcile', params)
}
