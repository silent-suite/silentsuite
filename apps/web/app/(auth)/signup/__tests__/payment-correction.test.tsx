import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import SignupPage from '../page'
import PendingPaymentPage from '../pending-payment/page'
import AuthLayout from '../../layout'
import { useAuthStore } from '@/app/stores/use-auth-store'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/signup' }))
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'dark', setTheme: vi.fn() }) }))
vi.mock('../commercial-funnel-analytics', () => ({ CheckoutReturnAnalytics: () => null }))
vi.mock('@/app/lib/secure-storage', () => ({ secureGet: vi.fn(), secureSet: vi.fn(), secureRemove: vi.fn(), secureClear: vi.fn(), migrateFromLocalStorage: vi.fn() }))
const email = 'recovery@example.test'
const requestKey = '5fd4d86d-34de-4b82-9a66-9598ddf6e02f'
const token = 'A'.repeat(43)
const checkpoint = { silentsuiteSignup: { version: 1, journey: 'payment-journey', phase: 'payment', step: 'plan', view: 'crypto' } }
const open = { contractVersion: 2, state: 'closed', flow: { provider: 'btcpay', status: 'invalid' } }
const receipt = { contractVersion: 2, state: 'released', flow: { provider: 'btcpay', status: 'provider_terminal' }, release: { requestKey, provider: 'btcpay', providerObjectId: 'invoice_exact' } }
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('scrollTo', vi.fn())
  sessionStorage.clear(); localStorage.clear()
  useAuthStore.setState({ pendingSignup: { email, paymentSessionToken: token, paymentSessionRequestKey: requestKey, paymentMethod: 'btcpay', billingContractVersion: 2 }, user: null, isAuthenticated: false })
  window.history.replaceState(checkpoint, '', '/signup')
  sessionStorage.setItem('silentsuiteSignup:payment-journey', 'payment')
})

it.each(['cancel', 'current'] as const)('retires refreshed signup checkpoints after an exact %s receipt and requires missing signup authority', async source => {
  useAuthStore.getState().saveSignupStateForRedirect('annual')
  useAuthStore.setState({ pendingSignup: null })
  vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(source === 'current' || String(url).endsWith('/cancel') ? receipt : open))))
  let page = render(<SignupPage />)
  if (source === 'cancel') {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel and go back' }))
  }
  await screen.findByRole('heading', { name: 'Verify email to choose a payment method' })
  expect(screen.getByText(/no longer has valid email verification and signed signup terms/)).toBeVisible()
  expect(useAuthStore.getState().pendingSignup?.paymentSessionToken).toBeUndefined()
  expect(sessionStorage.getItem('silentsuite-signup-redirect-state')).toBeNull()
  expect(sessionStorage.getItem('silentsuiteSignup:payment-journey')).toBe('retired')
  expect(window.history.state.silentsuiteSignup).toBeUndefined()
  const calls = vi.mocked(fetch).mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: 'Verify email again' }))
  expect(await screen.findByLabelText(/^email$/i)).toBeVisible()
  // Actual Back/Forward into an old checkpoint cannot revive payment recovery.
  window.history.pushState(checkpoint, '', '/signup')
  window.history.pushState({}, '', '/signup')
  for (const direction of ['back', 'forward'] as const) {
    const moved = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
    await act(async () => { window.history[direction](); await moved })
    page.unmount()
    useAuthStore.setState({ pendingSignup: null })
    page = render(<SignupPage />)
    expect(await screen.findByLabelText(/^email$/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Cancel and go back' })).not.toBeInTheDocument()
  }
  expect(fetch).toHaveBeenCalledTimes(calls)
})

it.each(['provider', 'request', 'changed-owner'] as const)('does not retire signup checkpoints for a %s mismatch', async mismatch => {
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (!String(url).endsWith('/cancel')) return new Response(JSON.stringify(open))
    if (mismatch === 'changed-owner') useAuthStore.setState({ pendingSignup: { ...useAuthStore.getState().pendingSignup!, paymentSessionToken: 'B'.repeat(43) } })
    return new Response(JSON.stringify(mismatch === 'provider' ? { ...receipt, flow: { ...receipt.flow, provider: 'stripe' }, release: { ...receipt.release, provider: 'stripe' } } : mismatch === 'request' ? { ...receipt, release: { ...receipt.release, requestKey: 'b7232f41-2cf4-4987-b1d4-8042bcae9b96' } } : receipt))
  }))
  render(<SignupPage />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel and go back' }))
  await act(async () => {})
  await waitFor(() => expect(useAuthStore.getState().pendingSignup?.paymentSessionToken).toBe(mismatch === 'changed-owner' ? 'B'.repeat(43) : token))
  expect(sessionStorage.getItem('silentsuiteSignup:payment-journey')).toBe('payment')
  expect(screen.queryByRole('heading', { name: 'Verify email to choose a payment method' })).not.toBeInTheDocument()
  expect(vi.mocked(fetch).mock.calls.every(([url]) => /\/(current|reconcile|cancel)$/.test(String(url)))).toBe(true)
})

it.each(['Escape', 'Stay'] as const)('contains Tab and Shift+Tab across auth-layout siblings and restores invoking focus on %s', async dismissal => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(open))))
  render(<AuthLayout><PendingPaymentPage /></AuthLayout>)
  const terms = await screen.findByRole('link', { name: 'Terms and Conditions' })
  const back = await screen.findByRole('button', { name: 'Back' })
  back.focus(); fireEvent.click(back)
  const stay = screen.getByRole('button', { name: 'Stay' })
  const cancel = screen.getByRole('button', { name: 'Cancel and go back' })
  await waitFor(() => expect(stay).toHaveFocus())
  expect(terms.closest('[inert]')).not.toBeNull()
  expect(screen.queryByRole('link', { name: 'Terms and Conditions' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /switch to light mode/i })).not.toBeInTheDocument()
  fireEvent.keyDown(stay, { key: 'Tab', shiftKey: true }); expect(cancel).toHaveFocus()
  fireEvent.keyDown(cancel, { key: 'Tab' }); expect(stay).toHaveFocus()
  if (dismissal === 'Escape') fireEvent.keyDown(stay, { key: 'Escape' }); else fireEvent.click(stay)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(back).toHaveFocus()
  expect(terms.closest('[inert]')).toBeNull()
  expect(screen.getByRole('link', { name: 'Terms and Conditions' })).toBeVisible()
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(false)
})
