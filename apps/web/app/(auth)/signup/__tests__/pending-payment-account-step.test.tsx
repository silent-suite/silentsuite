import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import SignupPage from '../page'
import PendingPaymentPage from '../pending-payment/page'
import { useAuthStore } from '@/app/stores/use-auth-store'

// The pending-payment account step with the real store and the real paid-account form.
const mocks = vi.hoisted(() => ({ session: null as string | null, signup: vi.fn(), login: vi.fn(), proof: vi.fn(), checkoutReturned: vi.fn() }))
vi.mock('@/app/lib/config', async (importOriginal) => ({ ...await importOriginal<typeof import('@/app/lib/config')>(), BILLING_API_URL: 'https://billing.test' }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams(window.location.search) }))
vi.mock('../commercial-funnel-analytics', () => ({ CheckoutReturnAnalytics: () => null, trackInPageCheckoutReturned: mocks.checkoutReturned, createSignupStepRecorder: () => () => undefined, signupStepFor: () => null }))
vi.mock('../components/step-create-vault', () => ({ StepCreateVault: () => <p>Complete vault</p> }))
vi.mock('@/app/lib/secure-storage', () => ({
  secureGet: vi.fn(async () => mocks.session), secureSet: vi.fn(async (_key: string, value: string) => { mocks.session = value }),
  secureRemove: vi.fn(), secureClear: vi.fn(), migrateFromLocalStorage: vi.fn(),
}))
vi.mock('@/app/lib/etebase-auth', () => ({ etebaseSignUp: mocks.signup, etebaseLogIn: mocks.login, issueBillingLinkProof: mocks.proof }))
vi.mock('@/app/lib/self-hosted', () => ({ isSelfHosted: false, isCustomServer: (url?: string) => !!url && url !== 'https://server.silentsuite.io' }))

const key = 'silentsuite-signup-redirect-state'
const email = 'pending@example.test'
const id = '5fd4d86d-34de-4b82-9a66-9598ddf6e02f'
const token = 'A'.repeat(43)
const official = 'https://server.silentsuite.io'
const profile = { id, email, isAdmin: false, emailVerified: true, rememberDevice: false }
const completed = { ...profile, contractVersion: 2, planId: 'early_annual', provisioningStatus: 'active', earlyAdopter: false,
  createdAt: '2026-09-09T00:00:00.000Z', clientSecret: null, cryptoCheckoutUrl: null, cryptoInvoiceId: null, cryptoInvoiceLookupToken: null }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
const paths = () => vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname)
const paymentStarts = () => paths().filter((p) => p === '/auth/signup/payment-session/v2' || p.includes('checkout'))

function checkpoint(accountReady: boolean, serverUrl = official) {
  useAuthStore.setState({ pendingSignup: { email, serverUrl, paymentSessionToken: token, paymentSessionRequestKey: id,
    paymentMethod: 'btcpay', billingContractVersion: 2, ...(accountReady ? { etebaseAccountReady: true } : {}) } })
  useAuthStore.getState().saveSignupStateForRedirect('annual')
  const saved = JSON.parse(sessionStorage.getItem(key)!)
  useAuthStore.setState({ pendingSignup: null })
  return saved
}

async function submitPassword() {
  fireEvent.change(await screen.findByLabelText(/^password$/i), { target: { value: 'PendingPass1' } })
  const confirm = screen.queryByLabelText('Confirm password')
  if (confirm) fireEvent.change(confirm, { target: { value: 'PendingPass1' } })
  const submit = screen.getByRole('button', { name: /^(Create account|Sign in) and continue$/ })
  await waitFor(() => expect(submit).toBeEnabled())
  fireEvent.click(submit)
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear(); localStorage.clear()
  mocks.session = null
  mocks.signup.mockResolvedValue({ savedSession: 'encrypted-session', authToken: 'unused' })
  mocks.login.mockResolvedValue({ savedSession: 'encrypted-session', authToken: 'unused' })
  mocks.proof.mockResolvedValue('fresh-proof')
  useAuthStore.setState({ pendingSignup: null, user: null, isAuthenticated: false, isLoading: false, error: null })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input)).pathname
    if (/payment-session\/v2\/(current|reconcile)$/.test(pathname)) return json({ contractVersion: 2, state: 'confirmed', flow: { provider: 'btcpay', status: 'provider_confirmed' } })
    if (pathname.endsWith('/finalize-payment/v2')) return json(completed)
    return json(profile)
  }))
})

it('logs in from a ready checkpoint with an explicit official server URL, finalizes once and starts no payment', async () => {
  checkpoint(true)
  window.history.replaceState({}, '', '/signup/pending-payment')
  render(<PendingPaymentPage />)
  await screen.findByRole('heading', { name: 'Enter your password' })
  await submitPassword()
  await screen.findByText('Complete vault')
  expect(mocks.login).toHaveBeenCalledWith(email, 'PendingPass1', official)
  expect(mocks.signup).not.toHaveBeenCalled()
  expect(paths()).not.toContain('/auth/signup-pass/v2')
  expect(paths().filter((p) => p === '/auth/signup/finalize-payment/v2')).toHaveLength(1)
  expect(paymentStarts()).toHaveLength(0)
  // The confirmed payment is counted once; signing in to the account adds no second count.
  expect(mocks.checkoutReturned).toHaveBeenCalledTimes(1)
  expect(mocks.checkoutReturned).toHaveBeenCalledWith('btcpay')
})

it('refuses a ready checkpoint naming another server before any SDK call', async () => {
  const saved = checkpoint(true, 'https://sync.example.test')
  window.history.replaceState({}, '', '/signup/pending-payment')
  render(<PendingPaymentPage />)
  await submitPassword()
  expect(await screen.findByRole('alert')).toHaveTextContent('can only be finished on the SilentSuite server')
  expect(mocks.login).not.toHaveBeenCalled()
  expect(mocks.signup).not.toHaveBeenCalled()
  expect(paths()).not.toContain('/auth/signup/finalize-payment/v2')
  expect(paymentStarts()).toHaveLength(0)
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(saved)
})

it('an old paid document reloaded in the same tab with an old checkpoint shows the support path on a server refusal', async () => {
  const saved = checkpoint(false)
  mocks.signup.mockRejectedValue(Object.assign(new Error('server text'), { name: 'PermissionDeniedError' }))
  // The old page marked `payment` before dispatch; a reload of the same tab reaches payment recovery.
  const journey = 'c5b0e6a4-2f1d-4c8e-9b7a-3d2e1f0a9b8c'
  sessionStorage.setItem(`silentsuiteSignup:${journey}`, 'payment')
  window.history.replaceState({ silentsuiteSignup: { version: 1, journey, step: 'plan', view: 'crypto', phase: 'payment' } }, '', '/signup')
  render(<SignupPage />)
  await screen.findByRole('heading', { name: 'Create your account' })
  await submitPassword()
  expect(await screen.findByRole('alert')).toHaveTextContent('Contact support@silentsuite.io')
  expect(mocks.signup).toHaveBeenCalledTimes(1)
  expect(mocks.signup).toHaveBeenCalledWith(email, 'PendingPass1', official)
  expect(paths()).not.toContain('/auth/signup/finalize-payment/v2')
  expect(paymentStarts()).toHaveLength(0)
  expect(screen.queryByText('Complete vault')).not.toBeInTheDocument()
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(saved)
})
