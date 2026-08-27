import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import PaymentChoicePanel from '../payment-choice-panel'
import StripePaymentForm from '../stripe-payment-form'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED = 'true'
  process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ORIGIN = 'https://btcpay.test'
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_lifecycle'
})

const stripeMocks = vi.hoisted(() => ({
  confirmPayment: vi.fn(async () => ({ paymentIntent: { status: 'succeeded' } })),
  confirmSetup: vi.fn(async () => ({ setupIntent: { status: 'succeeded' } })),
}))

vi.mock('next/dynamic', () => ({
  default: () => (props: { returnPath?: string; mode?: string; submitLabel?: string }) => (
    <div
      data-testid="stripe-payment-form"
      data-return-path={props.returnPath ?? ''}
      data-mode={props.mode ?? ''}
      data-submit-label={props.submitLabel ?? ''}
    />
  ),
}))

vi.mock('@silentsuite/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}))

vi.mock('lucide-react', () => ({
  ArrowLeft: () => <svg />,
  Crown: () => <svg />,
  ExternalLink: () => <svg />,
  Lock: () => <svg />,
  Zap: () => <svg />,
}))

vi.mock('@/app/lib/config', () => ({ BILLING_API_URL: 'https://billing.example.test' }))

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }))

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: {
    getState: () => ({
      pendingSignup: null,
      user: { email: 'person@example.test' },
      saveSignupStateForRedirect: vi.fn(),
    }),
  },
}))

vi.mock('@stripe/stripe-js/pure', () => ({
  loadStripe: async () => ({ confirmPayment: stripeMocks.confirmPayment, confirmSetup: stripeMocks.confirmSetup }),
}))

vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <div data-testid="stripe-elements">{children}</div>,
  PaymentElement: ({ onReady }: { onReady: () => void }) => {
    React.useEffect(() => { onReady() }, [onReady])
    return <div data-testid="payment-element" />
  },
  useStripe: () => ({ confirmPayment: stripeMocks.confirmPayment, confirmSetup: stripeMocks.confirmSetup }),
  useElements: () => ({}),
}))

const COMPONENT_DIR = path.resolve(__dirname, '..')
const stripeFormSource = fs.readFileSync(path.join(COMPONENT_DIR, 'stripe-payment-form.tsx'), 'utf8')
const choicePanelSource = fs.readFileSync(path.join(COMPONENT_DIR, 'payment-choice-panel.tsx'), 'utf8')
const bitcoinPanelSource = fs.readFileSync(path.join(COMPONENT_DIR, 'bitcoin-payment-panel.tsx'), 'utf8')

const annualOffer = {
  contractVersion: 2,
  requestId: 'e91a6d70-0d4e-4352-9bdc-426d1f76d771',
  offer: {
    planId: 'early_annual', customerClass: 'early', billingInterval: 'annual', annualAmountMinor: 3600,
    monthlyEquivalentMinor: 300, currency: 'EUR', providers: ['stripe', 'btcpay'], offerRevision: 1,
    offerToken: 'signed-offer', expiresAt: '2026-08-10T12:10:00Z',
  },
}

const activation = {
  contractVersion: 2,
  checkoutIntentToken: 'A'.repeat(43),
  expiresAt: '2026-08-10T12:05:00Z',
  disclosure: {
    kind: 'charge_now', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: 3600,
    monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: null, firstChargeAt: null, cancelBy: null,
    cancelByInclusive: false, autoRenew: true, prepaid: false, refundWindowDays: 30, bonusDays: 14,
    periodEndRule: 'confirmation_bonus_then_1_utc_calendar_year', renewalAt: null, entitlementEndsAt: null,
  },
}

function response(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body } as Response
}

function mockBilling(cancel?: () => Promise<Response>, paymentFlow?: () => Promise<Response>) {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/subscription/payment-flows/current')) return response({ flow: null })
    if (url.endsWith('/subscription/offers/v2')) return response(annualOffer)
    if (url.endsWith('/subscription/offers/v2/activate')) return response(activation)
    if (url.endsWith('/subscription/payment-flows/v2')) {
      return paymentFlow?.() ?? response({ contractVersion: 2, kind: 'stripe', authorityId: annualOffer.requestId, clientSecret: 'pi_secret_value' })
    }
    if (url.endsWith('/subscription/payment-flows/cancel')) return cancel?.() ?? response({ cancelled: true, flowKind: 'stripe_pay_now' })
    if (url.includes('/subscription/crypto/invoice/')) {
      if (url.endsWith('/payment-methods')) {
        return response({ paymentMethods: [{ id: 'BTC', label: 'Bitcoin', qrValue: 'bitcoin:bc1qexample', address: 'bc1qexample', amountDue: '0.0004', cryptoCode: 'BTC' }] })
      }
      return response({ status: 'pending' })
    }
    return response({}, false)
  })
}

async function openCardAuthority() {
  const view = render(<PaymentChoicePanel onSuccess={vi.fn()} onCancel={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))
  fireEvent.click(await screen.findByRole('button', { name: /confirm annual terms and continue/i }))
  await screen.findByTestId('stripe-payment-form')
  return view
}

function cancellationCalls() {
  return vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith('/payment-flows/cancel'))
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  stripeMocks.confirmPayment.mockClear()
  stripeMocks.confirmSetup.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('payment lifecycle never cancels an authority implicitly', () => {
  it('makes no cancellation request when the card authority is unmounted', async () => {
    mockBilling()
    const view = await openCardAuthority()

    view.unmount()

    expect(cancellationCalls()).toHaveLength(0)
  })

  it.each(['pagehide', 'beforeunload', 'unload', 'visibilitychange'] as const)(
    'makes no cancellation request on %s while a card authority is displayed',
    async (eventName) => {
      mockBilling()
      await openCardAuthority()

      await act(async () => {
        window.dispatchEvent(new Event(eventName))
        document.dispatchEvent(new Event(eventName))
      })

      expect(cancellationCalls()).toHaveLength(0)
      expect(screen.getByTestId('stripe-payment-form')).toBeInTheDocument()
    },
  )

  it('makes no cancellation request when a Bitcoin authority is unmounted or the page is hidden', async () => {
    mockBilling(undefined, async () => response({
      contractVersion: 2, kind: 'btcpay', authorityId: annualOffer.requestId,
      checkoutUrl: 'https://btcpay.test/i/abc123', invoiceId: 'invoice-1', invoiceLookupToken: 'B'.repeat(43),
    }))
    const view = render(<PaymentChoicePanel onSuccess={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /pay .* with bitcoin for/i }))
    fireEvent.click(await screen.findByRole('button', { name: /confirm annual terms and continue/i }))
    await screen.findByRole('heading', { name: /pay .* annual with bitcoin/i })

    await act(async () => { window.dispatchEvent(new Event('pagehide')) })
    view.unmount()

    expect(cancellationCalls()).toHaveLength(0)
  })

  it('keeps the card authority mounted when an explicit cancellation fails', async () => {
    mockBilling(async () => response({ type: 'https://api.silentsuite.io/errors/provider-cancellation-failed' }, false, 502))
    await openCardAuthority()

    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel card payment and choose Bitcoin' })[0]!)

    await waitFor(() => expect(cancellationCalls()).toHaveLength(1))
    expect(screen.getByTestId('stripe-payment-form')).toBeInTheDocument()
  })

  it('clears the card authority only after an authoritative cancellation succeeds', async () => {
    mockBilling()
    await openCardAuthority()

    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel card payment and choose Bitcoin' })[0]!)

    await waitFor(() => expect(screen.queryByTestId('stripe-payment-form')).not.toBeInTheDocument())
    expect(cancellationCalls()).toHaveLength(1)
  })

  it('hands the Stripe form the same-origin settings return path and payment mode', async () => {
    mockBilling()
    await openCardAuthority()

    const form = screen.getByTestId('stripe-payment-form')
    expect(form).toHaveAttribute('data-return-path', '/settings/subscription')
    expect(form).toHaveAttribute('data-mode', 'payment')
    expect(form).toHaveAttribute('data-submit-label', 'Pay €36.00')
  })
})

describe('StripePaymentForm SCA and redirect behaviour', () => {
  it('confirms payments with a bounded same-origin return URL and redirect: if_required', async () => {
    render(<StripePaymentForm clientSecret="pi_secret_value" onSuccess={vi.fn()} mode="payment" returnPath="/settings/subscription" submitLabel="Pay €36.00" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Pay €36.00' }))

    await waitFor(() => expect(stripeMocks.confirmPayment).toHaveBeenCalledTimes(1))
    const [call] = stripeMocks.confirmPayment.mock.calls as unknown as [[{ confirmParams: { return_url: string }; redirect: string }]]
    expect(call[0].redirect).toBe('if_required')
    expect(call[0].confirmParams.return_url).toBe(`${window.location.origin}/settings/subscription`)
    expect(stripeMocks.confirmSetup).not.toHaveBeenCalled()
  })

  it('registers no page-lifecycle listeners and cancels nothing when unmounted mid-confirmation', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const windowSpy = vi.spyOn(window, 'addEventListener')
    const documentSpy = vi.spyOn(document, 'addEventListener')

    const view = render(<StripePaymentForm clientSecret="pi_secret_value" onSuccess={vi.fn()} mode="payment" returnPath="/settings/subscription" />)
    await screen.findByTestId('payment-element')
    view.unmount()

    const listened = [...windowSpy.mock.calls, ...documentSpy.mock.calls].map(([type]) => type)
    expect(listened).not.toContain('pagehide')
    expect(listened).not.toContain('beforeunload')
    expect(listened).not.toContain('unload')
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()

    windowSpy.mockRestore()
    documentSpy.mockRestore()
  })
})

describe('payment surface source guards', () => {
  it.each([
    ['stripe-payment-form.tsx', stripeFormSource],
    ['payment-choice-panel.tsx', choicePanelSource],
    ['bitcoin-payment-panel.tsx', bitcoinPanelSource],
  ] as const)('%s registers no page-lifecycle unload hooks', (_name, source) => {
    for (const hook of ['pagehide', 'beforeunload', "'unload'", 'visibilitychange']) {
      expect(source).not.toContain(hook)
    }
  })

  it('keeps the Stripe form free of any payment-flow cancellation call', () => {
    expect(stripeFormSource).not.toContain('payment-flows/cancel')
    expect(stripeFormSource).not.toContain('cancelPaymentFlow')
  })

  it('keeps both Stripe confirmations on redirect: if_required', () => {
    expect(stripeFormSource).toContain("stripe.confirmSetup({ elements, confirmParams, redirect: 'if_required' })")
    expect(stripeFormSource).toContain("stripe.confirmPayment({ elements, confirmParams, redirect: 'if_required' })")
  })

  it('keeps the PaymentElement readiness timeout bounded and cleaned up', () => {
    expect(stripeFormSource).toContain('window.setTimeout(')
    expect(stripeFormSource).toContain('}, 15_000)')
    expect(stripeFormSource).toContain('return () => window.clearTimeout(timer)')
  })

  it('builds the return URL through the shared same-origin helper', () => {
    expect(stripeFormSource).toContain('paymentReturnUrl(window.location.origin, returnPath, currentReturnTo)')
    expect(choicePanelSource).toContain('returnPath="/settings/subscription"')
  })

  it('clears the card client secret only on renewal or successful cancellation paths', () => {
    const clears = choicePanelSource.split('\n').filter((line) => line.includes('setClientSecret(null)'))
    expect(clears).toHaveLength(2)
  })

  it('never clears an error message after an authoritative current-flow lookup', () => {
    expect(choicePanelSource).not.toMatch(/await loadCurrentFlow\([^)]*\)\s*\n\s*setError\(null\)/)
  })

  it('re-proves the current flow through the shared authoritative lookup only', () => {
    const lookups = choicePanelSource.split('\n').filter((line) => line.includes('payment-flows/current'))
    expect(lookups).toHaveLength(1)
  })
})
