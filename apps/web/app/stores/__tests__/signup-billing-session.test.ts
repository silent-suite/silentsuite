import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '../use-auth-store'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { createElement } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import SignupPage from '../../(auth)/signup/page'
import { checkoutIntentToken, emailOwnershipToken } from '@/src/__tests__/fixtures/annual-authority'

vi.hoisted(() => { process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED = 'true' })

vi.mock('@/app/lib/config', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/app/lib/config')>(),
  BILLING_API_URL: 'https://billing.test',
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => createElement('a', { href }, children) }))

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
  window.history.replaceState({}, '', '/signup')
  vi.stubGlobal('scrollTo', vi.fn())
  mocks.session = null
  mocks.signup.mockClear(); mocks.login.mockReset().mockResolvedValue({ savedSession: 'encrypted-session', authToken: 'unused' }); mocks.proof.mockReset()
  let sequence = 0
  mocks.proof.mockImplementation(async () => `fresh-proof-${++sequence}`)
  vi.stubGlobal('fetch', vi.fn())
})

describe('signup Billing session boundary', () => {
  it('keeps a visible memory-only warning through real finalization and failed session exchange, then clears it only after a durable receipt write', async () => {
    const key = 'silentsuite-signup-redirect-state'
    mocks.session = 'encrypted-session'
    useAuthStore.setState({ pendingSignup: { email, paymentSessionToken: capability, paymentSessionRequestKey: id, billingContractVersion: 2 } })
    useAuthStore.getState().saveSignupStateForRedirect('annual')
    const issued = JSON.parse(sessionStorage.getItem(key)!).savedAt
    window.history.replaceState({}, '', '/signup?recovery=payment')
    vi.mocked(fetch).mockResolvedValue(json({ contractVersion: 2, state: 'closed', flow: null }))
    render(createElement(SignupPage))
    await screen.findByRole('heading', { name: 'Payment release not confirmed' })

    const originalWrite = Storage.prototype.setItem
    let failReceiptWrite = false
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (failReceiptWrite && key === 'silentsuite-signup-redirect-state') throw new Error('quota')
      return originalWrite.call(this, key, value)
    })
    const paths: string[] = []
    let exchangeStartedWithVisibleWarning = false
    let failExchange!: () => void
    const exchange = new Promise<Response>((resolve) => { failExchange = () => resolve(json({}, 503)) })
    vi.mocked(fetch).mockImplementation(async (url) => {
      const pathname = new URL(String(url)).pathname
      if (pathname.endsWith('/payment-session/v2/current')) return json({ contractVersion: 2, state: 'closed', flow: null })
      paths.push(pathname)
      if (pathname.endsWith('/finalize-payment/v2')) {
        failReceiptWrite = true
        return json({ ...completed, provisioningStatus: 'active', planId: 'early_annual', isAdmin: false })
      }
      expect(useAuthStore.getState().signupRecoveryDurability).toBe('memory-only')
      expect(screen.getByText(/Stay in this tab/)).toBeVisible()
      expect(useAuthStore.getState().pendingSignup?.provisionedUser?.id).toBe(id)
      expect(sessionStorage.getItem(key)).toBeNull()
      exchangeStartedWithVisibleWarning = true
      return exchange
    })
    try {
      const finalization = useAuthStore.getState().finalizePaidSignup().catch((error) => error as Error)
      const warning = await screen.findByText(/Stay in this tab/)
      expect(warning).toBeVisible()
      expect(warning).toHaveTextContent(/Refreshing, closing, or leaving this tab can lose this continuation/)
      expect(warning).toHaveTextContent(/do not start another signup or payment/)
      await screen.findByRole('heading', { name: 'Finish signing in' })
      expect(screen.queryByRole('link', { name: 'Back to signup' })).not.toBeInTheDocument()
      await act(async () => { failExchange(); expect(await finalization).toBeInstanceOf(Error) })
      expect(warning).toBeVisible()
      expect(exchangeStartedWithVisibleWarning).toBe(true)
      expect(paths).toEqual(['/auth/signup/finalize-payment/v2', '/auth/token-exchange'])
      expect(mocks.signup).not.toHaveBeenCalled()
      expect(useAuthStore.getState().pendingSignup?.billingSessionUserId).toBeUndefined()
      act(() => useAuthStore.getState().clearError())
      expect(warning).toBeVisible()

      // The original receipt's lifetime and identity survive a successful retry.
      failReceiptWrite = false
      act(() => useAuthStore.getState().saveSignupStateForRedirect('annual'))
      expect(useAuthStore.getState().signupRecoveryDurability).toBe('persisted')
      expect(screen.queryByText(/Stay in this tab/)).not.toBeInTheDocument()
      expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({ savedAt: issued, pendingSignup: {
        email, paymentSessionToken: capability, paymentSessionRequestKey: id, billingContractVersion: 2, provisionedUser: { id },
      } })
      expect(sessionStorage.getItem(key)).not.toMatch(/billingSessionUserId|encrypted-session|signupRecoveryDurability/)
      expect(useAuthStore.getState().pendingSignup?.billingSessionUserId).toBeUndefined()
      expect(() => useAuthStore.getState().completeSignup()).toThrow(/session/i)
      expect(useAuthStore.getState().signupRecoveryDurability).toBe('persisted')
    } finally { write.mockRestore() }
  })

  it('wires encrypted creation, failed proof, release and fresh consent without exposing replacement credentials', async () => {
    const requestId = 'e91a6d70-0d4e-4352-9bdc-426d1f76d771'
    const disclosure = {
      kind: 'no_auto_charge', annualAmountMinor: 3600, firstChargeAmountMinor: 0, renewalAmountMinor: null,
      monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: '2099-01-08T00:00:00Z', firstChargeAt: null,
      cancelBy: null, cancelByInclusive: false, autoRenew: false, prepaid: false, refundWindowDays: null,
      bonusDays: 0, periodEndRule: 'activation_plus_trial', renewalAt: null, entitlementEndsAt: '2099-01-08T00:00:00Z',
    }
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({ [requestId]: {
      email, requestId, wantsProductUpdates: false, rememberDevice: false, returnTo: null, expiresAt: Date.now() + 60_000,
    } }))
    window.history.replaceState({}, '', `/signup?token=fixture&request_id=${requestId}`)
    let provisions = 0
    mocks.proof.mockRejectedValueOnce(new Error('Identity proof unavailable'))
    vi.mocked(fetch).mockImplementation(async (url) => {
      const pathname = new URL(String(url)).pathname
      if (pathname.endsWith('/consume')) return json({ contractVersion: 2, emailOwnershipToken, expiresAt: '2099-01-01T00:00:00Z' })
      if (pathname.endsWith('/activate')) return json({ contractVersion: 2, checkoutIntentToken, expiresAt: '2099-01-01T00:00:00Z', disclosure })
      if (pathname.endsWith('/cancel')) return json({ contractVersion: 2, requestId, checkoutIntentJti: 'a2c4f872-01b7-4176-8325-522486b20cae', state: 'released' })
      if (pathname.endsWith('/offers/v2')) return json({ contractVersion: 2, requestId, offer: {
        planId: 'early_annual', customerClass: 'early', billingInterval: 'annual', annualAmountMinor: 3600,
        monthlyEquivalentMinor: 300, currency: 'EUR', providers: ['stripe', 'btcpay'], offerRevision: 1,
        offerToken: 'fixture-offer', expiresAt: '2099-01-01T00:00:00Z',
      } })
      if (pathname === '/auth/provision/v2') { provisions++; return json(completed, 201) }
      return json(profile)
    })
    render(createElement(SignupPage))
    const passwordInput = await screen.findByLabelText(/^password$/i)
    expect(vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/auth/signup-email-verifications/v2/consume', '/auth/offers/v2',
    ])
    expect(useAuthStore.getState().pendingSignup?.email).toBe(email)
    expect(mocks.signup).not.toHaveBeenCalled()
    expect(mocks.proof).not.toHaveBeenCalled()
    fireEvent.change(passwordInput, { target: { value: 'OriginalPass1' } })
    const continueToOptions = screen.getByRole('button', { name: /continue to trial options/i })
    // react-hook-form's async resolver must publish validity before a real click.
    await waitFor(() => expect(continueToOptions).toBeEnabled())
    fireEvent.click(continueToOptions)
    const choose = async () => {
      fireEvent.click(await screen.findByRole('button', { name: /7 day free trial/i }))
      fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
      // No review screen: the password-loss acknowledgement gates the only creation step.
      const action = await screen.findByRole('button', { name: /continue to your workspace/i })
      expect(action).toBeDisabled()
      fireEvent.click(screen.getByRole('checkbox', { name: /cannot recover my password/i }))
      fireEvent.click(action)
    }
    await choose()
    expect(await screen.findByRole('alert')).toHaveTextContent('Identity proof unavailable')
    expect(useAuthStore.getState().pendingSignup?.etebaseAccountReady).toBe(true)
    expect(provisions).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    await screen.findByRole('heading', { name: /choose your plan/i })
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument()
    expect(screen.getByText(/original password remains unchanged/i)).toBeVisible()
    await choose()
    await waitFor(() => expect(useAuthStore.getState().pendingSignup?.billingSessionUserId).toBe(id))
    expect(mocks.signup).toHaveBeenCalledTimes(1)
    expect(mocks.login).toHaveBeenCalledWith(email, 'OriginalPass1', undefined)
    expect(provisions).toBe(1)
  })


  // Opt-in because the public checkout does not include the private Billing app.
  // Run with BILLING_CONTRACT_ROOT=<installed billing app> to exercise its actual routes.
  it.skipIf(!process.env.BILLING_CONTRACT_ROOT).each([
    ['none', '2026-09-09T12:00:00.000Z'], ['none', '2026-09-09T12:00:00.123Z'],
    ['stripe', '2026-09-09T12:00:00.000Z'], ['stripe', '2026-09-09T12:00:00.123Z'],
  ])('admits actual Fastify %s Date serialization %s through the store and protected session', async (provider, createdAt) => {
    useAuthStore.getState().prepareSignupDraft(email)
    await useAuthStore.getState().createEtebaseAccount(email, 'test-password')
    const paid = provider === 'stripe'
    if (paid) useAuthStore.setState({ pendingSignup: { ...useAuthStore.getState().pendingSignup!, billingContractVersion: 2, paymentSessionToken: capability } })
    mocks.proof.mockResolvedValue(capability)
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const pathname = new URL(String(url)).pathname
      if (pathname === '/auth/provision/v2' || pathname === '/auth/signup/finalize-payment/v2') {
        const wire = JSON.parse(execFileSync(process.execPath, [path.resolve('scripts/test-billing-serializer.cjs'), process.env.BILLING_CONTRACT_ROOT!], {
          encoding: 'utf8', input: JSON.stringify({ url: pathname, payload: JSON.parse(String(init?.body)), createdAt,
            completed: { ...completed, ...(paid ? { provisioningStatus: 'active', planId: 'early_annual', isAdmin: false } : {}) } }),
        }))
        expect(wire.status).toBe(201)
        expect(JSON.parse(wire.body).createdAt).toBe(createdAt)
        return new Response(wire.body, { status: wire.status })
      }
      return json({ ...profile, ...(paid ? { provisioningStatus: 'active' } : {}) })
    })
    await (paid ? useAuthStore.getState().finalizePaidSignup() : useAuthStore.getState().provisionAnnualNoCard(capability))
    expect(useAuthStore.getState().pendingSignup?.billingSessionUserId).toBe(id)
    expect(vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname)).toContain('/auth/session')
  })


  it.each(['none', 'stripe'] as const)('accepts serialized fractional createdAt on %s completion', async (provider) => {
    useAuthStore.getState().prepareSignupDraft(email)
    await useAuthStore.getState().createEtebaseAccount(email, 'test-password')
    if (provider === 'stripe') useAuthStore.setState({ pendingSignup: { ...useAuthStore.getState().pendingSignup!, billingContractVersion: 2, paymentSessionToken: capability } })
    vi.mocked(fetch).mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname
      const paid = provider === 'stripe'
      if (path === '/auth/provision/v2' || path === '/auth/signup/finalize-payment/v2') return json({ ...completed, createdAt: new Date('2026-09-09T12:00:00.123Z').toISOString(), ...(paid ? { provisioningStatus: 'active', planId: 'early_annual', isAdmin: false } : {}) }, 201)
      return json({ ...profile, ...(paid ? { provisioningStatus: 'active' } : {}) })
    })
    await (provider === 'none' ? useAuthStore.getState().provisionAnnualNoCard(capability) : useAuthStore.getState().finalizePaidSignup())
    expect(useAuthStore.getState().pendingSignup?.billingSessionUserId).toBe(id)
  })

  it.each(['2026-02-30T00:00:00Z', '2026-09-09T24:00:00Z', '2026-09-09T00:00:00+00:00', '2026-09-09T00:00:00.12Z'])('rejects noncanonical or impossible createdAt %s', async (createdAt) => {
    useAuthStore.getState().prepareSignupDraft(email)
    await useAuthStore.getState().createEtebaseAccount(email, 'test-password')
    vi.mocked(fetch).mockResolvedValue(json({ ...completed, createdAt }, 201))
    await expect(useAuthStore.getState().provisionAnnualNoCard(capability)).rejects.toThrow('Billing did not confirm')
    expect(useAuthStore.getState().pendingSignup?.provisionedUser).toBeUndefined()
  })

  it('reuses the exact retained encrypted account before Billing completes', async () => {
    useAuthStore.getState().prepareSignupDraft(email)
    await useAuthStore.getState().createEtebaseAccount(email, 'test-password')
    await useAuthStore.getState().createEtebaseAccount(email, 'test-password')
    expect(mocks.signup).toHaveBeenCalledTimes(1)
  })

  it.each(['session', 'email', 'server'] as const)('does not reuse a retained account with a different %s binding', async (change) => {
    useAuthStore.getState().prepareSignupDraft(email)
    await useAuthStore.getState().createEtebaseAccount(email, 'test-password')
    if (change === 'session') mocks.session = 'unrelated-session'
    const retry = useAuthStore.getState().createEtebaseAccount(change === 'email' ? 'other@example.test' : email, 'test-password', change === 'server' ? 'https://other.test' : undefined)
    if (change === 'session') {
      await retry
      expect(mocks.login).toHaveBeenCalledWith(email, 'test-password', undefined)
    } else await expect(retry).rejects.toThrow('already set up')
    expect(mocks.signup).toHaveBeenCalledTimes(1)
  })

  it('never changes identity for a completed Billing receipt', async () => {
    useAuthStore.setState({ pendingSignup: { email, provisionedUser: { id, planId: null, isAdmin: false } } })
    await expect(useAuthStore.getState().createEtebaseAccount('other@example.test', 'test-password')).rejects.toThrow('already set up')
    expect(mocks.signup).not.toHaveBeenCalled()
    expect(mocks.login).not.toHaveBeenCalled()
    expect(useAuthStore.getState().pendingSignup?.provisionedUser?.id).toBe(id)
  })

  it('uses login, never signup, when a Billing receipt outlives the encrypted session', async () => {
    useAuthStore.setState({ pendingSignup: { email, provisionedUser: { id, planId: null, isAdmin: false } } })
    mocks.login.mockResolvedValue({ savedSession: 'recovered', authToken: 'unused' })
    await useAuthStore.getState().createEtebaseAccount(email, 'test-password')
    expect(mocks.signup).not.toHaveBeenCalled()
    expect(mocks.login).toHaveBeenCalledTimes(1)
  })

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
    await useAuthStore.getState().startAnnualSignupPayment(capability, 'stripe', window.location.origin + '/signup', 'annual')
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


it('checkpoints actual paid finalization before failed exchange and only recovers session after document reset', async () => {
  const key = 'silentsuite-signup-redirect-state'
  mocks.session = 'encrypted-session'
  useAuthStore.setState({ pendingSignup: { email, paymentSessionToken: capability, paymentSessionRequestKey: id, billingContractVersion: 2 } })
  useAuthStore.getState().saveSignupStateForRedirect('annual')
  const issued = JSON.parse(sessionStorage.getItem(key)!).savedAt
  const paths: string[] = []
  vi.mocked(fetch).mockImplementation(async (url) => {
    const pathname = new URL(String(url)).pathname
    paths.push(pathname)
    if (pathname.endsWith('/finalize-payment/v2')) return json({ ...completed, provisioningStatus: 'active', planId: 'early_annual', isAdmin: false })
    // The receipt must already be durable before this later fallible exchange.
    expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({ savedAt: issued, pendingSignup: { provisionedUser: { id }, provisionedSubscriptionStatus: 'active' } })
    return json({}, 503)
  })
  await expect(useAuthStore.getState().finalizePaidSignup()).rejects.toThrow(/session/i)
  useAuthStore.setState({ pendingSignup: null })
  expect(useAuthStore.getState().restoreSignupStateFromRedirect({ retainForRecovery: true })?.pendingSignup.provisionedUser?.id).toBe(id)
  expect(useAuthStore.getState().pendingSignup).not.toHaveProperty('billingSessionUserId')
  vi.mocked(fetch).mockImplementation(async (url) => { paths.push(new URL(String(url)).pathname); return json({ ...profile, provisioningStatus: 'active' }) })
  await useAuthStore.getState().recoverCompletedSignupSession()
  useAuthStore.getState().completeSignup()
  expect(paths.filter((p) => p.endsWith('/finalize-payment/v2'))).toHaveLength(1)
  expect(paths.every((p) => ['/auth/signup/finalize-payment/v2', '/auth/token-exchange', '/auth/session'].includes(p))).toBe(true)
  expect(mocks.signup).not.toHaveBeenCalled()
  expect(sessionStorage.getItem(key)).toBeNull()
})

// Fresh rendered signup: no redirect checkpoint or legacy crypto token is seeded.
it.each(['lost response', 'inline Bitcoin', 'storage failure'] as const)('retains the first payment across document loss: %s', async (scenario) => {
  const requestId = 'e91a6d70-0d4e-4352-9bdc-426d1f76d771'
  const key = 'silentsuite-signup-redirect-state'
  localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({ [requestId]: {
    email, requestId, wantsProductUpdates: false, rememberDevice: false, returnTo: null, expiresAt: Date.now() + 60_000,
  } }))
  window.history.replaceState({}, '', `/signup?token=fixture&request_id=${requestId}`)
  let started: Record<string, unknown> | undefined
  let beforeDispatch: string | null = null
  let warningBeforeDispatch = false
  let confirmed = false
  const disclosure = {
    kind: 'prepaid', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: null,
    monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: null, firstChargeAt: null,
    cancelBy: null, cancelByInclusive: false, autoRenew: false, prepaid: true, refundWindowDays: 30,
    bonusDays: 0, periodEndRule: 'confirmation_plus_1_utc_calendar_year', renewalAt: null, entitlementEndsAt: null,
  }
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const pathname = new URL(String(url)).pathname
    if (pathname.endsWith('/consume')) return json({ contractVersion: 2, emailOwnershipToken, expiresAt: '2099-01-01T00:00:00Z' })
    if (pathname.endsWith('/offers/v2')) return json({ contractVersion: 2, requestId, offer: {
      planId: 'early_annual', customerClass: 'early', billingInterval: 'annual', annualAmountMinor: 3600,
      monthlyEquivalentMinor: 300, currency: 'EUR', providers: ['stripe', 'btcpay'], offerRevision: 1,
      offerToken: 'fixture-offer', expiresAt: '2099-01-01T00:00:00Z',
    } })
    if (pathname.endsWith('/activate')) return json({ contractVersion: 2, checkoutIntentToken, expiresAt: '2099-01-01T00:00:00Z', disclosure })
    if (pathname.endsWith('/payment-session/v2')) {
      started = JSON.parse(String(init?.body))
      beforeDispatch = sessionStorage.getItem(key)
      warningBeforeDispatch = screen.queryByText(/Stay in this tab/) !== null
      if (scenario !== 'inline Bitcoin') throw new Error('Start response lost')
      return json({ contractVersion: 2, kind: 'btcpay', paymentSessionToken: started!.recoverySecret,
        cryptoCheckoutUrl: 'https://btcpay.silentsuite.io/i/fixture', cryptoInvoiceId: 'fixture', cryptoInvoiceLookupToken: started!.recoverySecret })
    }
    if (pathname.endsWith('/payment-methods')) return json({ paymentMethods: [{ id: 'BTC', address: 'bc1-fixture', qrValue: 'bitcoin:bc1-fixture', amount: '0.001', currency: 'BTC' }] })
    if (pathname.endsWith('/invoice/fixture')) return json({ status: 'new' })
    if (/payment-session\/v2\/(current|reconcile)$/.test(pathname)) {
      expect(JSON.parse(String(init?.body))).toEqual({ contractVersion: 2, email, requestKey: started!.requestKey, recoverySecret: started!.recoverySecret })
      return json({ contractVersion: 2, state: confirmed ? 'confirmed' : 'open', flow: { provider: 'btcpay', status: confirmed ? 'provider_confirmed' : 'provider_pending' } })
    }
    throw new Error(`Unexpected test request: ${pathname}`)
  })
  let document = render(createElement(SignupPage))
  fireEvent.change(await screen.findByLabelText(/^password$/i), { target: { value: 'OriginalPass1' } })
  const next = screen.getByRole('button', { name: /continue to trial options/i })
  await waitFor(() => expect(next).toBeEnabled())
  fireEvent.click(next)
  fireEvent.click(await screen.findByRole('button', { name: /^continue$/i }))
  const bitcoin = await screen.findByRole('button', { name: /with bitcoin for/i })
  expect(sessionStorage.getItem(key)).toBeNull()
  const originalWrite = Storage.prototype.setItem
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
    if (scenario === 'storage failure' && name === key) throw new Error('quota')
    return originalWrite.call(this, name, value)
  })
  try {
    fireEvent.click(bitcoin)
    if (scenario === 'inline Bitcoin') await screen.findByText('bc1-fixture')
    else await screen.findByText('Start response lost')
    expect(started).toBeDefined()
    if (scenario === 'storage failure') {
      expect(warningBeforeDispatch).toBe(true)
      expect(screen.getByText(/Stay in this tab/)).toBeVisible()
      expect(useAuthStore.getState().signupRecoveryDurability).toBe('memory-only')
      expect(sessionStorage.getItem(key)).toBeNull()
      return
    }
    expect(beforeDispatch).not.toBeNull()
    const saved = JSON.parse(beforeDispatch!)
    expect(saved).toMatchObject({ selectedInterval: 'annual', pendingSignup: { email, paymentSessionRequestKey: started!.requestKey, paymentSessionToken: started!.recoverySecret } })
    expect(beforeDispatch).not.toMatch(/OriginalPass1|billingSessionUserId|encrypted-session|checkoutIntentToken|emailOwnershipToken/)
    for (const destination of ['/signup', '/signup/pending-payment']) {
      document.unmount()
      useAuthStore.setState({ pendingSignup: null })
      window.history.replaceState(window.history.state, '', destination)
      document = render(createElement(SignupPage))
      if (destination === '/signup') {
        await screen.findByRole('link', { name: /recover existing payment/i })
        document.unmount()
        window.history.replaceState({}, '', '/signup?recovery=payment')
        document = render(createElement(SignupPage))
      } else {
        document.unmount()
        const { default: PendingPaymentPage } = await import('../../(auth)/signup/pending-payment/page')
        document = render(createElement(PendingPaymentPage))
      }
      await screen.findByRole('button', { name: /check payment status again/i })
      expect(useAuthStore.getState().pendingSignup).toMatchObject(saved.pendingSignup)
      expect(JSON.parse(sessionStorage.getItem(key)!).savedAt).toBe(saved.savedAt)
    }
    confirmed = true
    fireEvent.click(screen.getByRole('button', { name: /check payment status again/i }))
    await screen.findByLabelText(/^password$/i)
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/payment-session/v2'))).toHaveLength(1)
    expect(mocks.signup).not.toHaveBeenCalled()
  } finally { write.mockRestore() }
})
