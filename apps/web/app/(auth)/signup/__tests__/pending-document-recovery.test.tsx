import { StrictMode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import SignupPage from '../page'
import PendingPaymentPage from '../pending-payment/page'
import { useAuthStore } from '@/app/stores/use-auth-store'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('../commercial-funnel-analytics', () => ({ CheckoutReturnAnalytics: () => null }))
vi.mock('../components/step-create-paid-account', () => ({ StepCreatePaidAccount: () => <div>Recovered account continuation</div> }))
vi.mock('@/app/lib/secure-storage', () => ({ secureGet: vi.fn(), secureSet: vi.fn(), secureRemove: vi.fn(), secureClear: vi.fn(), migrateFromLocalStorage: vi.fn() }))
const key = 'silentsuite-signup-redirect-state'
const email = 'recovery@example.test'
const requestKey = '5fd4d86d-34de-4b82-9a66-9598ddf6e02f'
const token = 'A'.repeat(43)
// The same-document recovery entry the signup page still serves for this capability.
const recoveryHref = '/signup?recovery=payment'
beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear(); localStorage.clear()
  useAuthStore.setState({ pendingSignup: null, user: null, isAuthenticated: false, isLoading: false, error: null })
  window.history.replaceState({}, '', '/signup/pending-payment')
})

it.each(['btcpay', 'stripe'] as const)('restores the exact %s attempt after full-document Back, refresh and return with the real store', async (paymentMethod) => {
  let confirmed = false
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ contractVersion: 2, state: confirmed ? 'confirmed' : 'open', flow: { provider: paymentMethod, status: confirmed ? 'provider_confirmed' : 'provider_pending' } }))))
  useAuthStore.setState({ pendingSignup: { email, password: 'NeverPersist1', serverUrl: 'https://server.silentsuite.io', paymentSessionToken: token, paymentSessionRequestKey: requestKey, paymentMethod, billingContractVersion: 2 } })
  let document = render(<PendingPaymentPage />)
  await screen.findByRole('button', { name: 'Back' })
  expect(screen.queryByRole('link', { name: /reload this payment recovery|recover/i })).not.toBeInTheDocument()
  const snapshot = sessionStorage.getItem(key)!
  expect(snapshot).not.toContain('NeverPersist1')
  // jsdom cannot navigate documents: discard all runtime state and remount the
  // actual destination at the anchor URL, retaining only browser sessionStorage.
  for (const target of [recoveryHref, recoveryHref, '/signup/pending-payment']) {
    document.unmount()
    useAuthStore.setState({ pendingSignup: null })
    window.history.replaceState({}, '', target)
    document = render(<StrictMode>{target === '/signup/pending-payment' ? <PendingPaymentPage /> : <SignupPage />}</StrictMode>)
    await screen.findByRole('button', { name: 'Back' })
    expect(screen.queryByLabelText(/^email$/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Your invoice is available/)).not.toBeInTheDocument()
    expect(useAuthStore.getState().pendingSignup).toMatchObject({ email, paymentSessionToken: token, paymentSessionRequestKey: requestKey, paymentMethod })
    expect(useAuthStore.getState().pendingSignup).not.toHaveProperty('password')
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(JSON.parse(snapshot))
  }
  // Backend confirmation completes the account step automatically on the next
  // same-owned read; no manual status check exists.
  confirmed = true
  document.unmount()
  useAuthStore.setState({ pendingSignup: null })
  document = render(<PendingPaymentPage />)
  await screen.findByText('Recovered account continuation')
  expect(screen.queryByText(/cryptocurrency payment settled/)).not.toBeInTheDocument()
  expect(useAuthStore.getState().isAuthenticated).toBe(false)
  for (const [url, init] of vi.mocked(fetch).mock.calls) {
    expect(String(url)).toMatch(/\/auth\/signup\/payment-session\/v2\/(current|reconcile)$/)
    expect(String(url)).not.toContain(token)
    expect(JSON.parse(String(init?.body))).toEqual({ contractVersion: 2, email, requestKey, recoverySecret: token, switchingProfile: 'v1' })
  }
})

it('Back opens the cancellation decision in the same document and never navigates or releases by itself', async () => {
  useAuthStore.setState({ pendingSignup: { email, paymentSessionToken: token, paymentSessionRequestKey: requestKey, paymentMethod: 'btcpay', billingContractVersion: 2 } })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ contractVersion: 2, state: 'closed', flow: null }))))
  render(<PendingPaymentPage />)
  await screen.findByRole('heading', { name: /payment release not confirmed/i })
  sessionStorage.removeItem(key)
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(await screen.findByRole('dialog', { name: 'Cancel this cryptocurrency payment?' })).toBeVisible()
  expect(window.location.pathname).toBe('/signup/pending-payment')
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(false)
  expect(useAuthStore.getState().pendingSignup?.paymentSessionToken).toBe(token)
})

it('the Back decision cannot hide the memory-only warning', async () => {
  useAuthStore.setState({ pendingSignup: { email, paymentSessionToken: token, paymentSessionRequestKey: requestKey, paymentMethod: 'btcpay', billingContractVersion: 2 } })
  const closed = () => new Response(JSON.stringify({ contractVersion: 2, state: 'closed', flow: null }))
  const fetcher = vi.fn(async () => closed())
  vi.stubGlobal('fetch', fetcher)
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  try {
    render(<PendingPaymentPage />)
    await screen.findByRole('heading', { name: /payment release not confirmed/i })
    expect(screen.getByText(/Stay in this tab/)).toBeVisible()
    expect(fetcher).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await screen.findByRole('dialog', { name: 'Cancel this cryptocurrency payment?' })
    expect(screen.getByText(/Stay in this tab/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText(/Stay in this tab/)).toBeVisible()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(useAuthStore.getState().pendingSignup?.paymentSessionToken).toBe(token)
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
  } finally { write.mockRestore() }
})

it('an expired persisted capability is not renewed or treated as payment authority', async () => {
  sessionStorage.setItem(key, JSON.stringify({ pendingSignup: { email, paymentSessionToken: token, paymentSessionRequestKey: requestKey, billingContractVersion: 2 }, selectedInterval: 'annual', savedAt: 0 }))
  window.history.replaceState({}, '', recoveryHref)
  vi.stubGlobal('fetch', vi.fn())
  render(<SignupPage />)
  await screen.findByRole('heading', { name: /recovery details unavailable/i })
  expect(sessionStorage.getItem(key)).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
})

it('a route hint alone cannot create fresh signup or grant payment authority', async () => {
  window.history.replaceState({}, '', recoveryHref)
  vi.stubGlobal('fetch', vi.fn())
  render(<SignupPage />)
  await screen.findByRole('heading', { name: /recovery details unavailable/i })
  expect(screen.queryByLabelText(/^email$/i)).not.toBeInTheDocument()
  expect(fetch).not.toHaveBeenCalled()
  expect(useAuthStore.getState().isAuthenticated).toBe(false)
})

it('independent: completing signup consumes the newly retained recovery capability', () => {
  useAuthStore.setState({ pendingSignup: { email, paymentSessionToken: token, paymentSessionRequestKey: requestKey, paymentMethod: 'btcpay', billingContractVersion: 2, rememberDevice: false } })
  useAuthStore.getState().saveSignupStateForRedirect('annual')
  useAuthStore.setState({ pendingSignup: null })
  useAuthStore.getState().restoreSignupStateFromRedirect({ retainForRecovery: true })
  useAuthStore.setState({ pendingSignup: { ...useAuthStore.getState().pendingSignup!, provisionedUser: {id:'completed-user', planId:'early_annual', isAdmin:false}, billingSessionUserId:'completed-user', provisionedSubscriptionStatus:'active' } })
  useAuthStore.getState().completeSignup()
  expect(useAuthStore.getState().isAuthenticated).toBe(true)
  expect(sessionStorage.getItem(key)).toBeNull()
})
it('independent: an expired retained snapshot is not renewed by an in-memory remount', async () => {
  useAuthStore.setState({ pendingSignup: { email, paymentSessionToken: token, paymentSessionRequestKey: requestKey, paymentMethod: 'btcpay', billingContractVersion: 2 } })
  sessionStorage.setItem(key, JSON.stringify({ pendingSignup: useAuthStore.getState().pendingSignup, selectedInterval: 'annual', savedAt: Date.now() - 3 * 60 * 60 * 1000 }))
  const before = sessionStorage.getItem(key)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({contractVersion:2, state:'closed', flow:null}))))
  render(<PendingPaymentPage />)
  await screen.findByRole('heading', { name: /payment release not confirmed/i })
  expect(sessionStorage.getItem(key)).toBe(before)
})
it('independent: mismatched stored identity and closed server recovery do not unlock or create', async () => {
 sessionStorage.setItem(key, JSON.stringify({pendingSignup:{email:'other@example.test',paymentSessionToken:token,paymentSessionRequestKey:requestKey,billingContractVersion:2},selectedInterval:'annual',savedAt:Date.now()}))
 vi.stubGlobal('fetch',vi.fn(async () => new Response(JSON.stringify({contractVersion:2,state:'closed',flow:null}))))
 render(<PendingPaymentPage />)
 await screen.findByRole('heading',{name:/payment release not confirmed/i})
 expect(screen.queryByText('Recovered account continuation')).not.toBeInTheDocument()
 expect(useAuthStore.getState().isAuthenticated).toBe(false)
 expect(useAuthStore.getState().pendingSignup?.paymentSessionToken).toBe(token)
 for (const [url] of vi.mocked(fetch).mock.calls) expect(String(url)).toMatch(/payment-session\/v2\/current$/)
})

it('independent: paid completion receipt survives recovery document reset', async () => {
 useAuthStore.setState({pendingSignup:{email,paymentSessionToken:token,paymentSessionRequestKey:requestKey,billingContractVersion:2,paymentMethod:'btcpay'}})
 vi.stubGlobal('fetch',vi.fn(async () => new Response(JSON.stringify({contractVersion:2,state:'confirmed',flow:{provider:'btcpay',status:'provider_confirmed'}}))))
 const first=render(<PendingPaymentPage />)
 await screen.findByText('Recovered account continuation')
 // Model the real store's successful finalization + failed session state:
 // its completion receipt is retained in memory but session authority is absent.
 useAuthStore.setState({pendingSignup:{...useAuthStore.getState().pendingSignup!,provisionedUser:{id:'completed-user',planId:'early_annual',isAdmin:false},provisionedSubscriptionStatus:'active'}})
 first.unmount()
 useAuthStore.setState({pendingSignup:null})
 vi.stubGlobal('fetch',vi.fn(async () => new Response(JSON.stringify({contractVersion:2,state:'closed',flow:null}))))
 render(<PendingPaymentPage />)
 await screen.findByRole('heading',{name:/finish signing in/i})
 expect(screen.queryByText('Recovered account continuation')).not.toBeInTheDocument()
 expect(useAuthStore.getState().pendingSignup?.provisionedUser?.id).toBe('completed-user')
})

const receipt = { id: 'completed-user', planId: 'early_annual', isAdmin: false }
function checkpoint() {
  useAuthStore.setState({ pendingSignup: { email, paymentSessionToken: token, paymentSessionRequestKey: requestKey, paymentMethod: 'stripe', billingContractVersion: 2 } })
  useAuthStore.getState().saveSignupStateForRedirect('annual')
  return JSON.parse(sessionStorage.getItem(key)!)
}

it('publishes a monotonic sanitized completion receipt at the original issuance time', () => {
  const original = checkpoint()
  const pending = useAuthStore.getState().pendingSignup!
  useAuthStore.setState({ pendingSignup: { ...pending, password: 'NotStored1', billingSessionUserId: receipt.id, provisionedUser: receipt, provisionedSubscriptionStatus: 'active' } })
  useAuthStore.setState({ pendingSignup: { ...pending } })
  const saved = JSON.parse(sessionStorage.getItem(key)!)
  expect(saved.savedAt).toBe(original.savedAt)
  expect(saved.pendingSignup).toMatchObject({ provisionedUser: receipt, provisionedSubscriptionStatus: 'active' })
  expect(saved.pendingSignup).not.toHaveProperty('password')
  expect(saved.pendingSignup).not.toHaveProperty('billingSessionUserId')
})

it.each(['email', 'paymentSessionToken', 'paymentSessionRequestKey', 'serverUrl'] as const)('does not copy a receipt across a mismatched %s', (field) => {
  checkpoint()
  useAuthStore.setState({ pendingSignup: { ...useAuthStore.getState().pendingSignup!, provisionedUser: receipt } })
  const original = sessionStorage.getItem(key)
  useAuthStore.setState({ pendingSignup: { email, paymentSessionToken: token, paymentSessionRequestKey: requestKey, billingContractVersion: 2, [field]: 'different' } })
  expect(sessionStorage.getItem(key)).toBe(original)
  expect(useAuthStore.getState().signupRecoveryDurability).toBe('none')
  useAuthStore.getState().saveSignupStateForRedirect('annual')
  expect(JSON.parse(sessionStorage.getItem(key)!).pendingSignup).not.toHaveProperty('provisionedUser')
})

it.each([-1, 0, 1])('enforces the exact original expiry boundary %d milliseconds', (offset) => {
  const original = checkpoint()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(original.savedAt + 2 * 60 * 60 * 1000 + offset)
  try {
    useAuthStore.getState().saveSignupStateForRedirect('annual')
    expect(JSON.parse(sessionStorage.getItem(key)!).savedAt).toBe(original.savedAt)
    expect(useAuthStore.getState().signupRecoveryDurability).toBe(offset < 0 ? 'persisted' : 'memory-only')
    useAuthStore.setState({ pendingSignup: null })
    expect(Boolean(useAuthStore.getState().restoreSignupStateFromRedirect({ retainForRecovery: true }))).toBe(offset < 0)
  } finally { clock.mockRestore() }
})

it('rejects future-issued snapshots', () => {
  const original = checkpoint()
  sessionStorage.setItem(key, JSON.stringify({ ...original, savedAt: Date.now() + 10000 }))
  useAuthStore.setState({ pendingSignup: null })
  expect(useAuthStore.getState().restoreSignupStateFromRedirect({ retainForRecovery: true })).toBeNull()
})

it('retains latest in-memory receipt and original lifetime when writing fails', () => {
  const original = checkpoint()
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  try {
    expect(() => useAuthStore.setState({ pendingSignup: { ...useAuthStore.getState().pendingSignup!, provisionedUser: receipt } })).not.toThrow()
    expect(sessionStorage.getItem(key)).toBeNull()
    expect(useAuthStore.getState().pendingSignup?.provisionedUser).toEqual(receipt)
    expect(useAuthStore.getState().signupRecoveryDurability).toBe('memory-only')
  } finally { write.mockRestore() }
  useAuthStore.getState().saveSignupStateForRedirect('annual')
  expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({ savedAt: original.savedAt, pendingSignup: { provisionedUser: receipt } })
  expect(useAuthStore.getState().signupRecoveryDurability).toBe('persisted')
})

it('cannot mint a new expiry after a failed first storage write', () => {
  const issued = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(issued)
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  try {
    useAuthStore.setState({ pendingSignup: { email, paymentSessionToken: token, paymentSessionRequestKey: requestKey, billingContractVersion: 2 } })
    useAuthStore.getState().saveSignupStateForRedirect('annual')
    write.mockRestore()
    clock.mockReturnValue(issued + 2 * 60 * 60 * 1000)
    useAuthStore.getState().saveSignupStateForRedirect('annual')
    expect(sessionStorage.getItem(key)).toBeNull()
    expect(useAuthStore.getState().signupRecoveryDurability).toBe('memory-only')
  } finally { write.mockRestore(); clock.mockRestore() }
})

it('retained restore is readable even when all storage writes fail', () => {
  checkpoint()
  const original = sessionStorage.getItem(key)
  useAuthStore.setState({ pendingSignup: null })
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  try {
    expect(useAuthStore.getState().restoreSignupStateFromRedirect({ retainForRecovery: true })?.pendingSignup.email).toBe(email)
    expect(sessionStorage.getItem(key)).toBe(original)
    expect(useAuthStore.getState().signupRecoveryDurability).toBe('persisted')
  } finally { write.mockRestore() }
})

it('failed completion retains recovery; successful completion disposes it for both remember choices', () => {
  for (const rememberDevice of [false, true]) {
    checkpoint()
    useAuthStore.setState({ pendingSignup: { ...useAuthStore.getState().pendingSignup!, provisionedUser: receipt, rememberDevice } })
    expect(() => useAuthStore.getState().completeSignup()).toThrow(/session/i)
    expect(sessionStorage.getItem(key)).not.toBeNull()
    useAuthStore.setState({ pendingSignup: { ...useAuthStore.getState().pendingSignup!, billingSessionUserId: receipt.id } })
    useAuthStore.getState().completeSignup()
    expect(useAuthStore.getState().signupRecoveryDurability).toBe('none')
    expect(sessionStorage.getItem(key)).toBeNull()
    expect(useAuthStore.getState().restoreSignupStateFromRedirect({ retainForRecovery: true })).toBeNull()
  }
})

it('completed pending recovery only offers session login and never retries payment', async () => {
  checkpoint()
  useAuthStore.setState({ pendingSignup: { ...useAuthStore.getState().pendingSignup!, provisionedUser: receipt } })
  useAuthStore.setState({ pendingSignup: null })
  vi.stubGlobal('fetch', vi.fn())
  render(<PendingPaymentPage />)
  await screen.findByRole('heading', { name: 'Finish signing in' })
  fireEvent.click(screen.getByRole('button', { name: 'Retry sign in' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Enter your existing account password')
  expect(fetch).not.toHaveBeenCalled()
  expect(screen.queryByText('Recovered account continuation')).not.toBeInTheDocument()
  expect(useAuthStore.getState().isAuthenticated).toBe(false)
  expect(sessionStorage.getItem(key)).not.toBeNull()
})

it('discarding an expired persisted copy cannot renew its still-live runtime attempt', () => {
  const original = checkpoint()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(original.savedAt + 2 * 60 * 60 * 1000)
  try {
    expect(useAuthStore.getState().restoreSignupStateFromRedirect({ retainForRecovery: true })).toBeNull()
    expect(sessionStorage.getItem(key)).toBeNull()
    useAuthStore.getState().saveSignupStateForRedirect('annual')
    expect(sessionStorage.getItem(key)).toBeNull()
  } finally { clock.mockRestore() }
})
