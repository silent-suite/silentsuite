import { Buffer } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { useEffect, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import PendingPaymentPage from '../page'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED = 'true'
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_recovery'
})

const paymentSessionToken = 'A'.repeat(43)
const paymentSessionRequestKey = '5fd4d86d-34de-4b82-9a66-9598ddf6e02f'
const authState = {
  completeSignup: vi.fn(),
  createEtebaseAccount: vi.fn(),
  finalizePaidSignup: vi.fn(),
  prepareSignupDraft: vi.fn(),
  startAnnualSignupPayment: vi.fn(),
  clearPendingSignupPaymentRecovery: vi.fn(),
  saveSignupStateForRedirect: vi.fn(),
  restoreSignupStateFromRedirect: vi.fn(),
  pendingSignup: null as any,
}

vi.mock('@/app/stores/use-auth-store', () => {
  function useAuthStore<T>(selector: (state: typeof authState) => T): T { return selector(authState) }
  useAuthStore.getState = () => authState
  return { useAuthStore }
})
// Render the real StripePaymentForm; replace only the external Stripe SDK.
vi.mock('@stripe/stripe-js/pure', () => {
  const loadStripe = Object.assign(vi.fn(async () => ({})), { setLoadParameters: vi.fn() })
  return { loadStripe }
})
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: ReactNode }) => <div data-testid="stripe-elements">{children}</div>,
  PaymentElement: ({ onReady }: { onReady: () => void }) => {
    useEffect(() => { onReady() }, [])
    return <input aria-label="Card details" defaultValue="" />
  },
  useStripe: () => ({}), useElements: () => ({}),
}))
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))
vi.mock('@/app/lib/config', () => ({ BILLING_API_URL: 'https://billing.test' }))
vi.mock('@/app/lib/signup-return', () => ({ normalizeSignupReturnTo: (value: string | null) => value }))
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a> }))
vi.mock('../components/step-create-vault', () => ({ StepCreateVault: () => <div data-testid="step-create-vault" /> }))
vi.mock('../../components/step-create-paid-account', () => ({
  StepCreatePaidAccount: ({ email, onNext }: { email: string; onNext: (data: { password: string; confirmPassword: string }) => Promise<void> }) => (
    <div data-testid="step-create-paid-account">
      <span>{email}</span>
      <button type="button" onClick={() => { void onNext({ password: 'RestoredPassword1', confirmPassword: 'RestoredPassword1' }) }}>
        Complete restored account
      </button>
    </div>
  ),
}))

function anonymousRecoverySignup(overrides: Record<string, unknown> = {}) {
  return {
    email: 'customer@example.test',
    billingContractVersion: 2,
    paymentMethod: 'btcpay',
    paymentSessionToken,
    paymentSessionRequestKey,
    ...overrides,
  }
}


// The dedicated contract config resolves this to the selected private lineage.
// Every HTTP response comes from its actual runtime and Fastify serializer.
import { createProviderRecoveryFixture } from '@billing-recovery-fixture'

for (const provider of ['stripe', 'btcpay'] as const) describe(provider + ' runtime-to-rendered recovery', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('continues the same payment through the real recovery route after the bounded polling timeout', async () => {
    vi.clearAllMocks()
    sessionStorage.clear()
    authState.pendingSignup = anonymousRecoverySignup({ paymentMethod: provider })
    vi.stubGlobal('Uint8Array', Object.getPrototypeOf(Buffer.prototype).constructor)
    vi.stubGlobal('crypto', webcrypto)
    const fixture = await createProviderRecoveryFixture(provider)
    const authorityId = fixture.repository.latestSignupPaymentSession()!.id
    const pending: Promise<unknown>[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      expect(new URL(url).pathname).toBe('/auth/signup/payment-session/v2/current')
      expect(JSON.parse(String(init.body))).toEqual(fixture.request)
      const request = fixture.app.inject({ method: 'POST', url: new URL(url).pathname, payload: JSON.parse(String(init.body)) })
        .then(reply => new Response(reply.body, { status: reply.statusCode, headers: { 'content-type': 'application/json' } }))
      pending.push(request)
      return request
    }))
    const settle = async () => { await act(async () => { await Promise.all(pending) }) }
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const view = render(<PendingPaymentPage />)
    try {
      await settle()
      for (let attempt = 0; attempt < 20; attempt++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60_000) })
        await settle()
      }
      expect(fetch).toHaveBeenCalledTimes(20)
      expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled()
      await fixture.repository.confirmPaymentSession(authorityId)
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
      await settle()
      expect(screen.getByTestId('step-create-paid-account')).toBeInTheDocument()
      expect(fetch).toHaveBeenCalledTimes(21)
      expect(fixture.repository.latestSignupPaymentSession()!.id).toBe(authorityId)
      expect(fixture.calls().cancel).toBe(0)
      expect(authState.clearPendingSignupPaymentRecovery).not.toHaveBeenCalled()
    } finally { view.unmount(); vi.useRealTimers(); await fixture.app.close() }
  })

  it.each(['missing', 'confirmed', 'proof-invalid'] as const)('keeps entered controls through a provider exception, then removes them for %s', async terminal => {
    vi.clearAllMocks()
    sessionStorage.clear()
    authState.pendingSignup = anonymousRecoverySignup({ paymentMethod: provider })
    // jose and Node TextEncoder must share Node's typed-array/WebCrypto realm.
    vi.stubGlobal('Uint8Array', Object.getPrototypeOf(Buffer.prototype).constructor)
    vi.stubGlobal('crypto', webcrypto)
    const fixture = await createProviderRecoveryFixture(provider)
    const statuses: number[] = []
    const bodies: string[] = []
    const pending: Promise<unknown>[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      const request = fixture.app.inject({ method: 'POST', url: new URL(url).pathname, payload: JSON.parse(String(init.body)) }).then(reply => {
        statuses.push(reply.statusCode); bodies.push(reply.body)
        return new Response(reply.body, { status: reply.statusCode, headers: { 'content-type': String(reply.headers['content-type']) } })
      })
      pending.push(request)
      return request
    }))
    const settle = async () => { await act(async () => { await Promise.all(pending) }) }
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const view = render(<PendingPaymentPage />)
    try {
      await settle()
      const control = provider === 'stripe' ? screen.getByLabelText('Card details') : screen.getByRole('link', { name: 'Continue this cryptocurrency payment' })
      const elements = provider === 'stripe' ? screen.getByTestId('stripe-elements') : null
      if (provider === 'stripe') fireEvent.change(control, { target: { value: 'entered card data' } })
      fixture.observe(async () => { throw new Error('private provider detail DO_NOT_LEAK') })
      await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60_000) })
      await settle()
      expect(statuses).toEqual([200, 503])
      expect(control).toBeInTheDocument()
      if (elements) expect(screen.getByTestId('stripe-elements')).toBe(elements)
      if (provider === 'stripe') expect(control).toHaveValue('entered card data')
      expect(bodies[1]).not.toContain('DO_NOT_LEAK')
      expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
      // Explicit retry traverses the same client/runtime boundary too.
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await settle()
      expect(statuses).toEqual([200, 503, 503])
      expect(control).toBeInTheDocument()
      fixture.observe(async () => fixture.controls)
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await settle()
      expect(control).toBeInTheDocument()
      if (provider === 'stripe') expect(control).toHaveValue('entered card data')
      // A successful read leaves no manual status control; only the scheduled poll continues.
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
      if (terminal === 'missing') fixture.observe(async () => null)
      if (terminal === 'confirmed') fixture.observe(async () => {
        await fixture.repository.confirmPaymentSession(fixture.repository.latestSignupPaymentSession()!.id)
        throw new Error('provider failed after webhook confirmation')
      })
      if (terminal === 'proof-invalid') fixture.observe(async () => {
        vi.spyOn(fixture.repository, 'recoverPaymentSession').mockResolvedValue(null)
        throw new Error('provider failed after proof expired')
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60_000) })
      await settle()
      expect(control).not.toBeInTheDocument()
      expect(statuses.at(-1)).toBe(200)
      expect(fixture.repository.latestSignupPaymentSession()?.released).not.toBe(true)
      expect(authState.clearPendingSignupPaymentRecovery).not.toHaveBeenCalled()
    } finally { view.unmount(); vi.useRealTimers(); await fixture.app.close() }
  })
})
