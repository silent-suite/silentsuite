import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SignupSuccessPage from '../success/page'
import SignupPage from '../page'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { paymentReturnUrl } from '@/app/lib/signup-return'

const mocks = vi.hoisted(() => ({ session: null as string | null, signup: vi.fn(), proof: vi.fn(), push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }), useSearchParams: () => new URLSearchParams(window.location.search) }))
vi.mock('../commercial-funnel-analytics', () => ({ CheckoutReturnAnalytics: () => null }))
vi.mock('../components/step-create-vault', () => ({ StepCreateVault: ({ onComplete }: { onComplete: () => void }) => <button onClick={onComplete}>Complete vault</button> }))
vi.mock('@/app/lib/secure-storage', () => ({
  secureGet: vi.fn(async () => mocks.session), secureSet: vi.fn(async (_key: string, value: string) => { mocks.session = value }),
  secureRemove: vi.fn(), secureClear: vi.fn(), migrateFromLocalStorage: vi.fn(),
}))
vi.mock('@/app/lib/etebase-auth', () => ({ etebaseSignUp: mocks.signup, etebaseLogIn: vi.fn(), issueBillingLinkProof: mocks.proof }))
vi.mock('@/app/lib/self-hosted', () => ({ isSelfHosted: false, isCustomServer: (url?: string) => !!url && url !== 'https://server.silentsuite.io' }))
const key = 'silentsuite-signup-redirect-state'
const email = 'callback@example.test'
const id = '5fd4d86d-34de-4b82-9a66-9598ddf6e02f'
const token = 'A'.repeat(43)
const profile = { id, email, isAdmin: false, emailVerified: true, rememberDevice: false }
const completed = { ...profile, contractVersion: 2, planId: 'early_annual', provisioningStatus: 'active', earlyAdopter: false,
  createdAt: '2026-09-09T00:00:00.000Z', clientSecret: null, cryptoCheckoutUrl: null, cryptoInvoiceId: null, cryptoInvoiceLookupToken: null }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
function checkpoint(receipt = false, paymentMethod: 'stripe' | 'btcpay' = 'stripe') {
  useAuthStore.setState({ pendingSignup: { email, serverUrl: 'https://server.silentsuite.io', paymentSessionToken: token, paymentSessionRequestKey: id, paymentMethod, billingContractVersion: 2,
    password: 'NeverPersist1', ...(receipt ? { provisionedUser: { id, planId: 'early_annual', isAdmin: false }, provisionedSubscriptionStatus: 'active', billingSessionUserId: id } : {}),
  } })
  useAuthStore.getState().saveSignupStateForRedirect('annual')
  const original = JSON.parse(sessionStorage.getItem(key)!)
  expect(sessionStorage.getItem(key)).not.toMatch(/NeverPersist1|billingSessionUserId/)
  useAuthStore.setState({ pendingSignup: null })
  return original
}
function returnDocument(intent: string, status?: string) {
  const url = new URL(paymentReturnUrl(window.location.origin, undefined, 'silentsuite://signup-complete'))
  url.searchParams.set(intent, 'untrusted-provider-id')
  if (status) url.searchParams.set('redirect_status', status)
  url.searchParams.set('email', 'wrong@example.test')
  url.searchParams.set('payment_session_token', 'untrusted-query-token')
  window.history.replaceState({}, '', url)
  return render(<StrictMode><SignupSuccessPage /></StrictMode>)
}
async function submitAccount() {
  fireEvent.change(await screen.findByLabelText(/^Password$/), { target: { value: 'CallbackPass1' } })
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'CallbackPass1' } })
  const submit = screen.getByRole('button', { name: 'Create account and continue' })
  await waitFor(() => expect(submit).toBeEnabled())
  fireEvent.click(submit)
}
beforeEach(() => {
  vi.clearAllMocks()
  useAuthStore.setState({ pendingSignup: null, user: null, isAuthenticated: false, isLoading: false, error: null })
  sessionStorage.clear(); localStorage.clear()
  mocks.session = null
  mocks.signup.mockResolvedValue({ savedSession: 'encrypted-session', authToken: 'unused' })
  mocks.proof.mockResolvedValue('fresh-proof')
  vi.stubGlobal('fetch', vi.fn(async (url) => json(String(url).endsWith('/finalize-payment/v2') ? completed : profile)))
})
afterEach(() => { vi.restoreAllMocks() })

describe.each(['setup_intent', 'payment_intent'])('%s full-document callback', (intent) => {
  it.each(['succeeded', 'processing'])('retains the original checkpoint for %s and uses real finalization/session checks before vault', async (status) => {
    const original = checkpoint()
    const document = returnDocument(intent, status)
    await screen.findByRole('heading', { name: 'Create your account' })
    expect(screen.queryByText(/Card verified successfully|Payment is confirmed/)).not.toBeInTheDocument()
    expect(useAuthStore.getState().pendingSignup).toEqual(original.pendingSignup)
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(original)
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
    await submitAccount()
    await screen.findByText('Complete vault')
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/auth/signup/finalize-payment/v2', '/auth/token-exchange', '/auth/session'])
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ contractVersion: 2, etebaseLinkProof: 'fresh-proof', paymentSessionToken: token })
    const receipt = JSON.parse(sessionStorage.getItem(key)!)
    expect(receipt).toMatchObject({ savedAt: original.savedAt, pendingSignup: { ...original.pendingSignup, provisionedUser: { id } } })
    expect(sessionStorage.getItem(key)).not.toMatch(/billingSessionUserId|encrypted-session|CallbackPass1|untrusted/)
    expect(mocks.signup).toHaveBeenCalledWith(email, 'CallbackPass1', original.pendingSignup.serverUrl)
    document.unmount()
    useAuthStore.setState({ pendingSignup: null })
    vi.mocked(fetch).mockClear()
    returnDocument(intent, status)
    await screen.findByText('Complete vault')
    expect(vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/auth/token-exchange', '/auth/session'])
    expect(mocks.signup).toHaveBeenCalledTimes(1)
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(receipt)
  })
  it.each(['failed', 'processing', 'succeeded', undefined])('recovers a completed receipt even with %s URL status, without payment or account creation', async (status) => {
    const original = checkpoint(true)
    mocks.session = 'encrypted-session'
    returnDocument(intent, status)
    await screen.findByText('Complete vault')
    expect(mocks.signup).not.toHaveBeenCalled()
    expect(vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/auth/token-exchange', '/auth/session'])
    expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({ savedAt: original.savedAt, pendingSignup: original.pendingSignup })
    expect(useAuthStore.getState().pendingSignup?.billingSessionUserId).toBe(id)
  })
  it.each(['failed', 'unknown', undefined])('keeps unresolved %s returns on usable recovery navigation', async (status) => {
    const original = checkpoint()
    const document = returnDocument(intent, status)
    fireEvent.click(await screen.findByRole('button', { name: 'Open payment recovery' }))
    expect(mocks.push).toHaveBeenCalledWith('/signup?recovery=payment')
    expect(mocks.push).not.toHaveBeenCalledWith('/')
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(original)
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.signup).not.toHaveBeenCalled()
    document.unmount()
    useAuthStore.setState({ pendingSignup: null })
    window.history.replaceState({}, '', '/signup?recovery=payment')
    vi.mocked(fetch).mockResolvedValue(json({ contractVersion: 2, state: 'closed', flow: null }))
    render(<SignupPage />)
    await screen.findByRole('heading', { name: 'Payment release not confirmed' })
    expect(useAuthStore.getState().pendingSignup).toEqual(original.pendingSignup)
    for (const [url, init] of vi.mocked(fetch).mock.calls) {
      expect(String(url)).toMatch(/payment-session\/v2\/current$/)
      expect(JSON.parse(String(init?.body))).toEqual({ contractVersion: 2, email, requestKey: id, recoverySecret: token })
    }
  })
  it.each(['missing', 'expired'])('does not trust succeeded with a %s checkpoint; recovery destination remains usable', async (kind) => {
    if (kind === 'expired') {
      const original = checkpoint()
      sessionStorage.setItem(key, JSON.stringify({ ...original, savedAt: Date.now() - 2 * 60 * 60 * 1000 }))
    }
    const document = returnDocument(intent, 'succeeded')
    expect(screen.queryByText(/saved successfully|Card verified|Payment is confirmed/)).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Open payment recovery' }))
    expect(mocks.push).toHaveBeenCalledWith('/signup?recovery=payment')
    expect(useAuthStore.getState().pendingSignup).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    document.unmount()
    window.history.replaceState({}, '', '/signup?recovery=payment')
    render(<SignupPage />)
    await screen.findByRole('heading', { name: 'Payment recovery details unavailable' })
    expect(screen.getByRole('link', { name: /support/i })).toBeVisible()
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['unsettled', 'receipt-email', 'session-identity'])('rejects %s despite a succeeded URL', async (failure) => {
    const original = checkpoint()
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (String(url).endsWith('/finalize-payment/v2')) return failure === 'unsettled' ? json({ detail: 'Payment is still processing.' }, 409)
        : json(failure === 'receipt-email' ? { ...completed, email: 'wrong@example.test' } : completed)
      return json(String(url).endsWith('/auth/session') ? { ...profile, id: 'wrong-user' } : profile)
    })
    returnDocument(intent, 'succeeded')
    await submitAccount()
    await screen.findByRole('alert')
    expect(screen.queryByText('Complete vault')).not.toBeInTheDocument()
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(useAuthStore.getState().pendingSignup?.billingSessionUserId).toBeUndefined()
    expect(mocks.push).not.toHaveBeenCalled()
    expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({ savedAt: original.savedAt, pendingSignup: { email, paymentSessionToken: token, paymentSessionRequestKey: id } })
    if (failure === 'session-identity') expect(useAuthStore.getState().pendingSignup?.provisionedUser?.id).toBe(id)
    else expect(useAuthStore.getState().pendingSignup?.provisionedUser).toBeUndefined()
  })
})

it.each(['stripe', 'btcpay'] as const)('publishes expired durability before the unchanged restored %s object shortcut without renewing TTL', (provider) => {
  const original = checkpoint(false, provider)
  const restored = useAuthStore.getState().restoreSignupStateFromRedirect({ retainForRecovery: true })!
  expect(useAuthStore.getState().pendingSignup).toBe(restored.pendingSignup)
  vi.spyOn(Date, 'now').mockReturnValue(original.savedAt + 2 * 60 * 60 * 1000)
  act(() => useAuthStore.getState().saveSignupStateForRedirect('annual'))
  expect(useAuthStore.getState().signupRecoveryDurability).toBe('memory-only')
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(original)
  expect(useAuthStore.getState().restoreSignupStateFromRedirect({ retainForRecovery: true })).toBeNull()
  expect(sessionStorage.getItem(key)).toBeNull()
})

it.each([false, true])('direct navigation uses retained receipt (%s), never URL completion authority', async (receipt) => {
  if (receipt) { checkpoint(true); mocks.session = 'encrypted-session' }
  window.history.replaceState({}, '', '/signup/success')
  render(<SignupSuccessPage />)
  if (receipt) {
    const finish = await screen.findByText('Complete vault')
    // A cleared runtime (e.g. logout) must not leave a stale completion control
    // able to navigate home when completeSignup has no provisioned account.
    act(() => useAuthStore.setState({ pendingSignup: null }))
    fireEvent.click(finish)
  }
  fireEvent.click(await screen.findByRole('button', { name: 'Open payment recovery' }))
  expect(mocks.push).toHaveBeenCalledWith('/signup?recovery=payment')
  expect(mocks.push).not.toHaveBeenCalledWith('/')
  expect(useAuthStore.getState().isAuthenticated).toBe(false)
})
