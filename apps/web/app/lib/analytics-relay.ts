import { BlockList, isIP } from 'node:net'

import type { AnnualOfferAnalyticsDimensions } from './annual-offer-presentation'
import {
  buildCheckoutReturnedPayload,
  buildSignupStepPayload,
  buildSubscriptionManagementEntryPayload,
  CANONICAL_REFERRERS,
  type CheckoutOutcome,
  type CommercialEventPayload,
  type PaymentMethod,
  SIGNUP_ANALYTICS_PATHS,
  SIGNUP_STEPS,
  type SignupPageviewPayload,
} from './public-analytics'
import { buildWebVitalPayload, WEB_VITAL_METRICS, WEB_VITAL_RATINGS, WEB_VITALS_PAGES, type WebVitalPayload } from './web-vitals'

/*
 * Same-origin measurement relay for app.silentsuite.io (POST /api/event).
 *
 * The browser posts to its own origin, so no CORS is involved and a blocklist
 * rule aimed at the analytics host does not drop the request. Nothing the
 * client sends is forwarded verbatim: the request body must equal one of the
 * finite payloads below, and the payload forwarded is the server's own copy.
 * Only the User-Agent and one client address travel upstream; cookies,
 * authorization and every other request header stay here. Nothing is logged
 * or stored.
 *
 * Hosted only: self-hosted builds, previews and any request whose Host is not
 * app.silentsuite.io get 204 and no upstream call. Pageviews follow the
 * hosted gate alone (as the client sender does); custom events additionally
 * need NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED=true.
 *
 * Public-page speed ratings ('Web Vital') are forwarded only when the server
 * env WEB_VITALS_FORWARD=on, and without the User-Agent or client address:
 * Plausible then sees the relay, so these count events, not visitors.
 */

export const ANALYTICS_UPSTREAM = 'https://plausible.silentsuite.io/api/event'
const APP_HOST = 'app.silentsuite.io'
const APP_ORIGIN = 'https://app.silentsuite.io'
const MAX_BODY_BYTES = 2048
const UPSTREAM_TIMEOUT_MS = 3000

// Source: https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6,
// fetched 2026-11-13. A stale list only makes a new edge address look like a
// direct caller, so the event carries the edge IP; it never admits a forged one.
export const CLOUDFLARE_IP_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
] as const

const cloudflareRanges = new BlockList()
for (const range of CLOUDFLARE_IP_RANGES) {
  const [network, prefix] = range.split('/')
  cloudflareRanges.addSubnet(network, Number(prefix), network.includes(':') ? 'ipv6' : 'ipv4')
}

function singleAddress(raw: string | null): string | undefined {
  const value = raw?.trim()
  return value && isIP(value) ? value : undefined
}

export function isCloudflareAddress(address: string): boolean {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1]
  if (mapped && isIP(mapped) === 4) return cloudflareRanges.check(mapped, 'ipv4')
  const family = isIP(address)
  if (family === 4) return cloudflareRanges.check(address, 'ipv4')
  if (family === 6) return cloudflareRanges.check(address, 'ipv6')
  return false
}

/*
 * nginx on the app host overwrites X-Real-IP with the TCP peer. The origin is
 * reachable without Cloudflare, so CF-Connecting-IP is trusted only when that
 * peer is a Cloudflare edge; otherwise the peer itself is the client.
 * X-Forwarded-For is never read: nginx appends to whatever the caller sent.
 */
export function clientAddress(headers: Headers): string | undefined {
  const peer = singleAddress(headers.get('x-real-ip'))
  if (!peer) return undefined
  return isCloudflareAddress(peer) ? singleAddress(headers.get('cf-connecting-ip')) : peer
}

// The two canonical annual offers (see parseAnnualOffer in billing-v2.ts).
const OFFER_DIMENSIONS: readonly AnnualOfferAnalyticsDimensions[] = [
  { plan_id: 'early_annual', customer_class: 'early', billing_interval: 'annual', annual_amount_minor: 3600, monthly_equivalent_minor: 300, currency: 'EUR' },
  { plan_id: 'standard_annual', customer_class: 'standard', billing_interval: 'annual', annual_amount_minor: 4800, monthly_equivalent_minor: 400, currency: 'EUR' },
]
const CHECKOUT_OUTCOMES: readonly CheckoutOutcome[] = ['returned', 'cancelled', 'failed', 'pending']
const RETURN_METHODS: readonly PaymentMethod[] = ['stripe', 'btcpay', 'unknown']

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

type RelayedPayload = SignupPageviewPayload | CommercialEventPayload | WebVitalPayload
type EntryKind = 'pageview' | 'custom' | 'vital'
type InventoryEntry = { payload: RelayedPayload; kind: EntryKind }

function buildInventory(): ReadonlyMap<string, InventoryEntry> {
  const inventory = new Map<string, InventoryEntry>()
  const add = (payload: RelayedPayload, custom: boolean) => inventory.set(canonicalJson(payload), { payload, kind: custom ? 'custom' : 'pageview' })
  for (const path of SIGNUP_ANALYTICS_PATHS) {
    const url = `https://${APP_HOST}${path}`
    add({ domain: APP_HOST, name: 'pageview', url }, false)
    for (const referrer of CANONICAL_REFERRERS) add({ domain: APP_HOST, name: 'pageview', url, referrer }, false)
  }
  for (const props of OFFER_DIMENSIONS) {
    add({ domain: APP_HOST, name: 'Plan Selected', url: 'https://app.silentsuite.io/signup', props }, true)
    for (const payment_method of ['stripe', 'btcpay'] as const) {
      add({ domain: APP_HOST, name: 'Checkout Initiated', url: 'https://app.silentsuite.io/signup', props: { ...props, payment_method } }, true)
    }
  }
  for (const outcome of CHECKOUT_OUTCOMES) {
    for (const method of RETURN_METHODS) add(buildCheckoutReturnedPayload(outcome, method), true)
  }
  add(buildSubscriptionManagementEntryPayload(), true)
  for (const step of SIGNUP_STEPS) add(buildSignupStepPayload(step), true)
  for (const page of WEB_VITALS_PAGES) {
    for (const metric of WEB_VITAL_METRICS) {
      for (const rating of WEB_VITAL_RATINGS) {
        const payload = buildWebVitalPayload(metric, rating, page)
        inventory.set(canonicalJson(payload), { payload, kind: 'vital' })
      }
    }
  }
  return inventory
}

const INVENTORY = buildInventory()

export function hostedBuild(): boolean {
  return process.env.NEXT_PUBLIC_SELF_HOSTED !== 'true'
}

function customEventsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED === 'true'
}

function webVitalsForwardEnabled(): boolean {
  return process.env.WEB_VITALS_FORWARD === 'on'
}

/** Same-origin browser POST of a small JSON body to the hosted app. Shared with the error relay. */
export function isAcceptedRequest(request: Request, maxBytes: number = MAX_BODY_BYTES): boolean {
  if (request.method !== 'POST') return false
  if (request.headers.get('host')?.toLowerCase() !== APP_HOST) return false
  // Browser hygiene, not a trust boundary: a non-browser caller can set both.
  if (request.headers.get('origin') !== APP_ORIGIN) return false
  const site = request.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin') return false
  const contentType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json' && contentType !== 'text/plain') return false
  const declared = request.headers.get('content-length')
  return declared === null || Number(declared) <= maxBytes
}

export async function readCappedBody(request: Request, maxBytes: number = MAX_BODY_BYTES): Promise<string | undefined> {
  if (!request.body) return undefined
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined)
        return undefined
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

export function respond(status: 202 | 204): Response {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function relayAnalyticsEvent(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  if (!hostedBuild() || !isAcceptedRequest(request)) return respond(204)

  const raw = await readCappedBody(request)
  if (raw === undefined) return respond(204)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return respond(204)
  }

  const entry = INVENTORY.get(canonicalJson(parsed))
  if (!entry) return respond(204)
  if (entry.kind === 'custom' && !customEventsEnabled()) return respond(204)
  if (entry.kind === 'vital' && !webVitalsForwardEnabled()) return respond(204)

  const headers = new Headers({
    'Content-Type': 'application/json',
    // Plausible derives its daily visitor hash and country from these two
    // values; it stores neither in raw form, and this relay stores nothing.
    // Speed ratings carry neither.
    'User-Agent': entry.kind === 'vital' ? '' : request.headers.get('user-agent') ?? '',
  })
  const address = entry.kind === 'vital' ? undefined : clientAddress(request.headers)
  if (address) headers.set('X-Plausible-IP', address)

  try {
    await fetcher(ANALYTICS_UPSTREAM, {
      method: 'POST',
      headers,
      body: JSON.stringify(entry.payload),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch {
    // A measurement failure never surfaces to the visitor and is not logged.
    return respond(204)
  }
  return respond(202)
}
