import { describe, expect, it, vi } from 'vitest'
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
      'Only cancel if you have not sent Bitcoin. After cancelling, do not pay the previous QR code or address. '
      + 'A payment sent afterward cannot be credited automatically; contact support for manual review.',
    )
  })
})
