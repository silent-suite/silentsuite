import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'
import { formatAnnualOfferAmount } from '@/app/lib/annual-offer-presentation'
import type { AnnualOffer } from '@/app/lib/billing-v2'
import SubscriptionPage from '../page'

vi.mock('next/dynamic', () => ({ default: () => function MockStripePaymentForm() { return <div data-testid="stripe-payment-form" /> } }))
vi.mock('@silentsuite/ui', () => ({
  Button: ({ children, onClick, disabled, ...props }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled} {...props}>{children}</button>
  ),
}))
vi.mock('@/app/lib/config', () => ({ BILLING_API_URL: 'https://billing.test', ETEBASE_SERVER_URL: 'https://server.example.test' }))
vi.mock('@/app/lib/date', () => ({ formatDate: (date: Date) => date.toISOString().slice(0, 10) }))

const DAY = 86_400_000
const future = (days: number) => new Date(Date.now() + days * DAY).toISOString()
const past = (days: number) => new Date(Date.now() - days * DAY).toISOString()
const day = (iso: string) => iso.slice(0, 10)

const capabilities = {
  trialActive: false, trialExpired: false, needsPaymentMethod: false, canSetupCard: false,
  canStartPaidSubscription: false, canReactivate: false, canRetryPayment: false, canResumeCancellation: false,
}
const base = {
  plan: 'early_annual', planLabel: 'Early Adopter', billingInterval: 'annual', status: 'active',
  renewalDate: future(200), trial: { active: false, endsAt: null, daysRemaining: null },
  cancelAtPeriodEnd: false, trialPath: null, earlyAdopter: true, capabilities,
}

const offer: AnnualOffer = {
  planId: 'early_annual', customerClass: 'early', billingInterval: 'annual', annualAmountMinor: 3600,
  monthlyEquivalentMinor: 300, currency: 'EUR', providers: ['stripe', 'btcpay'], offerRevision: 1,
  offerToken: 'signed-offer', expiresAt: '2026-08-10T12:10:00Z',
}
const offerResponse = { contractVersion: 2, requestId: 'e91a6d70-0d4e-4352-9bdc-426d1f76d771', offer }
const price = `${formatAnnualOfferAmount(offer)} per year`

const BENEFIT = 'Keep your calendar, contacts and tasks syncing, end-to-end encrypted, in the web app and on Android.'
const numericalCountdown = /\d+\s+days?\s+(left|remaining)/i

type Reply = () => unknown
function route(subscription: Record<string, unknown> | Reply, offerReply: Reply = () => ({ ok: true, json: async () => offerResponse })) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'https://billing.test/subscription' && !init?.method) {
      return typeof subscription === 'function' ? subscription() : { ok: true, json: async () => ({ ...base, ...subscription }) }
    }
    if (url === 'https://billing.test/subscription/offers/v2?preview=1') return offerReply()
    if (url.startsWith('https://billing.test/subscription/payment-flows/current')) return { ok: true, json: async () => ({ flow: null }) }
    return { ok: false, status: 404, json: async () => ({}) }
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    offerReads: () => fetchMock.mock.calls.filter(([url]) => url === 'https://billing.test/subscription/offers/v2?preview=1').length,
    subscriptionReads: () => fetchMock.mock.calls.filter(([url]) => url === 'https://billing.test/subscription').length,
  }
}

function card() {
  const section = screen.getByRole('heading', { name: 'Subscription' }).closest('section')
  if (!section) throw new Error('subscription card missing')
  return section as HTMLElement
}

const endedTrialAt = past(10)
const endedTrial = {
  status: 'trialing', trialPath: '7day', renewalDate: endedTrialAt,
  trial: { active: false, endsAt: endedTrialAt, daysRemaining: null },
  capabilities: { ...capabilities, trialExpired: true, canStartPaidSubscription: true },
  hostedAccess: 'trial_ended',
  accountNotice: { kind: 'trial_ended', endedAt: endedTrialAt },
  billingDate: { kind: 'ended', at: endedTrialAt },
}

const runningNoCardEnd = future(2.5)
const runningNoCard = {
  status: 'trialing', trialPath: '7day', renewalDate: null,
  trial: { active: true, endsAt: runningNoCardEnd, daysRemaining: 3 },
  capabilities: { ...capabilities, trialActive: true, needsPaymentMethod: true, canSetupCard: true },
  accountNotice: { kind: 'trial_days_left', trialEndsAt: runningNoCardEnd, daysRemaining: 3 },
  billingDate: { kind: 'trial_ends', at: runningNoCardEnd },
}

describe('subscription card clarity', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/settings/subscription')
    useAuthStore.setState({ user: null, isAuthenticated: false })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it.each([
    ['renews', 'Renews on'],
    ['access_until', 'Access until'],
    ['first_charge', 'First payment'],
    ['trial_ends', 'Free trial ends'],
  ])('labels the date row from billingDate %s and never says Next billing', async (kind, label) => {
    const at = future(40)
    route({ billingDate: { kind, at } })
    render(<SubscriptionPage />)
    await screen.findByText('Plan')
    expect(within(card()).getByText(label)).toBeInTheDocument()
    expect(within(card()).getByText(day(at))).toBeInTheDocument()
    expect(screen.queryByText('Next billing')).not.toBeInTheDocument()
  })

  it('shows no date row when billingDate is null, rather than guessing from renewalDate', async () => {
    route({ billingDate: null })
    render(<SubscriptionPage />)
    await screen.findByText('Plan')
    expect(screen.queryByText(day(base.renewalDate))).not.toBeInTheDocument()
    expect(screen.queryByText('Next billing')).not.toBeInTheDocument()
  })

  it('ignores a malformed billingDate and notice instead of rendering them', async () => {
    route({ billingDate: { kind: 'renews', at: 'soon' }, accountNotice: { kind: 'trial_days_left', trialEndsAt: future(2), daysRemaining: 0 } })
    render(<SubscriptionPage />)
    await screen.findByText('Plan')
    expect(screen.queryByText('Renews on')).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(numericalCountdown)
  })

  it('keeps the access date and Reactivate for a cancelled subscription with time left', async () => {
    const until = future(20)
    route({
      status: 'cancelled', renewalDate: until, accountNotice: null,
      billingDate: { kind: 'access_until', at: until },
      capabilities: { ...capabilities, canReactivate: true },
    })
    render(<SubscriptionPage />)
    await screen.findByText('Plan')
    expect(within(card()).getByText('Access until')).toBeInTheDocument()
    expect(within(card()).getByText(day(until))).toBeInTheDocument()
    expect(within(card()).getByRole('button', { name: 'Reactivate' })).toBeInTheDocument()
  })

  it('shows Access until and never First payment for a cancelled card trial', async () => {
    const trialEnd = future(12)
    route({
      status: 'trialing', trialPath: '30day', renewalDate: trialEnd, cancelAtPeriodEnd: true,
      trial: { active: true, endsAt: trialEnd, daysRemaining: 12 },
      capabilities: { ...capabilities, trialActive: true },
      accountNotice: null, billingDate: { kind: 'access_until', at: trialEnd },
    })
    render(<SubscriptionPage />)
    await screen.findByText('Plan')
    expect(within(card()).getAllByText('Access until').length).toBeGreaterThan(0)
    expect(screen.queryByText('First payment')).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(numericalCountdown)
  })

  it.each([
    ['card trial', {
      status: 'trialing', trialPath: '30day', renewalDate: future(5),
      trial: { active: true, endsAt: future(5), daysRemaining: 5 },
      capabilities: { ...capabilities, trialActive: true },
      accountNotice: null, billingDate: { kind: 'first_charge', at: future(5) },
    }],
    ['older-server card trial', {
      status: 'trialing', trialPath: '30day', renewalDate: future(5),
      trial: { active: true, endsAt: future(5), daysRemaining: 5 },
      capabilities: { ...capabilities, trialActive: true },
    }],
    ['paid bonus', {
      status: 'active', trialPath: 'immediate',
      trial: { active: true, endsAt: future(10), daysRemaining: 10 },
      accountNotice: null, billingDate: { kind: 'renews', at: future(200) },
    }],
  ])('shows no numerical countdown anywhere on the page for a %s', async (_label, subscription) => {
    route(subscription)
    render(<SubscriptionPage />)
    await screen.findByText('Plan')
    expect(document.body).not.toHaveTextContent(numericalCountdown)
    expect(screen.queryByText('Next billing')).not.toBeInTheDocument()
  })

  it('keeps the bonus access row', async () => {
    const bonusEnd = future(10)
    route({ status: 'active', trialPath: 'immediate', trial: { active: true, endsAt: bonusEnd, daysRemaining: 10 }, billingDate: { kind: 'renews', at: future(200) } })
    render(<SubscriptionPage />)
    expect(await screen.findByText(`Included until ${day(bonusEnd)}`)).toBeInTheDocument()
  })

  it('makes an ended trial clear, with the price, the reason and Subscribe inside the card', async () => {
    const reads = route(endedTrial)
    render(<SubscriptionPage />)
    await screen.findByText('Plan')
    const section = card()
    expect(within(section).getByText('Your trial has ended.')).toBeInTheDocument()
    expect(screen.queryByText('Trialing')).not.toBeInTheDocument()
    expect(screen.queryByText('Next billing')).not.toBeInTheDocument()
    expect(within(section).getByText('Ended on')).toBeInTheDocument()
    expect(within(section).getByText(day(endedTrialAt))).toBeInTheDocument()
    expect(within(section).getByText('Your data is safe and read-only.')).toBeInTheDocument()
    expect(within(section).getByRole('link', { name: /export/i })).toHaveAttribute('href', '/settings/export')
    expect(within(section).getByText(BENEFIT)).toBeInTheDocument()
    const subscribe = within(section).getByRole('button', { name: 'Subscribe' })
    expect(subscribe).toHaveClass('w-full', 'sm:w-auto', 'min-h-11')
    expect(await within(section).findByText(price)).toBeInTheDocument()
    expect(reads.offerReads()).toBe(1)
  })

  it('never shows a past raw date as a renewal when the server sends no billingDate', async () => {
    route({ ...endedTrial, accountNotice: undefined, billingDate: undefined, hostedAccess: undefined })
    render(<SubscriptionPage />)
    await screen.findByText('Plan')
    expect(screen.queryByText('Next billing')).not.toBeInTheDocument()
    expect(screen.queryByText(day(endedTrialAt))).not.toBeInTheDocument()
  })

  it('says plainly when paid access has ended', async () => {
    const endedAt = past(3)
    route({
      status: 'expired', renewalDate: endedAt, accountNotice: { kind: 'access_ended', endedAt },
      billingDate: { kind: 'ended', at: endedAt }, capabilities: { ...capabilities, canStartPaidSubscription: true },
    })
    render(<SubscriptionPage />)
    await screen.findByText('Plan')
    expect(within(card()).getByText('Your subscription has ended.')).toBeInTheDocument()
    expect(within(card()).getByRole('button', { name: 'Subscribe' })).toBeInTheDocument()
  })

  it('puts the seven-day countdown and the add-card action inside the card', async () => {
    route(runningNoCard)
    render(<SubscriptionPage />)
    await screen.findByText('Plan')
    const section = card()
    expect(within(section).getByText('Free trial: 3 days left')).toBeInTheDocument()
    expect(within(section).getByText("No card on file, so you won't be charged.")).toBeInTheDocument()
    const choose = within(section).getByRole('button', { name: /choose payment/i })
    expect(choose).toHaveClass('w-full', 'min-h-11')
    expect(within(section).getByText(BENEFIT)).toBeInTheDocument()
    expect(await within(section).findByText(price)).toBeInTheDocument()
    expect(screen.queryByText('Trialing')).not.toBeInTheDocument()
  })

  it('omits the price but keeps the action when the signed offer cannot be read', async () => {
    const reads = route(endedTrial, () => ({ ok: false, status: 503, json: async () => ({ detail: 'unavailable' }) }))
    render(<SubscriptionPage />)
    await screen.findByText('Plan')
    await waitFor(() => expect(reads.offerReads()).toBe(1))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText(/per year/)).not.toBeInTheDocument()
    expect(within(card()).getByRole('button', { name: 'Subscribe' })).toBeInTheDocument()
  })

  it('drops an offer that resolves after the account changed', async () => {
    let release!: (value: unknown) => void
    const pending = new Promise(resolve => { release = resolve })
    const reads = route(endedTrial, () => pending)
    render(<SubscriptionPage />)
    await screen.findByText('Plan')
    await waitFor(() => expect(reads.offerReads()).toBe(1))
    act(() => { bumpAccountEpoch() })
    release({ ok: true, json: async () => offerResponse })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.queryByText(price)).not.toBeInTheDocument()
  })

  it.each([
    ['a healthy paid account', { billingDate: { kind: 'renews', at: future(200) } }],
    ['a payment retry', { status: 'none', renewalDate: null, capabilities: { ...capabilities, canRetryPayment: true } }],
  ])('reads no offer and shows no sales copy for %s', async (_label, subscription) => {
    const reads = route(subscription)
    render(<SubscriptionPage />)
    await screen.findByText('Plan')
    await act(async () => { await Promise.resolve() })
    expect(reads.offerReads()).toBe(0)
    expect(screen.queryByText(BENEFIT)).not.toBeInTheDocument()
    expect(screen.queryByText(/per year/)).not.toBeInTheDocument()
  })

  it('offers no second purchase action or offer read while a payment is confirming', async () => {
    window.history.replaceState({}, '', '/settings/subscription?payment_intent=pi_1&redirect_status=processing')
    const reads = route(runningNoCard)
    render(<SubscriptionPage />)
    expect(await screen.findByText(/confirming your payment/i)).toBeInTheDocument()
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('button', { name: /choose payment|subscribe/i })).not.toBeInTheDocument()
    expect(reads.offerReads()).toBe(0)
  })

  it('hides the Billing row when the plan name already says annual', async () => {
    route({ planLabel: 'Early Adopter Annual' })
    render(<SubscriptionPage />)
    await screen.findByText('Plan')
    expect(screen.queryByText('Billing')).not.toBeInTheDocument()
  })

  it('offers Try again after a failed load and refetches', async () => {
    let attempt = 0
    const reads = route(() => (++attempt === 1
      ? { ok: false, status: 503, json: async () => ({}) }
      : { ok: true, json: async () => base }))
    render(<SubscriptionPage />)
    expect(await screen.findByText('Unable to load subscription details.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Plan')).toBeInTheDocument()
    expect(reads.subscriptionReads()).toBe(2)
  })
})
