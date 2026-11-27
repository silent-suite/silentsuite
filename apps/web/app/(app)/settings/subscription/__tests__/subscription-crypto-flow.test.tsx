import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { renderWithIntl as render } from '@/src/__tests__/render-with-intl'
import SubscriptionPage from '../page'

vi.mock('next/dynamic', () => ({ default: () => function MockStripePaymentForm() { return <div data-testid="stripe-payment-form" /> } }))
vi.mock('@silentsuite/ui', () => ({
  Button: ({ children, onClick, disabled, ...props }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled} {...props}>{children}</button>
  ),
}))
vi.mock('@/app/lib/config', () => ({ BILLING_API_URL: 'https://billing.test', ETEBASE_SERVER_URL: 'https://server.example.test' }))
vi.mock('@/app/lib/date', () => ({ formatDate: (date: Date) => date.toISOString().slice(0, 10) }))

const CURRENT_FLOW = 'https://billing.test/subscription/payment-flows/current?preview=1'
const NOTICE = 'You have a cryptocurrency payment in progress.'

const capabilities = {
  trialActive: false, trialExpired: false, needsPaymentMethod: false, canSetupCard: false,
  canStartPaidSubscription: false, canReactivate: true, canRetryPayment: false, canResumeCancellation: false,
}
const endedSubscription = {
  plan: 'early_annual', planLabel: 'Early Adopter', billingInterval: 'annual', status: 'expired',
  renewalDate: null, trial: { active: false, endsAt: null, daysRemaining: null },
  cancelAtPeriodEnd: false, trialPath: null, earlyAdopter: true, capabilities,
}
const cryptoFlow = {
  flowKind: 'btcpay_annual', createdAt: '2026-11-20T10:00:00.000Z', cancellable: true,
  checkoutUrl: null, status: 'pending_provider_flow', authorityId: null, disclosure: null,
}

function route(flowReply: () => unknown) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'https://billing.test/subscription' && !init?.method) return { ok: true, json: async () => endedSubscription }
    if (url === CURRENT_FLOW) return flowReply()
    return { ok: false, status: 404, json: async () => ({}) }
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    writes: () => fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET'),
    flowReads: () => fetchMock.mock.calls.filter(([url]) => url === CURRENT_FLOW).length,
  }
}

async function card() {
  const section = (await screen.findByRole('heading', { name: 'Subscription' })).closest('section')
  if (!section) throw new Error('subscription card missing')
  return section as HTMLElement
}

describe('subscription card: open cryptocurrency payment', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/settings/subscription')
    useAuthStore.setState({ user: null, isAuthenticated: false })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('says so on the card with a read-only status read, and opens the existing dialog', async () => {
    const calls = route(() => ({ ok: true, json: async () => ({ flow: cryptoFlow }) }))
    render(<SubscriptionPage />)

    expect(await within(await card()).findByText(NOTICE)).toBeInTheDocument()
    // The card itself offers no resume or cancel control and writes nothing.
    expect(within(await card()).queryByRole('button', { name: /resume|cancel/i })).not.toBeInTheDocument()
    expect(calls.writes()).toHaveLength(0)

    fireEvent.click(within(await card()).getByRole('button', { name: 'View payment' }))
    const dialog = await screen.findByRole('dialog', { name: /choose how to pay/i })
    expect(await within(dialog).findByText('Payment already in progress')).toBeInTheDocument()
    expect(calls.writes()).toHaveLength(0)
  })

  it.each([
    ['no payment in progress', () => ({ ok: true, json: async () => ({ flow: null }) })],
    ['a card payment', () => ({ ok: true, json: async () => ({ flow: { ...cryptoFlow, flowKind: 'stripe_pay_now' } }) })],
    ['a failed status read', () => ({ ok: false, status: 503, json: async () => ({}) })],
    ['a malformed reply', () => ({ ok: true, json: async () => { throw new Error('bad json') } })],
    // Review fix SIGNUP-06: the dialog's validator rejects a flow without createdAt and cancellable.
    ['a crypto flow kind with nothing else', () => ({ ok: true, json: async () => ({ flow: { flowKind: 'btcpay_annual' } }) })],
    ['a crypto flow without createdAt', () => ({ ok: true, json: async () => ({ flow: { ...cryptoFlow, createdAt: '' } }) })],
  ])('shows no line for %s', async (_label, reply) => {
    const calls = route(reply)
    render(<SubscriptionPage />)
    await within(await card()).findByRole('button', { name: 'Reactivate' })
    await waitFor(() => expect(calls.flowReads()).toBeGreaterThan(0))
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'View payment' })).not.toBeInTheDocument()
  })
})
