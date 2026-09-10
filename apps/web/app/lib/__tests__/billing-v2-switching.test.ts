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
