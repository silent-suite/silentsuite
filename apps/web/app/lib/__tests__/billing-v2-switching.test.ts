import { describe, expect, it, vi } from 'vitest'
import { cancelAnonymousPaymentSessionRecovery, getAnonymousPaymentSessionRecovery, reconcileAnonymousPaymentSessionRecovery } from '../billing-v2'

const requestKey = 'e91a6d70-0d4e-4352-9bdc-426d1f76d771'
const token = 'r'.repeat(43)
const release = { contractVersion: 2, state: 'released', flow: { provider: 'btcpay', status: 'reconciliation_required' }, release: { requestKey, provider: 'btcpay', providerObjectId: 'invoice_exact' } }
const params = (body: unknown) => ({ fetcher: vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })), billingApiUrl: 'https://billing.example.test', email: 'new@example.test', requestKey, recoverySecret: token, paymentSessionToken: token })
describe('anonymous switching wire contract', () => {
  it('serializes literal Bitcoin acknowledgement and validates exact release identity', async () => {
    const p = params(release)
    expect(await cancelAnonymousPaymentSessionRecovery({ ...p, confirmNoBitcoinSent: true })).toEqual(release)
    expect(JSON.parse(String(p.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ confirmNoBitcoinSent: true, requestKey, recoverySecret: token })
  })
  it.each([
    { ...release, release: undefined },
    { ...release, state: 'closed' },
    { ...release, release: { ...release.release, requestKey: 'e91a6d70-0d4e-4352-9bdc-426d1f76d772' } },
    { ...release, release: { ...release.release, provider: 'stripe' } },
  ])('rejects unbound or ambiguous release %#', async body => {
    await expect(cancelAnonymousPaymentSessionRecovery(params(body))).rejects.toThrow()
  })
  it('does not treat generic closed as release', async () => {
    expect(await getAnonymousPaymentSessionRecovery(params({ contractVersion: 2, state: 'closed', flow: null }))).toEqual({ contractVersion: 2, state: 'closed', flow: null })
  })
  // T6.2: a never-dispatched signup that Billing closed at the 8-hour deadline
  // answers `reconcile` with the release receipt itself. There is no provider
  // object, so `providerObjectId` is null, and there is no continuation.
  const undispatchedRelease = (provider: 'stripe' | 'btcpay') => ({ contractVersion: 2, state: 'released', flow: { provider, status: 'reconciliation_required' }, release: { requestKey, provider, providerObjectId: null } })
  describe('released reconcile of a never-dispatched signup (T6.2 wire bytes)', () => {
    it.each(['stripe', 'btcpay'] as const)('accepts the exact %s release receipt without a continuation and without a provider object', async provider => {
      const body = undispatchedRelease(provider)
      const p = params(body)
      const result = await reconcileAnonymousPaymentSessionRecovery(p)
      expect(result).toEqual(body)
      expect(result).toStrictEqual(JSON.parse(JSON.stringify(body)))
      expect(result.state).toBe('released')
      expect(result.continuation).toBeUndefined()
      expect(result.release?.providerObjectId).toBeNull()
      expect(Object.keys(result).sort()).toEqual(['contractVersion', 'flow', 'release', 'state'])
      expect(p.fetcher).toHaveBeenCalledTimes(1)
      expect(String(p.fetcher.mock.calls[0]?.[0])).toBe('https://billing.example.test/auth/signup/payment-session/v2/reconcile')
      // A reconcile never carries the Bitcoin acknowledgement; cancellation is a separate decision.
      expect(JSON.parse(String(p.fetcher.mock.calls[0]?.[1]?.body))).toEqual({ contractVersion: 2, email: 'new@example.test', requestKey, recoverySecret: token, switchingProfile: 'v1' })
    })

    const released = undispatchedRelease('stripe')
    const disclosure = { kind: 'charge_now', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: 3600, monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: null, firstChargeAt: null, cancelBy: null, cancelByInclusive: false, autoRenew: true, prepaid: false, refundWindowDays: 30, bonusDays: 0, periodEndRule: 'confirmation_plus_1_utc_calendar_year', renewalAt: null, entitlementEndsAt: null }
    const { state: _droppedState, ...missingState } = released
    const { providerObjectId: _droppedObjectId, ...releaseWithoutObjectId } = released.release
    const malformed: [string, unknown][] = [
      ['missing state', missingState],
      ['unknown state "cancelled"', { ...released, state: 'cancelled' }],
      ['unknown state "abandoned"', { ...released, state: 'abandoned' }],
      ['unknown state "expired"', { ...released, state: 'expired' }],
      ['non-string state', { ...released, state: 2 }],
      ['released carrying a payable continuation', { ...released, continuation: { requestKey, provider: 'stripe', providerObjectId: 'pi_exact', clientSecret: 'pi_exact_secret', disclosure } }],
      ['released carrying a continuation without its payable control', { ...released, continuation: { requestKey, provider: 'stripe', providerObjectId: 'pi_exact', disclosure } }],
      ['released with an empty provider object id', { ...released, release: { ...released.release, providerObjectId: '' } }],
      ['released with a non-string provider object id', { ...released, release: { ...released.release, providerObjectId: 42 } }],
      ['released with an object as provider object id', { ...released, release: { ...released.release, providerObjectId: { id: 'pi_exact' } } }],
      ['released without the provider object id field', { ...released, release: releaseWithoutObjectId }],
      ['released with an extra release field', { ...released, release: { ...released.release, expiresAt: '2026-10-18T00:00:00Z' } }],
      ['released without a release receipt', { contractVersion: 2, state: 'released', flow: released.flow }],
      ['released with a null release receipt', { ...released, release: null }],
      ['released with a null flow', { ...released, flow: null }],
      ['released whose receipt provider differs from the flow provider', { ...released, release: { ...released.release, provider: 'btcpay' } }],
      ['released with an unknown provider', { ...released, flow: { provider: 'paypal', status: 'reconciliation_required' }, release: { ...released.release, provider: 'paypal' } }],
      ['released for another request key', { ...released, release: { ...released.release, requestKey: 'e91a6d70-0d4e-4352-9bdc-426d1f76d772' } }],
      ['released with a client-side expiry hint', { ...released, expiresAt: '2026-10-18T00:00:00Z' }],
      ['released with a non-uuid request key', { ...released, release: { ...released.release, requestKey: 'not-a-uuid' } }],
      ['wrong contract version', { ...released, contractVersion: 1 }],
      ['array body', [released]],
      ['string body', 'released'],
      ['null body', null],
    ]
    it.each(malformed)('rejects a malformed release: %s', async (_label, body) => {
      const p = params(body)
      await expect(reconcileAnonymousPaymentSessionRecovery(p)).rejects.toThrow()
      // Conservative: exactly one reconcile read, no second request and nothing invented.
      expect(p.fetcher).toHaveBeenCalledTimes(1)
      expect(String(p.fetcher.mock.calls[0]?.[0])).toMatch(/\/auth\/signup\/payment-session\/v2\/reconcile$/)
    })

    it.each([
      ['non-JSON body', () => new Response('<!doctype html><title>release</title>', { status: 200, headers: { 'content-type': 'text/html' } })],
      ['empty body', () => new Response('', { status: 200 })],
      ['truncated JSON', () => new Response('{"contractVersion":2,"state":"released"', { status: 200 })],
      ['release receipt behind a 500', () => new Response(JSON.stringify(released), { status: 500 })],
      ['release receipt behind a 202', () => new Response(JSON.stringify(released), { status: 202 })],
      ['release receipt behind a 404', () => new Response(JSON.stringify(released), { status: 404 })],
    ] as const)('rejects a %s instead of inventing a release', async (_label, respond) => {
      const fetcher = vi.fn(async () => respond())
      await expect(reconcileAnonymousPaymentSessionRecovery({ ...params(released), fetcher })).rejects.toThrow()
      expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['network failure', () => { throw new TypeError('Failed to fetch') }],
      ['aborted request', () => { throw new DOMException('The operation was aborted.', 'AbortError') }],
    ] as const)('propagates a transport %s without a retry or a fabricated state', async (_label, fail) => {
      const fetcher = vi.fn(async () => fail())
      await expect(reconcileAnonymousPaymentSessionRecovery({ ...params(released), fetcher })).rejects.toThrow()
      expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it('does not treat a generic closed reconcile as a release', async () => {
      const closed = { contractVersion: 2, state: 'closed', flow: null }
      const result = await reconcileAnonymousPaymentSessionRecovery(params(closed))
      expect(result).toEqual(closed)
      expect(result.state).not.toBe('released')
      expect(result.release).toBeUndefined()
      expect(result.continuation).toBeUndefined()
    })
  })

  it('opts into the switching profile with a literal on every recovery operation and still accepts a pre-switching Billing reply', async () => {
    // A Billing release that predates the profile strips the unknown literal and
    // answers with the exact legacy shape (web-first rollout / backend rollback).
    const legacy = { contractVersion: 2, state: 'closed', flow: { provider: 'btcpay', status: 'reconciliation_required' } }
    for (const [operation, call] of [['current', getAnonymousPaymentSessionRecovery], ['reconcile', reconcileAnonymousPaymentSessionRecovery], ['cancel', cancelAnonymousPaymentSessionRecovery]] as const) {
      const p = params(legacy)
      const result = await call({ ...p, ...(operation === 'cancel' ? { confirmNoBitcoinSent: true } : {}) })
      expect(result).toEqual(legacy)
      expect(result.state).not.toBe('released')
      expect(JSON.parse(String(p.fetcher.mock.calls[0]?.[1]?.body))).toEqual({ contractVersion: 2, email: 'new@example.test', requestKey, recoverySecret: token, switchingProfile: 'v1', ...(operation === 'cancel' ? { confirmNoBitcoinSent: true } : {}) })
    }
  })
})
