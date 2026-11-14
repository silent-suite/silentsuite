import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getAccountFingerprint, logIn, restoreSession, saveSession } from '@silentsuite/core'
import { etebaseLogIn, issueBillingLinkProof } from '../etebase-auth'

vi.mock('@silentsuite/core', () => ({
  restoreSession: vi.fn(),
  logIn: vi.fn(),
  saveSession: vi.fn(),
  getAccountFingerprint: vi.fn(),
}))

describe('etebaseLogIn', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the verified account fingerprint so sign-in can keep that account\'s offline work', async () => {
    const account = { authToken: 'test-token' }
    vi.mocked(logIn).mockResolvedValue(account as never)
    vi.mocked(saveSession).mockResolvedValue('saved-session')
    vi.mocked(getAccountFingerprint).mockReturnValue('account-fingerprint')

    await expect(etebaseLogIn('a@example.com', 'pw')).resolves.toEqual({
      authToken: 'test-token',
      savedSession: 'saved-session',
      accountFingerprint: 'account-fingerprint',
    })
    expect(getAccountFingerprint).toHaveBeenCalledWith(account)
  })

  it('still signs in without a fingerprint when it cannot be read', async () => {
    vi.mocked(logIn).mockResolvedValue({ authToken: 'test-token' } as never)
    vi.mocked(saveSession).mockResolvedValue('saved-session')
    vi.mocked(getAccountFingerprint).mockImplementation(() => { throw new Error('no invitation manager') })

    const result = await etebaseLogIn('a@example.com', 'pw')
    expect(result.savedSession).toBe('saved-session')
    expect(result.accountFingerprint).toBeUndefined()
  })
})

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
