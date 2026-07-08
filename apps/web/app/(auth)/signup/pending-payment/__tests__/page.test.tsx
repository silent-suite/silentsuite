import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
})
