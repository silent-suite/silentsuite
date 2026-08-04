export type CampaignParams = Partial<{
  utm_source: 'search' | 'social' | 'github' | 'newsletter' | 'community' | 'known_partner' | 'paid' | 'other'
  utm_medium: 'organic' | 'referral' | 'email' | 'community' | 'paid_social' | 'cpc' | 'qr' | 'other'
  utm_campaign: 'beta-2026-q2' | 'other_campaign'
}>

export type ReferrerCategory = 'direct' | 'search' | 'social' | 'github' | 'known_partner' | 'other'

export type SignupPageviewPayload = {
  domain: 'app.silentsuite.io'
  name: 'pageview'
  url: string
  props: { referrer_category: ReferrerCategory } & CampaignParams
}

export const SIGNUP_ANALYTICS_PATHS = ['/signup', '/signup/pending-payment', '/signup/success', '/signup/cancel'] as const
type SignupAnalyticsPath = typeof SIGNUP_ANALYTICS_PATHS[number]

type PlanClass = 'monthly' | 'annual'
type PaymentMethod = 'stripe' | 'btcpay' | 'unknown'
type CheckoutOutcome = 'returned' | 'cancelled' | 'failed' | 'pending'
type PlanSelectedPayload = {
  domain: 'app.silentsuite.io'
  name: 'Plan Selected'
  url: 'https://app.silentsuite.io/signup'
  props: { plan_class: PlanClass }
}
type CheckoutInitiatedPayload = {
  domain: 'app.silentsuite.io'
  name: 'Checkout Initiated'
  url: 'https://app.silentsuite.io/signup'
  props: { plan_class: PlanClass, payment_method: Exclude<PaymentMethod, 'unknown'> }
}
type CheckoutReturnedPayload = {
  domain: 'app.silentsuite.io'
  name: 'Checkout Returned'
  url: 'https://app.silentsuite.io/signup/pending-payment' | 'https://app.silentsuite.io/signup/success' | 'https://app.silentsuite.io/signup/cancel'
  props: { outcome: CheckoutOutcome, payment_method: PaymentMethod }
}
type SubscriptionManagementEntryPayload = {
  domain: 'app.silentsuite.io'
  name: 'Subscription Management Entry'
  url: 'https://app.silentsuite.io/settings/subscription'
  props: { surface: 'subscription_settings' }
}
export type CommercialEventPayload = PlanSelectedPayload | CheckoutInitiatedPayload | CheckoutReturnedPayload | SubscriptionManagementEntryPayload

const SOURCE_ALIASES: Readonly<Record<string, NonNullable<CampaignParams['utm_source']>>> = {
  google: 'search', bing: 'search', duckduckgo: 'search',
  x: 'social', twitter: 'social', mastodon: 'social', bluesky: 'social',
  github: 'github', newsletter: 'newsletter',
  'hacker-news': 'community', reddit: 'community', lemmy: 'community',
  alternativeto: 'known_partner', 'privacy-media': 'known_partner',
}
const MEDIUM_ALIASES: Readonly<Record<string, NonNullable<CampaignParams['utm_medium']>>> = {
  organic: 'organic', social: 'organic', referral: 'referral', listing: 'referral', media: 'referral',
  email: 'email', newsletter: 'email', community: 'community', dm: 'community',
  'paid-social': 'paid_social', cpc: 'cpc', qr: 'qr',
}
const CAMPAIGN_ALIASES: Readonly<Record<string, NonNullable<CampaignParams['utm_campaign']>>> = {
  'beta-2026-q2': 'beta-2026-q2',
}
const SAFE_VALUE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function safeSingleValue(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key)
  if (values.length !== 1) return undefined
  const rawValue = values[0]
  if (!/^[\x20-\x7e]+$/.test(rawValue)) return undefined
  const value = rawValue.normalize('NFKC')
  if (value !== value.toLowerCase() || !SAFE_VALUE.test(value) || UUID.test(value)) return undefined
  return value
}

export function canonicalizeCampaignParams(search: string | URLSearchParams): CampaignParams {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  const result: CampaignParams = {}
  const source = safeSingleValue(params, 'utm_source')
  const medium = safeSingleValue(params, 'utm_medium')
  const campaign = safeSingleValue(params, 'utm_campaign')
  if (source) result.utm_source = SOURCE_ALIASES[source] ?? 'other'
  if (medium) result.utm_medium = MEDIUM_ALIASES[medium] ?? 'other'
  if (campaign) result.utm_campaign = CAMPAIGN_ALIASES[campaign] ?? 'other_campaign'
  return result
}

export function sanitizedSignupPageUrl(rawUrl: string): string {
  const current = new URL(rawUrl)
  const path: SignupAnalyticsPath = SIGNUP_ANALYTICS_PATHS.includes(current.pathname as SignupAnalyticsPath)
    ? current.pathname as SignupAnalyticsPath
    : '/signup'
  return `https://app.silentsuite.io${path}`
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

export function classifyReferrer(raw: string): ReferrerCategory | undefined {
  if (!raw) return 'direct'
  try {
    const host = new URL(raw).hostname.toLowerCase()
    if (hostMatches(host, 'github.com')) return 'github'
    if (hostMatches(host, 'google.com') || hostMatches(host, 'bing.com') || hostMatches(host, 'duckduckgo.com')) return 'search'
    if (hostMatches(host, 'x.com') || hostMatches(host, 'twitter.com') || hostMatches(host, 'mastodon.social') || hostMatches(host, 'bsky.app')) return 'social'
    if (hostMatches(host, 'alternativeto.net') || hostMatches(host, 'privacyguides.org')) return 'known_partner'
    return 'other'
  } catch {
    return undefined
  }
}

export function buildSignupPageviewPayload(rawUrl: string, rawReferrer: string): SignupPageviewPayload {
  const current = new URL(rawUrl)
  return {
    domain: 'app.silentsuite.io',
    name: 'pageview',
    url: sanitizedSignupPageUrl(rawUrl),
    props: { referrer_category: classifyReferrer(rawReferrer) ?? 'other', ...canonicalizeCampaignParams(current.searchParams) },
  }
}

export function buildPlanSelectedPayload(planClass: PlanClass): PlanSelectedPayload {
  return { domain: 'app.silentsuite.io', name: 'Plan Selected', url: 'https://app.silentsuite.io/signup', props: { plan_class: planClass } }
}

export function buildCheckoutInitiatedPayload(planClass: PlanClass, paymentMethod: Exclude<PaymentMethod, 'unknown'>): CheckoutInitiatedPayload {
  return { domain: 'app.silentsuite.io', name: 'Checkout Initiated', url: 'https://app.silentsuite.io/signup', props: { plan_class: planClass, payment_method: paymentMethod } }
}

export function buildCheckoutReturnedPayload(outcome: CheckoutOutcome, paymentMethod: PaymentMethod): CheckoutReturnedPayload {
  const url = outcome === 'cancelled'
    ? 'https://app.silentsuite.io/signup/cancel'
    : outcome === 'pending'
      ? 'https://app.silentsuite.io/signup/pending-payment'
      : 'https://app.silentsuite.io/signup/success'
  return { domain: 'app.silentsuite.io', name: 'Checkout Returned', url, props: { outcome, payment_method: paymentMethod } }
}

export function buildSubscriptionManagementEntryPayload(): SubscriptionManagementEntryPayload {
  return { domain: 'app.silentsuite.io', name: 'Subscription Management Entry', url: 'https://app.silentsuite.io/settings/subscription', props: { surface: 'subscription_settings' } }
}
