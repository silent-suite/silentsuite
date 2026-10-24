import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BillingResponseError, cancelAnonymousPaymentSessionRecovery } from '../billing-v2'
import {
  BITCOIN_CANCELLATION_WARNING,
  PAYMENT_FLOW_CANCELLATION_MESSAGES,
  cancelPaymentFlow,
} from '../payment-flow-cancellation'

const BILLING = 'https://billing.example.test'
const CANCEL_URL = `${BILLING}/subscription/payment-flows/cancel`

function ok(body: unknown, status = 200) {
  return { ok: true, status, json: async () => body } as Response
}

function problem(status: number, type: string | null, detail: string) {
  return {
    ok: false,
    status,
    json: async () => (type === null ? { detail } : { type, detail }),
  } as Response
}

function fetcherReturning(response: Response) {
  return vi.fn(async () => response)
}

function requestOf(fetcher: ReturnType<typeof fetcherReturning>) {
  const call = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit]
  return { url: String(call[0]), init: call[1] }
}

describe('cancelPaymentFlow request shape', () => {
  it('sends the closed bitcoin acknowledgement body only after an explicit local acknowledgement', async () => {
    const fetcher = fetcherReturning(ok({ cancelled: true, flowKind: 'btcpay_annual' }))

    const result = await cancelPaymentFlow({
      fetcher,
      billingApiUrl: BILLING,
      provider: 'btcpay',
      confirmNoBitcoinSent: true,
    })

    expect(fetcher).toHaveBeenCalledTimes(1)
    const { url, init } = requestOf(fetcher)
    expect(url).toBe(CANCEL_URL)
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' })
    expect(init.body).toBe('{"confirmNoBitcoinSent":true}')
    expect(result).toEqual({ cancelled: true, flowKind: 'btcpay_annual' })
  })

  it('makes zero cancellation requests for a bitcoin flow without acknowledgement', async () => {
    const fetcher = fetcherReturning(ok({ cancelled: true, flowKind: 'btcpay_annual' }))

    const result = await cancelPaymentFlow({
      fetcher,
      billingApiUrl: BILLING,
      provider: 'btcpay',
      confirmNoBitcoinSent: false,
    })

    expect(fetcher).not.toHaveBeenCalled()
    expect(result).toEqual({
      cancelled: false,
      failure: 'bitcoin-acknowledgement-required',
      message: PAYMENT_FLOW_CANCELLATION_MESSAGES['bitcoin-acknowledgement-required'],
    })
  })

  it.each([true, false])('never asserts bitcoin facts for a card flow (acknowledged=%s)', async (confirmNoBitcoinSent) => {
    const fetcher = fetcherReturning(ok({ cancelled: true, flowKind: 'stripe_pay_now' }))

    const result = await cancelPaymentFlow({ fetcher, billingApiUrl: BILLING, provider: 'stripe', confirmNoBitcoinSent })

    const { init } = requestOf(fetcher)
    expect(init.body).toBe('{}')
    expect(String(init.body)).not.toContain('confirmNoBitcoinSent')
    expect(result).toEqual({ cancelled: true, flowKind: 'stripe_pay_now' })
  })

  it.each([
    ['unacknowledged', false, '{}'],
    ['acknowledged', true, '{"confirmNoBitcoinSent":true}'],
  ] as const)('sends the %s closed body for an unverified provider', async (_label, confirmNoBitcoinSent, body) => {
    const fetcher = fetcherReturning(ok({ cancelled: true, flowKind: 'stripe_pay_now' }))

    await cancelPaymentFlow({ fetcher, billingApiUrl: BILLING, provider: 'unknown', confirmNoBitcoinSent })

    expect(requestOf(fetcher).init.body).toBe(body)
  })

  it('tolerates a trailing slash on the billing base URL', async () => {
    const fetcher = fetcherReturning(ok({ cancelled: true, flowKind: 'stripe_pay_now' }))

    await cancelPaymentFlow({ fetcher, billingApiUrl: `${BILLING}/`, provider: 'stripe', confirmNoBitcoinSent: false })

    expect(requestOf(fetcher).url).toBe(CANCEL_URL)
  })

  it('returns a null flow kind when the server omits it', async () => {
    const fetcher = fetcherReturning(ok({ cancelled: true }))

    expect(await cancelPaymentFlow({ fetcher, billingApiUrl: BILLING, provider: 'stripe', confirmNoBitcoinSent: false }))
      .toEqual({ cancelled: true, flowKind: null })
  })

  // Superseded draft #854 (head 81655107968e418d88ddc50493dadf593ca24c2a, diff
  // sha256 529d9e2e…c5cf): cases reproduced verbatim from its test hunk.
  // #770: a retry after a race, or a webhook that already retired the flow,
  // leaves nothing pending. That is the outcome the user asked for, and the
  // panel re-proves the current flow and offer before any new payment starts.
  it.each(['stripe', 'btcpay'] as const)('treats a %s 200 no_active_flow reply as already resolved', async provider => {
    const fetcher = fetcherReturning(ok({ cancelled: false, reason: 'no_active_flow' }))

    expect(await cancelPaymentFlow({ fetcher, billingApiUrl: BILLING, provider, confirmNoBitcoinSent: true }))
      .toEqual({ cancelled: true, flowKind: null })
  })

  it('does not treat no_active_flow on a non-200 reply as resolved', async () => {
    const fetcher = fetcherReturning({ ok: false, status: 409, json: async () => ({ cancelled: false, reason: 'no_active_flow' }) } as Response)

    expect(await cancelPaymentFlow({ fetcher, billingApiUrl: BILLING, provider: 'stripe', confirmNoBitcoinSent: false }))
      .toMatchObject({ cancelled: false, failure: 'unavailable' })
  })

  // The mapping is exact: another 2xx status or a non-literal flag is not proof.
  it.each([
    ['a 202 status', () => ok({ cancelled: false, reason: 'no_active_flow' }, 202)],
    ['a non-literal cancelled flag', () => ok({ cancelled: 'false', reason: 'no_active_flow' })],
    ['a missing cancelled flag', () => ok({ reason: 'no_active_flow' })],
  ] as const)('does not treat no_active_flow with %s as resolved', async (_label, make) => {
    expect(await cancelPaymentFlow({ fetcher: fetcherReturning(make()), billingApiUrl: BILLING, provider: 'stripe', confirmNoBitcoinSent: false }))
      .toEqual({ cancelled: false, failure: 'unavailable', message: PAYMENT_FLOW_CANCELLATION_MESSAGES.unavailable })
  })
})

// SC2: a refusal is recognised by HTTP 429 alone. Billing's fine limiter sends a
// Problem body and the plugin's coarse limiter its own Error body; neither text
// is ever surfaced, and the wait is derived exactly as billing-v2 derives it.
describe('cancelPaymentFlow rate limiting', () => {
  const NOW = Date.UTC(2026, 9, 22, 12, 0, 0)
  const FINE = { type: 'https://api.silentsuite.io/errors/rate-limit-exceeded', title: 'Too Many Requests', status: 429, detail: 'Rate limit exceeded for account:secret-id' }
  const COARSE = { statusCode: 429, error: 'Too Many Requests', message: 'Rate limit exceeded, retry in 1 minute' }

  function tooMany(body: unknown, retryAfter: string | null) {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 429,
      headers: { 'content-type': 'application/json', ...(retryAfter === null ? {} : { 'retry-after': retryAfter }) },
    })
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => { vi.useRealTimers() })

  const HEADERS = [
    ['integer seconds', '120', 120_000],
    ['an HTTP date', new Date(NOW + 90_000).toUTCString(), 90_000],
    ['a past HTTP date', new Date(NOW - 5_000).toUTCString(), 0],
    ['an unreadable value', 'soon', 15 * 60_000],
    ['a missing header', null, 15 * 60_000],
  ] as const

  it.each([['fine Problem', FINE], ['coarse plugin Error', COARSE]] as const)('maps a %s 429 body to the fixed rate-limited result for every provider', async (_label, body) => {
    for (const provider of ['stripe', 'btcpay', 'unknown'] as const) {
      const fetcher = vi.fn(async () => tooMany(body, '120'))

      const result = await cancelPaymentFlow({ fetcher, billingApiUrl: BILLING, provider, confirmNoBitcoinSent: true })

      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(result).toEqual({
        cancelled: false,
        failure: 'rate-limited',
        message: PAYMENT_FLOW_CANCELLATION_MESSAGES['rate-limited'],
        retryAfterMs: 120_000,
      })
      expect(JSON.stringify(result)).not.toMatch(/Rate limit exceeded|retry in|Too Many Requests|secret-id/)
    }
    expect(PAYMENT_FLOW_CANCELLATION_MESSAGES['rate-limited']).toEqual(expect.any(String))
    expect(PAYMENT_FLOW_CANCELLATION_MESSAGES['rate-limited']).not.toMatch(/Rate limit exceeded|retry in 1 minute/)
  })

  it.each(HEADERS)('derives the wait from %s', async (_label, header, retryAfterMs) => {
    const result = await cancelPaymentFlow({ fetcher: vi.fn(async () => tooMany(FINE, header)), billingApiUrl: BILLING, provider: 'stripe', confirmNoBitcoinSent: false })

    expect(result).toMatchObject({ cancelled: false, failure: 'rate-limited', retryAfterMs })
  })

  it('classifies an unparseable 429 by status alone', async () => {
    expect(await cancelPaymentFlow({ fetcher: vi.fn(async () => tooMany('<html>busy</html>', '120')), billingApiUrl: BILLING, provider: 'stripe', confirmNoBitcoinSent: false }))
      .toMatchObject({ cancelled: false, failure: 'rate-limited', retryAfterMs: 120_000 })
  })

  // The parser inlines billing-v2's retry-after rule (billing-v2.ts is not
  // C-owned). Pin parity against the real billing-v2 path for every header form.
  it.each(HEADERS)('derives the same wait as billing-v2 for %s', async (_label, header) => {
    let reference: unknown
    try {
      await cancelAnonymousPaymentSessionRecovery({
        fetcher: vi.fn(async () => tooMany(COARSE, header)), billingApiUrl: BILLING,
        email: 'parity@example.test', requestKey: 'e91a6d70-0d4e-4352-9bdc-426d1f76d771',
        recoverySecret: 'r'.repeat(43), paymentSessionToken: 'r'.repeat(43),
      })
    } catch (error) { reference = error }
    expect(reference).toBeInstanceOf(BillingResponseError)
    const result = await cancelPaymentFlow({ fetcher: vi.fn(async () => tooMany(COARSE, header)), billingApiUrl: BILLING, provider: 'stripe', confirmNoBitcoinSent: false })

    expect(result).toMatchObject({ failure: 'rate-limited', retryAfterMs: (reference as BillingResponseError).retryAfterMs })
  })

  it('keeps a lost response as the generic fallback rather than a rate limit', async () => {
    expect(await cancelPaymentFlow({ fetcher: vi.fn(async () => { throw new TypeError('network lost') }), billingApiUrl: BILLING, provider: 'stripe', confirmNoBitcoinSent: false }))
      .toEqual({ cancelled: false, failure: 'unavailable', message: PAYMENT_FLOW_CANCELLATION_MESSAGES.unavailable })
  })
})

describe('cancelPaymentFlow failure mapping', () => {
  const SENSITIVE = 'pi_3QsecretABC / cus_9999 / https://checkout.stripe.com/c/pay/cs_live_secret'

  it.each([
    [400, 'https://api.silentsuite.io/errors/bitcoin-cancellation-acknowledgement-required', 'bitcoin-acknowledgement-required'],
    [400, 'https://api.silentsuite.io/errors/invalid-cancellation-request', 'invalid-cancellation-request'],
    [409, 'https://api.silentsuite.io/errors/payment_reconciliation_required', 'payment-reconciliation-required'],
    [502, 'https://api.silentsuite.io/errors/provider-cancellation-failed', 'provider-cancellation-failed'],
  ] as const)('maps %s %s to fixed client-owned copy', async (status, type, failure) => {
    const fetcher = fetcherReturning(problem(status, type, SENSITIVE))

    const result = await cancelPaymentFlow({
      fetcher,
      billingApiUrl: BILLING,
      provider: 'btcpay',
      confirmNoBitcoinSent: true,
    })

    expect(result).toEqual({ cancelled: false, failure, message: PAYMENT_FLOW_CANCELLATION_MESSAGES[failure] })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('cus_')
  })

  // The recognized 409 can surface after a stale cancellable display. Its fixed
  // copy must not assert ongoing reconciliation or promise later cancellation;
  // asserted literally, never against the exported constant itself.
  it('maps the recognized 409 refusal to truthful fixed copy', async () => {
    const fetcher = fetcherReturning(problem(409, 'https://api.silentsuite.io/errors/payment_reconciliation_required', SENSITIVE))

    const result = await cancelPaymentFlow({ fetcher, billingApiUrl: BILLING, provider: 'btcpay', confirmNoBitcoinSent: true })

    expect(result).toEqual({
      cancelled: false,
      failure: 'payment-reconciliation-required',
      message: 'This payment could not be cancelled. Contact support if cancellation remains blocked.',
    })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(requestOf(fetcher).init.body).toBe('{"confirmNoBitcoinSent":true}')
  })

  // Billing's deliberate 409 refusals (payment-flows.ts cancel route) keep the
  // flow; each maps to existing fixed copy rather than the generic fallback.
  it.each([
    ['https://api.silentsuite.io/errors/flow_not_cancellable', 'payment-reconciliation-required', 'This payment could not be cancelled. Contact support if cancellation remains blocked.'],
    ['https://api.silentsuite.io/errors/payment-flow-changed', 'invalid-cancellation-request', 'This payment could not be cancelled. Reload the page and try again.'],
    ['https://api.silentsuite.io/errors/flow-finalization-pending', 'invalid-cancellation-request', 'This payment could not be cancelled. Reload the page and try again.'],
  ] as const)('maps the deliberate 409 %s refusal to existing fixed copy', async (type, failure, message) => {
    const fetcher = fetcherReturning(problem(409, type, SENSITIVE))

    const result = await cancelPaymentFlow({ fetcher, billingApiUrl: BILLING, provider: 'stripe', confirmNoBitcoinSent: false })

    expect(result).toEqual({ cancelled: false, failure, message })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it.each([
    ['flow_not_cancellable', 400], ['payment-flow-changed', 502], ['flow-finalization-pending', 500],
  ] as const)('keeps the generic fallback for %s on a status other than 409', async (slug, status) => {
    const fetcher = fetcherReturning(problem(status, `https://api.silentsuite.io/errors/${slug}`, SENSITIVE))

    expect(await cancelPaymentFlow({ fetcher, billingApiUrl: BILLING, provider: 'stripe', confirmNoBitcoinSent: false }))
      .toEqual({ cancelled: false, failure: 'unavailable', message: PAYMENT_FLOW_CANCELLATION_MESSAGES.unavailable })
  })

  it('accepts bare problem slugs as well as absolute problem type URLs', async () => {
    const fetcher = fetcherReturning(problem(409, 'payment_reconciliation_required', SENSITIVE))

    expect(await cancelPaymentFlow({ fetcher, billingApiUrl: BILLING, provider: 'stripe', confirmNoBitcoinSent: false }))
      .toEqual({
        cancelled: false,
        failure: 'payment-reconciliation-required',
        message: PAYMENT_FLOW_CANCELLATION_MESSAGES['payment-reconciliation-required'],
      })
  })

  it.each([
    ['an unknown problem type', () => problem(400, 'https://api.silentsuite.io/errors/some-new-thing', SENSITIVE)],
    ['a known slug on the wrong status', () => problem(500, 'https://api.silentsuite.io/errors/provider-cancellation-failed', SENSITIVE)],
    ['an untyped failure', () => problem(503, null, SENSITIVE)],
    ['a 200 body that does not confirm cancellation', () => ok({ cancelled: false, detail: SENSITIVE })],
    ['a 200 body with a non-literal cancelled flag', () => ok({ cancelled: 'true', detail: SENSITIVE })],
    ['a 200 body with an unknown not-cancelled reason', () => ok({ cancelled: false, reason: 'something_else' })],
  ] as const)('falls back to one generic message for %s', async (_label, make) => {
    const fetcher = fetcherReturning(make())

    const result = await cancelPaymentFlow({ fetcher, billingApiUrl: BILLING, provider: 'stripe', confirmNoBitcoinSent: false })

    expect(result).toEqual({
      cancelled: false,
      failure: 'unavailable',
      message: PAYMENT_FLOW_CANCELLATION_MESSAGES.unavailable,
    })
  })

  it.each([
    ['an unparseable body', () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') } } as unknown as Response)],
    ['a lost response', () => Promise.reject<Response>(new Error(SENSITIVE))],
  ] as const)('falls back to one generic message for %s', async (_label, make) => {
    const fetcher = vi.fn(() => make())

    const result = await cancelPaymentFlow({
      fetcher,
      billingApiUrl: BILLING,
      provider: 'stripe',
      confirmNoBitcoinSent: false,
    })

    expect(result).toEqual({
      cancelled: false,
      failure: 'unavailable',
      message: PAYMENT_FLOW_CANCELLATION_MESSAGES.unavailable,
    })
  })

  it('exposes the exact neutral bitcoin cancellation warning', () => {
    expect(BITCOIN_CANCELLATION_WARNING).toBe(
      'Only cancel if you have not sent cryptocurrency for this payment. After cancelling, do not pay the previous QR code or address. '
      + 'A payment sent afterward cannot be credited automatically; contact support for manual review.',
    )
  })
})
