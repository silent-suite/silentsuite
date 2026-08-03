import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { restoreSession } from '@silentsuite/core'
import { issueBillingLinkProof } from '../etebase-auth'

vi.mock('@silentsuite/core', () => ({ restoreSession: vi.fn() }))

function proofResponse(proof = 'p'.repeat(43)) {
  return new Response(JSON.stringify({ etebaseLinkProof: proof }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('issueBillingLinkProof retry boundary', () => {
  beforeEach(() => {
    vi.mocked(restoreSession).mockResolvedValue({ authToken: 'test-token' } as never)
    vi.stubGlobal('fetch', vi.fn())
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      callback()
      return 0
    }) as typeof setTimeout)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('retries once when the issuance response is lost', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError('network response lost'))
      .mockResolvedValueOnce(proofResponse())

    await expect(issueBillingLinkProof('saved-session')).resolves.toBe('p'.repeat(43))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('honors Retry-After and retries once after issuance throttling', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(proofResponse('r'.repeat(43)))

    await expect(issueBillingLinkProof('saved-session')).resolves.toBe('r'.repeat(43))
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 1_000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
