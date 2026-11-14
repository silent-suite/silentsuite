// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ANALYTICS_UPSTREAM, CLOUDFLARE_IP_RANGES, clientAddress, isCloudflareAddress, relayAnalyticsEvent } from '../analytics-relay'
import {
  buildCheckoutInitiatedPayload,
  buildCheckoutReturnedPayload,
  buildPlanSelectedPayload,
  buildSignupPageviewPayload,
  buildSignupStepPayload,
  buildSubscriptionManagementEntryPayload,
  SIGNUP_STEPS,
} from '../public-analytics'
import { buildWebVitalPayload, WEB_VITAL_METRICS, WEB_VITAL_RATINGS, WEB_VITALS_PAGES } from '../web-vitals'

const earlyOffer = {
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
const standardOffer = { ...earlyOffer, planId: 'standard_annual' as const, customerClass: 'standard' as const, annualAmountMinor: 4800 as const, monthlyEquivalentMinor: 400 as const, providers: ['stripe'] as ('stripe' | 'btcpay')[] }

const CF_EDGE = '172.70.1.2'
const VISITOR = '203.0.113.7'

function relayRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/event', {
    method: 'POST',
    headers: {
      host: 'app.silentsuite.io',
      origin: 'https://app.silentsuite.io',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 test',
      'x-real-ip': CF_EDGE,
      'cf-connecting-ip': VISITOR,
      cookie: 'session=secret',
      authorization: 'Bearer secret',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function upstream() {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 202 }))
}

function hostedEnv(commercial = 'true') {
  vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
  vi.stubEnv('NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED', commercial)
}

describe('app analytics relay', () => {
  afterEach(() => vi.unstubAllEnvs())

  it.each([
    ['pageview', buildSignupPageviewPayload('https://app.silentsuite.io/signup', 'https://github.com/x')],
    ['pageview without referrer', buildSignupPageviewPayload('https://app.silentsuite.io/signup/success', '')],
    ['Plan Selected early', buildPlanSelectedPayload(earlyOffer)],
    ['Plan Selected standard', buildPlanSelectedPayload(standardOffer)],
    ['Checkout Initiated', buildCheckoutInitiatedPayload(earlyOffer, 'btcpay')],
    ['Checkout Returned', buildCheckoutReturnedPayload('cancelled', 'unknown')],
    ['Subscription Management Entry', buildSubscriptionManagementEntryPayload()],
    ...SIGNUP_STEPS.map((step) => [`Signup Step ${step}`, buildSignupStepPayload(step)] as const),
  ])('forwards the canonical %s payload with only the allowlisted headers', async (_label, payload) => {
    hostedEnv()
    const fetcher = upstream()
    const response = await relayAnalyticsEvent(relayRequest(payload), fetcher)

    expect(response.status).toBe(202)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://plausible.silentsuite.io/api/event')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual(payload)
    const headers = new Headers(init?.headers)
    expect([...headers.keys()].sort()).toEqual(['content-type', 'user-agent', 'x-plausible-ip'])
    expect(headers.get('user-agent')).toBe('Mozilla/5.0 test')
    expect(headers.get('x-plausible-ip')).toBe(VISITOR)
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('keeps the upstream fixed', () => {
    expect(ANALYTICS_UPSTREAM).toBe('https://plausible.silentsuite.io/api/event')
  })

  it('forwards the server-built payload, not the client bytes', async () => {
    hostedEnv()
    const fetcher = upstream()
    const reordered = '{"props":{"step":"plan_shown"},"url":"https://app.silentsuite.io/signup","name":"Signup Step","domain":"app.silentsuite.io"}'
    expect((await relayAnalyticsEvent(relayRequest(reordered), fetcher)).status).toBe(202)
    expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify(buildSignupStepPayload('plan_shown')))
  })

  it.each([
    ['unknown event', { domain: 'app.silentsuite.io', name: 'Signup CTA Click', url: 'https://app.silentsuite.io/signup' }],
    ['unknown step', { ...buildSignupStepPayload('completed'), props: { step: 'password_entered' } }],
    ['extra prop', { ...buildSignupStepPayload('completed'), props: { step: 'completed', email: 'a@example.com' } }],
    ['extra top-level key', { ...buildSignupStepPayload('completed'), interactive: true }],
    ['wrong domain', { ...buildSignupStepPayload('completed'), domain: 'silentsuite.io' }],
    ['wrong url', { ...buildSignupStepPayload('completed'), url: 'https://app.silentsuite.io/calendar' }],
    ['url with query', { ...buildSignupStepPayload('completed'), url: 'https://app.silentsuite.io/signup?email=a@example.com' }],
    ['pageview props', { ...buildSignupPageviewPayload('https://app.silentsuite.io/signup', ''), props: { step: 'completed' } }],
    ['pageview on private route', { domain: 'app.silentsuite.io', name: 'pageview', url: 'https://app.silentsuite.io/calendar' }],
    ['raw referrer', { ...buildSignupPageviewPayload('https://app.silentsuite.io/signup', ''), referrer: 'https://github.com/org/repo?token=x' }],
    ['tampered amount', { ...buildPlanSelectedPayload(earlyOffer), props: { ...buildPlanSelectedPayload(earlyOffer).props, annual_amount_minor: 1 } }],
    ['mismatched return route', { ...buildCheckoutReturnedPayload('returned', 'stripe'), url: 'https://app.silentsuite.io/signup/cancel' }],
    ['string amount', { ...buildPlanSelectedPayload(earlyOffer), props: { ...buildPlanSelectedPayload(earlyOffer).props, annual_amount_minor: '3600' } }],
    ['array', [buildSignupStepPayload('completed')]],
    ['null', null],
    ['invalid JSON', '{"name":'],
  ])('drops %s without an upstream call', async (_label, body) => {
    hostedEnv()
    const fetcher = upstream()
    const response = await relayAnalyticsEvent(relayRequest(body as unknown), fetcher)
    expect(response.status).toBe(204)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    ['another host', { host: 'previewapp.silentsuite.io' }],
    ['a loopback host', { host: '127.0.0.1:3000' }],
    ['a lookalike host', { host: 'app.silentsuite.io.evil.test' }],
    ['a foreign origin', { origin: 'https://evil.test' }],
    ['the http origin', { origin: 'http://app.silentsuite.io' }],
    ['a cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
    ['a same-site fetch', { 'sec-fetch-site': 'same-site' }],
    ['a form content type', { 'content-type': 'application/x-www-form-urlencoded' }],
    ['a declared oversize body', { 'content-length': '4096' }],
  ])('stays inert for %s', async (_label, headers) => {
    hostedEnv()
    const fetcher = upstream()
    const response = await relayAnalyticsEvent(relayRequest(buildSignupStepPayload('completed'), headers), fetcher)
    expect(response.status).toBe(204)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('requires an Origin header', async () => {
    hostedEnv()
    const fetcher = upstream()
    const request = relayRequest(buildSignupStepPayload('completed'))
    const headers = new Headers(request.headers)
    headers.delete('origin')
    const response = await relayAnalyticsEvent(new Request(request.url, { method: 'POST', headers, body: JSON.stringify(buildSignupStepPayload('completed')) }), fetcher)
    expect(response.status).toBe(204)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('admits a request without Sec-Fetch-Site and a text/plain beacon body', async () => {
    hostedEnv()
    const fetcher = upstream()
    const request = relayRequest(buildSignupStepPayload('completed'), { 'content-type': 'text/plain;charset=UTF-8' })
    const headers = new Headers(request.headers)
    headers.delete('sec-fetch-site')
    const response = await relayAnalyticsEvent(new Request(request.url, { method: 'POST', headers, body: JSON.stringify(buildSignupStepPayload('completed')) }), fetcher)
    expect(response.status).toBe(202)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('accepts whitespace inside the cap', async () => {
    hostedEnv()
    const fetcher = upstream()
    const response = await relayAnalyticsEvent(relayRequest(`${JSON.stringify(buildSignupStepPayload('completed'))}${' '.repeat(1900)}`), fetcher)
    expect(response.status).toBe(202)
  })

  it('enforces the 2 KB cap on the streamed body, not only the declared length', async () => {
    hostedEnv()
    const fetcher = upstream()
    // Valid, allowlisted JSON padded with whitespace: only the byte cap can reject it.
    const padded = `${JSON.stringify(buildSignupStepPayload('completed'))}${' '.repeat(2100)}`
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(padded))
        controller.close()
      },
    })
    const request = relayRequest('')
    const response = await relayAnalyticsEvent(new Request(request.url, { method: 'POST', headers: request.headers, body: stream, duplex: 'half' } as RequestInit), fetcher)
    expect(response.status).toBe(204)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([['true'], ['TRUE'], [undefined]])('forwards nothing in a self-hosted build (flag %s)', async (commercial) => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    vi.stubEnv('NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED', commercial)
    const fetcher = upstream()
    for (const payload of [buildSignupPageviewPayload('https://app.silentsuite.io/signup', ''), buildSignupStepPayload('completed')]) {
      expect((await relayAnalyticsEvent(relayRequest(payload), fetcher)).status).toBe(204)
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([['false'], [''], [undefined], ['TRUE']])('relays pageviews but no custom events when the commercial flag is %s', async (commercial) => {
    hostedEnv(commercial as string)
    if (commercial === undefined) vi.stubEnv('NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED', undefined)
    const fetcher = upstream()
    expect((await relayAnalyticsEvent(relayRequest(buildSignupPageviewPayload('https://app.silentsuite.io/signup', '')), fetcher)).status).toBe(202)
    expect((await relayAnalyticsEvent(relayRequest(buildSignupStepPayload('completed')), fetcher)).status).toBe(204)
    expect((await relayAnalyticsEvent(relayRequest(buildPlanSelectedPayload(earlyOffer)), fetcher)).status).toBe(204)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('returns 204 silently when the upstream fails or times out', async () => {
    hostedEnv()
    const fetcher = vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError') })
    const response = await relayAnalyticsEvent(relayRequest(buildSignupStepPayload('completed')), fetcher)
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
  })

  it('omits the IP header when no trustworthy client address exists', async () => {
    hostedEnv()
    const fetcher = upstream()
    await relayAnalyticsEvent(relayRequest(buildSignupStepPayload('completed'), { 'x-real-ip': 'not-an-ip' }), fetcher)
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('x-plausible-ip')).toBe(false)
  })
})

describe('relay client address', () => {
  const headers = (values: Record<string, string>) => new Headers(values)

  it('uses CF-Connecting-IP only when the nginx peer is a Cloudflare edge', () => {
    expect(clientAddress(headers({ 'x-real-ip': CF_EDGE, 'cf-connecting-ip': VISITOR }))).toBe(VISITOR)
    expect(clientAddress(headers({ 'x-real-ip': '2606:4700:10::ac43:1', 'cf-connecting-ip': '2001:db8::5' }))).toBe('2001:db8::5')
  })

  it('ignores a forged CF-Connecting-IP from a direct origin caller', () => {
    expect(clientAddress(headers({ 'x-real-ip': VISITOR, 'cf-connecting-ip': '198.51.100.1' }))).toBe(VISITOR)
  })

  it('never reads X-Forwarded-For', () => {
    expect(clientAddress(headers({ 'x-forwarded-for': VISITOR }))).toBeUndefined()
    expect(clientAddress(headers({ 'x-real-ip': VISITOR, 'x-forwarded-for': '198.51.100.1' }))).toBe(VISITOR)
  })

  it.each([
    [{ 'x-real-ip': `${VISITOR}, ${CF_EDGE}` }],
    [{ 'x-real-ip': 'localhost' }],
    [{ 'x-real-ip': CF_EDGE, 'cf-connecting-ip': `${VISITOR}, 198.51.100.1` }],
    [{ 'x-real-ip': CF_EDGE, 'cf-connecting-ip': 'unknown' }],
    [{ 'x-real-ip': CF_EDGE }],
    [{}],
  ])('omits the address for an invalid or missing literal %#', (values) => {
    expect(clientAddress(headers(values))).toBeUndefined()
  })

  it.each([
    ['173.245.48.0', true], ['173.245.63.255', true], ['173.245.64.0', false],
    ['104.16.0.1', true], ['104.23.255.255', true], ['104.24.0.0', true], ['104.28.0.0', false],
    ['162.159.255.255', true], ['198.41.255.255', true], ['198.41.127.255', false],
    ['::ffff:172.64.0.1', true], ['::ffff:203.0.113.7', false],
    ['2400:cb00::1', true], ['2a06:98c0::1', true], ['2a06:98c7:ffff::1', true], ['2a06:98c8::1', false],
    ['2001:db8::1', false], ['10.0.0.1', false], ['127.0.0.1', false],
  ])('classifies %s as Cloudflare=%s', (address, expected) => {
    expect(isCloudflareAddress(address)).toBe(expected)
  })

  it('embeds the published Cloudflare ranges', () => {
    expect(CLOUDFLARE_IP_RANGES).toHaveLength(22)
    expect(CLOUDFLARE_IP_RANGES).toContain('131.0.72.0/22')
    expect(CLOUDFLARE_IP_RANGES).toContain('2c0f:f248::/32')
  })
})

describe('relay public-page speed ratings', () => {
  afterEach(() => vi.unstubAllEnvs())

  it.each(WEB_VITALS_PAGES.flatMap((page) => WEB_VITAL_METRICS.flatMap((metric) => WEB_VITAL_RATINGS.map((rating) => [page, metric, rating] as const))))(
    'forwards %s %s %s without User-Agent or client address when WEB_VITALS_FORWARD=on',
    async (page, metric, rating) => {
      hostedEnv('false')
      vi.stubEnv('WEB_VITALS_FORWARD', 'on')
      const fetcher = upstream()
      const payload = buildWebVitalPayload(metric, rating, page)
      expect((await relayAnalyticsEvent(relayRequest(payload), fetcher)).status).toBe(202)
      const [, init] = fetcher.mock.calls[0]
      expect(JSON.parse(String(init?.body))).toEqual(payload)
      const headers = new Headers(init?.headers)
      expect([...headers.keys()].sort()).toEqual(['content-type', 'user-agent'])
      expect(headers.get('user-agent')).toBe('')
      expect(String(init?.body)).not.toContain(VISITOR)
    },
  )

  it.each([[undefined], ['off'], ['true'], ['ON']])('forwards nothing when WEB_VITALS_FORWARD is %s', async (flag) => {
    hostedEnv('true')
    vi.stubEnv('WEB_VITALS_FORWARD', flag)
    const fetcher = upstream()
    expect((await relayAnalyticsEvent(relayRequest(buildWebVitalPayload('LCP', 'good', '/login')), fetcher)).status).toBe(204)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    ['a logged-in page', { ...buildWebVitalPayload('LCP', 'good', '/login'), url: 'https://app.silentsuite.io/calendar', props: { metric: 'LCP', rating: 'good', page: '/calendar' } }],
    ['mismatched page prop', { ...buildWebVitalPayload('LCP', 'good', '/login'), props: { metric: 'LCP', rating: 'good', page: '/signup' } }],
    ['a raw value', { ...buildWebVitalPayload('LCP', 'good', '/login'), props: { metric: 'LCP', rating: 'good', page: '/login', value: 1234 } }],
    ['an unlisted metric', { ...buildWebVitalPayload('LCP', 'good', '/login'), props: { metric: 'FCP', rating: 'good', page: '/login' } }],
    ['an unknown rating', { ...buildWebVitalPayload('LCP', 'good', '/login'), props: { metric: 'LCP', rating: 'fast', page: '/login' } }],
  ])('drops a Web Vital with %s', async (_label, body) => {
    hostedEnv('true')
    vi.stubEnv('WEB_VITALS_FORWARD', 'on')
    const fetcher = upstream()
    expect((await relayAnalyticsEvent(relayRequest(body), fetcher)).status).toBe(204)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('forwards nothing in a self-hosted build', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    vi.stubEnv('WEB_VITALS_FORWARD', 'on')
    const fetcher = upstream()
    expect((await relayAnalyticsEvent(relayRequest(buildWebVitalPayload('CLS', 'poor', '/signup')), fetcher)).status).toBe(204)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
