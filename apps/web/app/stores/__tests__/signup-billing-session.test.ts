import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '../use-auth-store'

const mocks = vi.hoisted(() => ({
  session: null as string | null,
  signup: vi.fn(async () => ({ savedSession: 'encrypted-session', authToken: 'unused' })),
  login: vi.fn(),
  proof: vi.fn(),
}))
vi.mock('@/app/lib/secure-storage', () => ({
  secureGet: vi.fn(async () => mocks.session),
  secureSet: vi.fn(async (_key: string, value: string) => { mocks.session = value }),
  secureRemove: vi.fn(), secureClear: vi.fn(), migrateFromLocalStorage: vi.fn(),
}))
vi.mock('@/app/lib/etebase-auth', () => ({ etebaseSignUp: mocks.signup, etebaseLogIn: mocks.login, issueBillingLinkProof: mocks.proof }))
vi.mock('@/app/lib/self-hosted', () => ({ isSelfHosted: false, isCustomServer: (url?: string) => !!url && url !== 'https://server.silentsuite.io' }))

const email = 'signup@example.test'
const id = '5fd4d86d-34de-4b82-9a66-9598ddf6e02f'
const capability = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const completed = {
  contractVersion: 2, id, email, provisioningStatus: 'trialing_no_card', emailVerified: true,
  earlyAdopter: true, rememberDevice: false, createdAt: '2026-08-11T00:00:00Z',
  clientSecret: null, cryptoCheckoutUrl: null, cryptoInvoiceId: null, cryptoInvoiceLookupToken: null,
}
const profile = { id, email, provisioningStatus: 'trialing_no_card', isAdmin: false, emailVerified: true, rememberDevice: false }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

beforeEach(() => {
  useAuthStore.setState({ pendingSignup: null, user: null, isAuthenticated: false, isLoading: false, error: null, subscriptionStatus: null })
  localStorage.clear(); sessionStorage.clear()
  mocks.session = null
  mocks.signup.mockClear(); mocks.login.mockReset(); mocks.proof.mockReset()
  let sequence = 0
  mocks.proof.mockImplementation(async () => `fresh-proof-${++sequence}`)
  vi.stubGlobal('fetch', vi.fn())
})

describe('signup Billing session boundary', () => {
  it.each([undefined, false, true])('sends explicit no-card and paid opt-in for %s', async (consent) => {
    useAuthStore.getState().prepareSignupDraft(email, consent)
    await useAuthStore.getState().createEtebaseAccount(email, 'test-password')
    vi.mocked(fetch).mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname
      return json(path === '/auth/provision/v2' ? completed : profile)
    })
    await useAuthStore.getState().provisionAnnualNoCard(capability)
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).wantsProductUpdates).toBe(consent === true)
    useAuthStore.setState({ pendingSignup: { email, wantsProductUpdates: consent } })
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body.wantsProductUpdates).toBe(consent === true)
      return json({ contractVersion: 2, kind: 'stripe', clientSecret: 'pi_secret', paymentSessionToken: body.recoverySecret })
    })
    await useAuthStore.getState().startAnnualSignupPayment(capability, 'stripe', window.location.origin + '/signup')
  })

  it('shares duplicate create/provision clicks rather than superseding an identical signup', async () => {
    useAuthStore.getState().prepareSignupDraft(email)
    await import('@/app/lib/etebase-auth')
    const creation = await Promise.allSettled([useAuthStore.getState().createEtebaseAccount(email, 'test-password'), useAuthStore.getState().createEtebaseAccount(email, 'test-password')])
    expect(mocks.signup).toHaveBeenCalledTimes(1)
    expect(creation.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
    vi.mocked(fetch).mockImplementation(async (url) => json(String(url).endsWith('/auth/provision/v2') ? completed : profile))
    await Promise.all([useAuthStore.getState().provisionAnnualNoCard(capability), useAuthStore.getState().provisionAnnualNoCard(capability)])
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('retains paid completion and the exact recovery capability while duplicate retries establish only a session', async () => {
    useAuthStore.setState({ pendingSignup: { email, billingContractVersion: 2, paymentSessionToken: capability, paymentSessionRequestKey: 'request-lineage' } })
    await useAuthStore.getState().createEtebaseAccount(email, 'test-password')
    const paths: string[] = []
    let fail = true
    vi.mocked(fetch).mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname
      paths.push(path)
      if (path === '/auth/signup/finalize-payment/v2') return json({ ...completed, provisioningStatus: 'active', planId: 'early_annual', isAdmin: false })
      return fail ? json({}, 503) : json({ ...profile, provisioningStatus: 'active' })
    })
    await expect(useAuthStore.getState().finalizePaidSignup()).rejects.toThrow(/session/i)
    expect(useAuthStore.getState().pendingSignup).toMatchObject({ paymentSessionToken: capability, paymentSessionRequestKey: 'request-lineage', provisionedUser: { id } })
    fail = false
    await useAuthStore.getState().createEtebaseAccount(email, 'test-password')
    await Promise.all([useAuthStore.getState().finalizePaidSignup(), useAuthStore.getState().finalizePaidSignup()])
    expect(paths).toEqual(['/auth/signup/finalize-payment/v2', '/auth/token-exchange', '/auth/token-exchange', '/auth/session'])
    expect(mocks.signup).toHaveBeenCalledTimes(1)
    useAuthStore.getState().completeSignup()
    expect(useAuthStore.getState().user?.id).toBe(id)
  })

  it('does not publish a session into a replacement signup', async () => {
    useAuthStore.getState().prepareSignupDraft(email)
    await useAuthStore.getState().createEtebaseAccount(email, 'test-password')
    let resolveSession!: (response: Response) => void
    vi.mocked(fetch).mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname
      if (path === '/auth/provision/v2') return json(completed)
      if (path === '/auth/token-exchange') return json(profile)
      return new Promise<Response>((resolve) => { resolveSession = resolve })
    })
    const operation = useAuthStore.getState().provisionAnnualNoCard(capability)
    await vi.waitFor(() => expect(resolveSession).toBeDefined())
    useAuthStore.getState().prepareSignupDraft('replacement@example.test')
    resolveSession(json(profile))
    await expect(operation).rejects.toThrow('superseded')
    expect(useAuthStore.getState().pendingSignup?.email).toBe('replacement@example.test')
    expect(useAuthStore.getState().pendingSignup?.billingSessionUserId).toBeUndefined()
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
  })

  it('invalidates a prior session attestation before a failed session-only retry', async () => {
    useAuthStore.getState().prepareSignupDraft(email)
    await useAuthStore.getState().createEtebaseAccount(email, 'test-password')
    vi.mocked(fetch).mockImplementation(async (url) => json(String(url).endsWith('/auth/provision/v2') ? completed : profile))
    await useAuthStore.getState().provisionAnnualNoCard(capability)
    vi.mocked(fetch).mockResolvedValue(json({}, 503))
    await expect(useAuthStore.getState().provisionAnnualNoCard(capability)).rejects.toThrow(/session/i)
    expect(() => useAuthStore.getState().completeSignup()).toThrow(/session/i)
  })

  it.each(['exchange-id', 'exchange-email', 'session-id', 'session-email', 'session-401', 'session-network'])('rejects %s without losing completed identity', async (failure) => {
    useAuthStore.getState().prepareSignupDraft(email)
    await useAuthStore.getState().createEtebaseAccount(email, 'test-password')
    vi.mocked(fetch).mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname
      if (path === '/auth/provision/v2') return json(completed)
      if (path === '/auth/token-exchange') return json({ ...profile, ...(failure === 'exchange-id' ? { id: 'other' } : failure === 'exchange-email' ? { email: 'other@example.test' } : {}) })
      if (failure === 'session-network') throw new TypeError('Failed to fetch')
      return json({ ...profile, ...(failure === 'session-id' ? { id: 'other' } : failure === 'session-email' ? { email: 'other@example.test' } : {}) }, failure === 'session-401' ? 401 : 200)
    })
    await expect(useAuthStore.getState().provisionAnnualNoCard(capability)).rejects.toThrow(/session/i)
    expect(useAuthStore.getState().pendingSignup?.provisionedUser?.id).toBe(id)
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(() => useAuthStore.getState().completeSignup()).toThrow(/session/i)
  })

  it('retains completed no-card provisioning on exchange failure and retries only the session with a fresh proof', async () => {
    useAuthStore.getState().prepareSignupDraft(email, false, false)
    await useAuthStore.getState().createEtebaseAccount(email, 'test-password')
    const calls: string[] = []
    let exchangeFails = true
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname
      calls.push(path)
      expect(init?.credentials).toBe('include')
      if (path === '/auth/provision/v2') return json(completed)
      if (path === '/auth/token-exchange') return exchangeFails ? json({}, 503) : json(profile)
      if (path === '/auth/session') return json({ id, email, emailVerified: true })
      throw new Error('Unexpected endpoint')
    })
    await expect(useAuthStore.getState().provisionAnnualNoCard(capability)).rejects.toThrow(/session/i)
    expect(useAuthStore.getState().pendingSignup?.provisionedUser?.id).toBe(id)
    expect(useAuthStore.getState().isLoading).toBe(false)
    expect(() => useAuthStore.getState().completeSignup()).toThrow(/session/i)
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(sessionStorage.getItem('silentsuite-signup-in-progress')).toBe('true')
    exchangeFails = false
    // The real page invokes account creation again before retrying provisioning.
    await useAuthStore.getState().createEtebaseAccount(email, 'test-password')
    await useAuthStore.getState().provisionAnnualNoCard(capability)
    expect(mocks.signup).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['/auth/provision/v2', '/auth/token-exchange', '/auth/token-exchange', '/auth/session'])
    expect(mocks.proof).toHaveBeenCalledTimes(3)
    const exchangeBodies = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/auth/token-exchange')).map(([, init]) => JSON.parse(String(init?.body)))
    expect(exchangeBodies).toEqual([{ etebaseLinkProof: 'fresh-proof-2', rememberDevice: false }, { etebaseLinkProof: 'fresh-proof-3', rememberDevice: false }])
    useAuthStore.getState().completeSignup()
    expect(useAuthStore.getState().user?.id).toBe(id)
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
  })
})
