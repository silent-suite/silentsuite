import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SignupSuccessPage from '../success/page'
import { useAuthStore } from '@/app/stores/use-auth-store'

const mocks = vi.hoisted(() => ({ session: null as string | null, proof: vi.fn(), login: vi.fn(), signup: vi.fn(), push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }), useSearchParams: () => new URLSearchParams('setup_intent=setup-test&redirect_status=succeeded') }))
vi.mock('../commercial-funnel-analytics', () => ({ CheckoutReturnAnalytics: () => null }))
vi.mock('../components/step-create-vault', () => ({ StepCreateVault: ({ onComplete }: { onComplete: () => void }) => <button onClick={onComplete}>Complete vault</button> }))
vi.mock('../components/step-create-paid-account', () => ({ StepCreatePaidAccount: () => <div>Create new account step</div> }))
vi.mock('@/app/lib/secure-storage', () => ({
  secureGet: vi.fn(async () => mocks.session),
  secureSet: vi.fn(async (_key: string, value: string) => { mocks.session = value }),
  secureRemove: vi.fn(), secureClear: vi.fn(), migrateFromLocalStorage: vi.fn(),
}))
vi.mock('@/app/lib/etebase-auth', () => ({ etebaseSignUp: mocks.signup, etebaseLogIn: mocks.login, issueBillingLinkProof: mocks.proof }))
vi.mock('@/app/lib/self-hosted', () => ({ isSelfHosted: false, isCustomServer: (url?: string) => !!url && url !== 'https://server.silentsuite.io' }))
const email = 'receipt@example.test'
const id = 'completed-user'
const profile = { id, email, isAdmin: false, rememberDevice: false, emailVerified: true }
const key = 'silentsuite-signup-redirect-state'
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
function saveReceipt(completed = true, serverUrl?: string) {
  useAuthStore.setState({ pendingSignup: {
    email, serverUrl, paymentSessionToken: 'historical-payment-capability', billingContractVersion: 1,
    ...(completed ? { provisionedUser: { id, planId: 'historical-plan', isAdmin: false }, provisionedSubscriptionStatus: 'active', billingSessionUserId: id } : {}),
  } })
  useAuthStore.getState().saveSignupStateForRedirect('annual')
  expect(sessionStorage.getItem(key)).not.toContain('billingSessionUserId')
  useAuthStore.setState({ pendingSignup: null })
}
beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear(); localStorage.clear()
  useAuthStore.setState({ pendingSignup: null, user: null, isAuthenticated: false, isLoading: false, error: null, subscriptionStatus: null })
  mocks.session = 'restored-encrypted-session'
  mocks.login.mockReset()
  let sequence = 0
  mocks.proof.mockImplementation(async () => `fresh-proof-${++sequence}`)
  vi.stubGlobal('fetch', vi.fn(async () => json(profile)))
})
describe('completed historical redirect session recovery', () => {
  it('verifies fresh session authority before vault, including StrictMode replay', async () => {
    saveReceipt()
    // Parser must also discard a forged historical attestation.
    const snapshot = JSON.parse(sessionStorage.getItem(key)!)
    snapshot.pendingSignup.billingSessionUserId = id
    sessionStorage.setItem(key, JSON.stringify(snapshot))
    render(<StrictMode><SignupSuccessPage /></StrictMode>)
    expect(screen.queryByText('Complete vault')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByText('Complete vault'))
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(mocks.push).toHaveBeenCalledWith('/')
    expect(vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/auth/token-exchange', '/auth/session'])
    expect(mocks.proof).toHaveBeenCalledWith('restored-encrypted-session', undefined)
    expect(mocks.signup).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(key)).toBeNull()
  })
  it.each(['exchange', 'identity'])('shows %s failure and retries session only with a fresh proof', async (failure) => {
    saveReceipt()
    let fail = true
    vi.mocked(fetch).mockImplementation(async (url) => {
      const session = String(url).endsWith('/auth/session')
      return fail ? (failure === 'exchange' ? json({}, 503) : json(session ? { ...profile, id: 'wrong-user' } : profile)) : json(profile)
    })
    render(<SignupSuccessPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/session/i)
    expect(screen.queryByText('Complete vault')).not.toBeInTheDocument()
    expect(useAuthStore.getState().pendingSignup?.provisionedUser?.id).toBe(id)
    expect(() => useAuthStore.getState().completeSignup()).toThrow(/session/i)
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry sign in' }))
    await screen.findByText('Complete vault')
    expect(mocks.proof).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetch).mock.calls.every(([url]) => /\/auth\/(token-exchange|session)$/.test(String(url)))).toBe(true)
    useAuthStore.getState().saveSignupStateForRedirect('annual')
    expect(sessionStorage.getItem(key)).not.toContain('billingSessionUserId')
    expect(mocks.signup).not.toHaveBeenCalled()
  })
  it('recovers missing credentials by existing-account login, with visible wrong-password retry', async () => {
    saveReceipt()
    mocks.session = null
    mocks.login.mockRejectedValueOnce(new Error('Invalid credentials')).mockResolvedValueOnce({ savedSession: 'recovered-session', authToken: 'unused' })
    render(<SignupSuccessPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter your existing account password')
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Existing account password'), { target: { value: 'wrong-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Retry sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Check your existing account password')
    fireEvent.change(screen.getByLabelText('Existing account password'), { target: { value: 'correct-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Retry sign in' }))
    await screen.findByText('Complete vault')
    expect(sessionStorage.getItem(key)).not.toBeNull() // Retained until vault completion, not merely session recovery.
    fireEvent.click(screen.getByText('Complete vault'))
    expect(mocks.login).toHaveBeenLastCalledWith(email, 'correct-password', undefined)
    expect(mocks.signup).not.toHaveBeenCalled()
    expect(vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/auth/token-exchange', '/auth/session'])
    expect(sessionStorage.getItem(key)).toBeNull()
  })
  it('keeps uncompleted 3DS on account creation without session replay', async () => {
    saveReceipt(false)
    render(<SignupSuccessPage />)
    await screen.findByText('Create new account step')
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.proof).not.toHaveBeenCalled()
  })
  it('does not require hosted Billing for a completed custom-server account', async () => {
    saveReceipt(true, 'https://custom.example.test')
    render(<SignupSuccessPage />)
    fireEvent.click(await screen.findByText('Complete vault'))
    await waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(true))
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.proof).not.toHaveBeenCalled()
  })
})
