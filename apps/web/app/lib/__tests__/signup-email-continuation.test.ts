import { describe, expect, it, vi } from 'vitest'
import { createEmailLinkContinuation } from '../signup-email-continuation'
import type { AnnualOfferResponse, EmailOwnership } from '../billing-v2'

const proof: EmailOwnership = {
  contractVersion: 2, emailOwnershipToken: 'synthetic-proof', expiresAt: '2099-01-01T00:00:00Z',
}
const offer: AnnualOfferResponse = {
  contractVersion: 2, requestId: 'e91a6d70-0d4e-4352-9bdc-426d1f76d771',
  offer: { planId: 'early_annual', customerClass: 'early', billingInterval: 'annual', annualAmountMinor: 3600,
    monthlyEquivalentMinor: 300, currency: 'EUR', providers: ['stripe', 'btcpay'], offerRevision: 1,
    offerToken: 'synthetic-offer', expiresAt: '2099-01-01T00:00:00Z' },
}

describe('mounted email continuation', () => {
  it('joins overlapping calls before consumption resolves', async () => {
    let deliver!: (value: EmailOwnership) => void
    const consume = vi.fn(() => new Promise<EmailOwnership>((resolve) => { deliver = resolve }))
    const load = vi.fn(async () => offer)
    const continuation = createEmailLinkContinuation(consume, load)
    const first = continuation.load()
    const second = continuation.load()
    expect(second).toBe(first)
    expect(consume).toHaveBeenCalledTimes(1)
    expect(load).not.toHaveBeenCalled()
    deliver(proof)
    expect(await first).toEqual({ ownership: proof, offer })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('never automatically replays an ambiguous consumption failure', async () => {
    const consume = vi.fn(async () => { throw new TypeError('Response lost') })
    const load = vi.fn(async () => offer)
    const continuation = createEmailLinkContinuation(consume, load)
    await expect(continuation.load()).rejects.toThrow('Response lost')
    await expect(continuation.load()).rejects.toThrow('Response lost')
    expect(consume).toHaveBeenCalledTimes(1)
    expect(load).not.toHaveBeenCalled()
    expect(continuation.hasProof()).toBe(false)
  })

  it('does not load another offer after the retained proof expires', async () => {
    const consume = vi.fn(async () => ({ ...proof, expiresAt: '2000-01-01T00:00:00Z' }))
    const load = vi.fn(async () => { throw new TypeError('Offer unavailable') })
    const continuation = createEmailLinkContinuation(consume, load)
    await expect(continuation.load()).rejects.toThrow('Offer unavailable')
    await expect(continuation.load()).rejects.toThrow('Request a new link')
    expect(consume).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(1)
  })
})
