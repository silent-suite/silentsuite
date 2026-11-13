import type { AnnualOffer } from './billing-v2'
import { annualOfferAnalyticsDimensions, type AnnualOfferAnalyticsDimensions } from './annual-offer-presentation'

export type CampaignParams = Partial<{
  utm_source: 'search' | 'social' | 'github' | 'newsletter' | 'community' | 'known_partner' | 'paid' | 'other'
  utm_medium: 'organic' | 'referral' | 'email' | 'community' | 'paid_social' | 'cpc' | 'qr' | 'other'
  utm_campaign: 'beta-2026-q2' | 'other_campaign'
}>

export type ReferrerCategory = 'direct' | 'search' | 'social' | 'github' | 'known_partner' | 'other'

// Baseline pageviews are deliberately property-free: a Plausible site property
// allowlist can discard every pageview that carries an unapproved custom property,
// so the signup pageview transmits only the canonical route and referrer. Campaign
// and referrer dimensions live on flag-gated commercial events, never here.
export type SignupPageviewPayload = {
  domain: 'app.silentsuite.io'
  name: 'pageview'
  url: string
  referrer?: CanonicalReferrer
}

export const SIGNUP_ANALYTICS_PATHS = ['/signup', '/signup/pending-payment', '/signup/success', '/signup/cancel'] as const
type SignupAnalyticsPath = typeof SIGNUP_ANALYTICS_PATHS[number]

type PaymentMethod = 'stripe' | 'btcpay' | 'unknown'
type CheckoutOutcome = 'returned' | 'cancelled' | 'failed' | 'pending'
export type CanonicalReferrer =
  | 'https://www.google.com/'
  | 'https://www.bing.com/'
  | 'https://duckduckgo.com/'
  | 'https://search.brave.com/'
  | 'https://www.ecosia.org/'
  | 'https://x.com/'
  | 'https://www.reddit.com/'
  | 'https://github.com/'
  | 'https://mastodon.social/'
  | 'https://bsky.app/'
  | 'https://alternativeto.net/'
  | 'https://www.privacyguides.org/'
  | 'https://news.ycombinator.com/'
type PlanSelectedPayload = {
  domain: 'app.silentsuite.io'
  name: 'Plan Selected'
  url: 'https://app.silentsuite.io/signup'
  props: AnnualOfferAnalyticsDimensions
}
type CheckoutInitiatedPayload = {
  domain: 'app.silentsuite.io'
  name: 'Checkout Initiated'
  url: 'https://app.silentsuite.io/signup'
  props: AnnualOfferAnalyticsDimensions & { payment_method: Exclude<PaymentMethod, 'unknown'> }
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

const GOOGLE_SEARCH_DOMAINS = [
  'google.com', 'google.co.uk', 'google.de', 'google.fr', 'google.nl', 'google.be',
  'google.ch', 'google.at', 'google.ca', 'google.com.au', 'google.co.nz', 'google.ie',
  'google.es', 'google.it', 'google.pt', 'google.se', 'google.no', 'google.dk',
  'google.fi', 'google.pl', 'google.cz', 'google.co.jp', 'google.co.kr', 'google.co.in',
  'google.com.br', 'google.com.mx', 'google.co.za',
] as const

function hasNonCanonicalRawSyntax(raw: string): boolean {
  return /[\u0000-\u0020\u007f\\]/.test(raw)
}

function rawHttpAuthority(raw: string): string | undefined {
  return raw.match(/^https?:\/\/([^/?#]+)(?:[/?#]|$)/i)?.[1]
}

function hasExplicitPort(raw: string): boolean {
  const authority = rawHttpAuthority(raw)
  return authority ? /:\d*$/.test(authority) : false
}

function isCanonicalDnsAuthority(authority: string): boolean {
  return authority.length <= 253 && authority.split('.').every(
    (label) => label.length >= 1
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  )
}

function hasNonCanonicalAuthoritySyntax(raw: string): boolean {
  const authority = rawHttpAuthority(raw)
  return !authority || !isCanonicalDnsAuthority(authority)
}

type ReferrerMatch = { category: ReferrerCategory, referrer: CanonicalReferrer }

function matchReferrer(raw: string): ReferrerMatch | undefined {
  if (!raw) return undefined
  if (hasNonCanonicalRawSyntax(raw)) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    const host = url.hostname.toLowerCase()
    if (url.username || url.password || hasExplicitPort(raw) || hasNonCanonicalAuthoritySyntax(raw) || host === 'localhost' || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host) || host.includes('xn--')) return undefined
    if (GOOGLE_SEARCH_DOMAINS.some((domain) => hostMatches(host, domain))) return { category: 'search', referrer: 'https://www.google.com/' }
    if (hostMatches(host, 'bing.com')) return { category: 'search', referrer: 'https://www.bing.com/' }
    if (hostMatches(host, 'duckduckgo.com')) return { category: 'search', referrer: 'https://duckduckgo.com/' }
    if (hostMatches(host, 'search.brave.com')) return { category: 'search', referrer: 'https://search.brave.com/' }
    if (hostMatches(host, 'ecosia.org')) return { category: 'search', referrer: 'https://www.ecosia.org/' }
    if (hostMatches(host, 'x.com') || hostMatches(host, 'twitter.com') || host === 't.co') return { category: 'social', referrer: 'https://x.com/' }
    if (hostMatches(host, 'reddit.com') || host === 'redd.it') return { category: 'other', referrer: 'https://www.reddit.com/' }
    if (hostMatches(host, 'github.com')) return { category: 'github', referrer: 'https://github.com/' }
    if (host === 'mastodon.social') return { category: 'social', referrer: 'https://mastodon.social/' }
    if (hostMatches(host, 'bsky.app')) return { category: 'social', referrer: 'https://bsky.app/' }
    if (hostMatches(host, 'alternativeto.net')) return { category: 'known_partner', referrer: 'https://alternativeto.net/' }
    if (hostMatches(host, 'privacyguides.org')) return { category: 'known_partner', referrer: 'https://www.privacyguides.org/' }
    if (host === 'news.ycombinator.com') return { category: 'other', referrer: 'https://news.ycombinator.com/' }
    return undefined
  } catch {
    return undefined
  }
}

export function classifyReferrer(raw: string): ReferrerCategory | undefined {
  if (!raw) return 'direct'
  try {
    new URL(raw)
    return matchReferrer(raw)?.category ?? 'other'
  } catch {
    return undefined
  }
}

export function canonicalizeReferrer(raw: string): CanonicalReferrer | undefined {
  return matchReferrer(raw)?.referrer
}

export function buildSignupPageviewPayload(rawUrl: string, rawReferrer: string): SignupPageviewPayload {
  const referrer = canonicalizeReferrer(rawReferrer)
  return {
    domain: 'app.silentsuite.io',
    name: 'pageview',
    url: sanitizedSignupPageUrl(rawUrl),
    ...(referrer ? { referrer } : {}),
  }
}

export function buildPlanSelectedPayload(offer: AnnualOffer): PlanSelectedPayload {
  return { domain: 'app.silentsuite.io', name: 'Plan Selected', url: 'https://app.silentsuite.io/signup', props: annualOfferAnalyticsDimensions(offer) }
}

export function buildCheckoutInitiatedPayload(offer: AnnualOffer, paymentMethod: Exclude<PaymentMethod, 'unknown'>): CheckoutInitiatedPayload {
  return { domain: 'app.silentsuite.io', name: 'Checkout Initiated', url: 'https://app.silentsuite.io/signup', props: { ...annualOfferAnalyticsDimensions(offer), payment_method: paymentMethod } }
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
