import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import PendingPaymentPage from '../page'

const authState = {
  completeSignup: vi.fn(),
  createEtebaseAccount: vi.fn(),
  finalizePaidSignup: vi.fn(),
  restoreSignupStateFromRedirect: vi.fn(() => null),
  pendingSignup: null,
}

vi.mock('@/app/stores/use-auth-store', () => {
  function useAuthStore<T>(selector: (state: typeof authState) => T): T {
    return selector(authState)
  }
  useAuthStore.getState = () => authState
  return { useAuthStore }
})

vi.mock('@/app/lib/config', () => ({ BILLING_API_URL: 'https://billing.test' }))
vi.mock('@/app/lib/signup-return', () => ({ normalizeSignupReturnTo: (value: string | null) => value }))
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a>,
}))

vi.mock('../components/step-create-vault', () => ({
  StepCreateVault: () => <div data-testid="step-create-vault" />,
}))
vi.mock('../components/step-create-paid-account', () => ({
  StepCreatePaidAccount: () => <div data-testid="step-create-paid-account" />,
}))

describe('PendingPaymentPage Bitcoin restart', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    sessionStorage.clear()
    vi.stubGlobal('location', { href: 'https://app.silentsuite.io/signup/pending-payment' })
  })

  it('restarts expired Bitcoin signup payments through canonical payment-flows', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://billing.test/subscription/crypto/invoice/latest') {
        return { ok: true, json: async () => ({ status: 'expired' }) } as Response
      }
      if (url === 'https://billing.test/subscription/payment-flows/current') {
        return { ok: true, json: async () => ({ flow: null }) } as Response
      }
      if (url === 'https://billing.test/subscription/payment-flows' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            checkoutUrl: 'https://btcpay.silentsuite.io/i/inv_restart',
            invoiceId: 'inv_restart',
            invoiceLookupToken: 'lookup_restart',
          }),
        } as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }))

    render(<PendingPaymentPage />)

    fireEvent.click(await screen.findByRole('button', { name: /start new bitcoin invoice/i }))

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      'https://billing.test/subscription/payment-flows',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({
          flowKind: 'btcpay_annual',
          planId: 'early_annual',
          returnUrl: '/signup/pending-payment',
        }),
      }),
    ))
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/subscription/crypto/checkout'), expect.anything())
    expect(sessionStorage.getItem('silentsuite-pending-crypto-invoice')).toBe('inv_restart')
    expect(sessionStorage.getItem('silentsuite-pending-crypto-token')).toBe('lookup_restart')
    expect(sessionStorage.getItem('silentsuite-signup-in-progress')).toBe('true')
  })

  it('fails closed when the current-flow lookup fails and only enables restart after retry succeeds', async () => {
    let currentFlowAttempts = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://billing.test/subscription/crypto/invoice/latest') {
        return { ok: true, json: async () => ({ status: 'expired' }) } as Response
      }
      if (url === 'https://billing.test/subscription/payment-flows/current') {
        currentFlowAttempts += 1
        if (currentFlowAttempts === 1) return { ok: false, status: 503, json: async () => ({}) } as Response
        return { ok: true, json: async () => ({ flow: null }) } as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }))

    render(<PendingPaymentPage />)

    expect(await screen.findByRole('button', { name: /retry payment status/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /start new bitcoin invoice/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /retry payment status/i }))
    expect(await screen.findByRole('button', { name: /start new bitcoin invoice/i })).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalledWith(
      'https://billing.test/subscription/payment-flows',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('requires explicit cancellation when an active payment flow exists', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://billing.test/subscription/crypto/invoice/latest') {
        return { ok: true, json: async () => ({ status: 'expired' }) } as Response
      }
      if (url === 'https://billing.test/subscription/payment-flows/current') {
        return { ok: true, json: async () => ({ flow: {
          flowKind: 'btcpay_annual',
          provider: 'btcpay',
          status: 'processing',
          cancellable: true,
          checkoutUrl: 'https://btcpay.silentsuite.io/i/inv_existing',
        } }) } as Response
      }
      if (url === 'https://billing.test/subscription/payment-flows/cancel' && init?.method === 'POST') {
        return { ok: true, json: async () => ({ cancelled: true }) } as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }))

    render(<PendingPaymentPage />)

    expect(await screen.findByText(/payment already in progress/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /continue bitcoin checkout/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /start new bitcoin invoice/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /cancel and start another invoice/i }))

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      'https://billing.test/subscription/payment-flows/cancel',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    ))
    expect(await screen.findByRole('button', { name: /start new bitcoin invoice/i })).toBeInTheDocument()
  })

  it('does not offer a new invoice after timeout when the current flow is still active', async () => {
    vi.useFakeTimers()
    sessionStorage.setItem('silentsuite-pending-crypto-invoice', 'inv_pending')
    sessionStorage.setItem('silentsuite-pending-crypto-token', 'lookup_pending')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://billing.test/subscription/crypto/invoice/inv_pending') {
        return { ok: true, json: async () => ({ status: 'pending', invoiceId: 'inv_pending' }) } as Response
      }
      if (url === 'https://billing.test/subscription/payment-flows/current') {
        return { ok: true, json: async () => ({ flow: {
          flowKind: 'btcpay_annual',
          provider: 'btcpay',
          status: 'processing',
          cancellable: true,
          checkoutUrl: 'https://btcpay.silentsuite.io/i/inv_pending',
        } }) } as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }))

    render(<PendingPaymentPage />)

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(screen.getByText(/still waiting for settlement/i)).toBeInTheDocument()
    expect(screen.getByText(/payment already in progress/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /check again/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /start new bitcoin invoice/i })).not.toBeInTheDocument()
    vi.useRealTimers()
  })
})
