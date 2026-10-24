import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import PaymentChoicePanel from '../payment-choice-panel'
import { useAuthStore } from '@/app/stores/use-auth-store'

vi.mock('next/dynamic', () => ({
  default: () => () => <div data-testid="stripe-payment-form" />,
}))

vi.mock('@silentsuite/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}))

vi.mock('lucide-react', () => ({
  ArrowLeft: () => <svg />,
  ExternalLink: () => <svg />,
  Crown: () => <svg />,
  Lock: () => <svg />,
  Zap: () => <svg />,
}))

vi.mock('@/app/lib/config', () => ({
  BILLING_API_URL: 'https://billing.example.test',
  ETEBASE_SERVER_URL: 'https://server.example.test',
}))

const PROFILE = 'account_confirmation_rules_v1'
function cardDisclosure() {
  return {
    kind: 'charge_now', annualAmountMinor: 4800, firstChargeAmountMinor: 4800, renewalAmountMinor: 4800,
    monthlyEquivalentMinor: 400, currency: 'EUR', trialEndsAt: null, firstChargeAt: null, cancelBy: null, cancelByInclusive: false,
    autoRenew: true, prepaid: false, refundWindowDays: 30, bonusDays: 0, periodEndRule: PROFILE, renewalAt: null, entitlementEndsAt: null,
  }
}
const annualOffer = {
  contractVersion: 2,
  requestId: 'e91a6d70-0d4e-4352-9bdc-426d1f76d771',
  offer: {
    planId: 'standard_annual', customerClass: 'standard', billingInterval: 'annual', annualAmountMinor: 4800,
    monthlyEquivalentMinor: 400, currency: 'EUR', providers: ['stripe'], offerRevision: 1,
    offerToken: 'signed-offer', expiresAt: '2026-08-10T12:10:00Z',
  },
}
const validOffer = { ...annualOffer, accountTermsProfile: PROFILE, accountDisclosures: { stripe: cardDisclosure() } }
// HTTP 200 whose signed terms do not match the offered providers: not a valid offer.
const invalidDisclosureOffer = { ...annualOffer, accountTermsProfile: PROFILE, accountDisclosures: {} }
const activeFlow = { flowKind: 'stripe_pay_now', createdAt: '2026-08-10T12:00:00Z', cancellable: true, checkoutUrl: null }
const otherFlow = { flowKind: 'stripe_pay_now', createdAt: '2026-08-10T12:30:00Z', cancellable: false, checkoutUrl: null, status: 'provider_confirmed' }

const CURRENT_FAILED = 'The current payment state could not be confirmed. Do not start another payment yet; retry to check again.'
const OFFER_FAILED = 'No payment is in progress, but payment options could not be loaded. Retry to load current options.'

type Reply = Response | Promise<Response>
function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body } as Response
}

/** Serves each endpoint from its own queue; the last entry repeats. */
function serve(queues: { current: Array<() => Reply>; offer: Array<() => Reply>; cancel?: Array<() => Reply> }) {
  const calls = { current: 0, offer: 0, cancel: 0 }
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname
    const pick = (queue: Array<() => Reply>, key: keyof typeof calls) => queue[Math.min(calls[key]++, queue.length - 1)]!()
    if (path === '/subscription/payment-flows/current') return pick(queues.current, 'current')
    if (path === '/subscription/offers/v2') return pick(queues.offer, 'offer')
    if (path === '/subscription/payment-flows/cancel' && queues.cancel) return pick(queues.cancel, 'cancel')
    throw new Error(`unexpected request ${path}`)
  })
  return calls
}

function renderPanel() {
  const onCancel = vi.fn()
  const onDismissibilityChange = vi.fn()
  render(<PaymentChoicePanel onSuccess={vi.fn()} onCancel={onCancel} onDismissibilityChange={onDismissibilityChange} />)
  const dismissible = () => onDismissibilityChange.mock.calls.at(-1)?.[0]
  return { onCancel, dismissible }
}

const creationButtons = () => screen.queryAllByRole('button', { name: /Continue to card payment|Bitcoin, Lightning and Monero/ })

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals() })

describe('PaymentChoicePanel post-cancel verification', () => {
  it('treats an already-resolved cancellation like a cancel success and dismisses once after verification', async () => {
    const calls = serve({
      current: [() => response({}, 500), () => response({ flow: null })],
      offer: [() => response(validOffer)],
      cancel: [() => response({ cancelled: false, reason: 'no_active_flow' })],
    })
    const { onCancel } = renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel any payment in progress and close' }))

    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
    expect(calls.cancel).toBe(1)
    expect(calls.current).toBe(2)
    expect(calls.offer).toBe(2)
    expect(screen.queryByText('Could not cancel the pending payment flow.')).toBeNull()
  })

  it('dismisses exactly once after a first successful cancellation is verified', async () => {
    const calls = serve({
      current: [() => response({}, 500), () => response({ flow: null })],
      offer: [() => response(validOffer)],
      cancel: [() => response({ cancelled: true, flowKind: 'stripe_pay_now' })],
    })
    const { onCancel } = renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel any payment in progress and close' }))

    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(calls.cancel).toBe(1)
  })

  it('treats HTTP 200 with invalid disclosures as failed offers: no creation, no implicit dismissal, explicit retry re-verifies', async () => {
    const calls = serve({
      current: [() => response({}, 500), () => response({ flow: null })],
      offer: [() => response(validOffer), () => response(invalidDisclosureOffer), () => response(validOffer)],
      cancel: [() => response({ cancelled: true, flowKind: 'stripe_pay_now' })],
    })
    const { onCancel, dismissible } = renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel any payment in progress and close' }))

    expect(await screen.findByText(OFFER_FAILED)).toBeTruthy()
    expect(onCancel).not.toHaveBeenCalled()
    expect(creationButtons()).toHaveLength(0)
    expect(dismissible()).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel any payment in progress and close' }))
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
    expect(calls.cancel).toBe(1)
    expect(calls.offer).toBe(3)
    expect(calls.current).toBe(3)
  })

  it('reports an unconfirmed current state after cancellation without claiming it completed', async () => {
    const calls = serve({
      current: [() => response({}, 500), () => response({}, 503), () => response({ flow: null })],
      offer: [() => response(validOffer)],
      cancel: [() => response({ cancelled: true, flowKind: 'stripe_pay_now' })],
    })
    const { onCancel, dismissible } = renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel any payment in progress and close' }))

    expect(await screen.findByText(CURRENT_FAILED)).toBeTruthy()
    expect(onCancel).not.toHaveBeenCalled()
    expect(creationButtons()).toHaveLength(0)
    expect(dismissible()).toBe(false)
    expect(screen.queryByText(/cancelled/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel any payment in progress and close' }))
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
    expect(calls.cancel).toBe(1)
    expect(calls.current).toBe(3)
  })

  it('displays a different present flow after cancellation and never dismisses it', async () => {
    serve({
      current: [() => response({}, 500), () => response({ flow: otherFlow })],
      offer: [() => response(validOffer)],
      cancel: [() => response({ cancelled: true, flowKind: 'stripe_pay_now' })],
    })
    const { onCancel, dismissible } = renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel any payment in progress and close' }))

    expect(await screen.findByRole('heading', { name: 'Payment already in progress' })).toBeTruthy()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(onCancel).not.toHaveBeenCalled()
    expect(dismissible()).toBe(false)
    expect(creationButtons()).toHaveLength(0)
  })

  function deferred() {
    let resolve!: (value: Response) => void
    const promise = new Promise<Response>(done => { resolve = done })
    return { promise, resolve }
  }

  it.each([
    ['newer failure then stale success', 'invalid', 'valid'],
    ['stale failure then newer success', 'valid', 'invalid'],
  ] as const)('ignores a stale verification result (%s)', async (label, newest, stale) => {
    const older = deferred()
    const newer = deferred()
    const calls = serve({
      current: [() => response({}, 500), () => response({ flow: null })],
      offer: [() => response(validOffer), () => response(invalidDisclosureOffer), () => older.promise, () => newer.promise],
      cancel: [() => response({ cancelled: true, flowKind: 'stripe_pay_now' })],
    })
    const { onCancel, dismissible } = renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel any payment in progress and close' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry current annual offer' }))
    await waitFor(() => expect(calls.offer).toBe(3))
    fireEvent.click(screen.getByRole('button', { name: 'Retry current annual offer' }))
    await waitFor(() => expect(calls.offer).toBe(4))
    const reply = (kind: 'valid' | 'invalid') => response(kind === 'valid' ? validOffer : invalidDisclosureOffer)

    if (label === 'newer failure then stale success') {
      await act(async () => { newer.resolve(reply(newest)); await newer.promise })
      expect(await screen.findByText(OFFER_FAILED)).toBeTruthy()
      await act(async () => { older.resolve(reply(stale)); await older.promise; await new Promise(resolve => setTimeout(resolve, 20)) })
      expect(dismissible()).toBe(false)
      expect(creationButtons()).toHaveLength(0)
      expect(screen.getByText(OFFER_FAILED)).toBeTruthy()
    } else {
      await act(async () => { older.resolve(reply(stale)); await older.promise; await new Promise(resolve => setTimeout(resolve, 20)) })
      // The newer verification is still pending: nothing published, nothing cleared.
      expect(screen.queryByText(OFFER_FAILED)).toBeNull()
      expect(screen.getAllByRole('button', { name: 'Checking current payment...' }).length).toBeGreaterThan(0)
      expect(dismissible()).toBe(false)
      expect(creationButtons()).toHaveLength(0)
      await act(async () => { newer.resolve(reply(newest)); await newer.promise; await new Promise(resolve => setTimeout(resolve, 20)) })
      expect(dismissible()).toBe(true)
      expect(creationButtons().length).toBeGreaterThan(0)
    }
    expect(onCancel).not.toHaveBeenCalled()
    expect(calls.cancel).toBe(1)
  })

  it('publishes nothing and never dismisses when the account changes during post-cancel verification', async () => {
    const pendingCurrent = deferred()
    const calls = serve({
      current: [() => response({}, 500), () => pendingCurrent.promise],
      offer: [() => response(validOffer)],
      cancel: [() => response({ cancelled: true, flowKind: 'stripe_pay_now' })],
    })
    const { onCancel, dismissible } = renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel any payment in progress and close' }))
    await waitFor(() => expect(calls.current).toBe(2))

    act(() => { useAuthStore.setState({ user: { id: 'other-account', email: '', planId: 'free', isAdmin: false, onboardedAt: null } }) })
    await act(async () => { pendingCurrent.resolve(response({ flow: null })); await pendingCurrent.promise; await new Promise(resolve => setTimeout(resolve, 20)) })

    expect(onCancel).not.toHaveBeenCalled()
    expect(dismissible()).toBe(false)
    expect(creationButtons()).toHaveLength(0)
    expect(screen.getByText(/Payment account changed/)).toBeTruthy()
    act(() => { useAuthStore.setState({ user: null }) })
  })

  // An older, still-valid early offer (€36) that the initial loader may deliver late.
  const olderEarlyOffer = {
    contractVersion: 2,
    requestId: '3c0b9f6e-2a41-4d7c-8e95-6b1f2a7d9c30',
    offer: { ...annualOffer.offer, planId: 'early_annual', customerClass: 'early', annualAmountMinor: 3600, monthlyEquivalentMinor: 300, providers: ['stripe', 'btcpay'], offerToken: 'signed-offer-older' },
    accountTermsProfile: PROFILE,
    accountDisclosures: {
      stripe: { ...cardDisclosure(), annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: 3600, monthlyEquivalentMinor: 300 },
      btcpay: { ...cardDisclosure(), kind: 'prepaid', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: null, monthlyEquivalentMinor: 300, autoRenew: false, prepaid: true },
    },
  }
  const lateInitial = {
    'older success': () => response(olderEarlyOffer),
    'invalid disclosures': () => response(invalidDisclosureOffer),
    error: () => response({ type: 'https://api.silentsuite.io/errors/offer-unavailable', status: 503 }, 503),
  } as const

  it.each(Object.keys(lateInitial) as Array<keyof typeof lateInitial>)('ignores a late initial offer (%s) delivered after the joint verdict', async (late) => {
    const initial = deferred()
    serve({
      current: [() => response({ flow: activeFlow }), () => response({ flow: null })],
      offer: [() => initial.promise, () => response(validOffer)],
      cancel: [() => response({ cancelled: true, flowKind: 'stripe_pay_now' })],
    })
    const { onCancel, dismissible } = renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel card payment' }))
    expect(await screen.findByRole('button', { name: /Continue to card payment/ })).toBeTruthy()
    expect(dismissible()).toBe(true)

    await act(async () => { initial.resolve(lateInitial[late]()); await initial.promise; await new Promise(resolve => setTimeout(resolve, 20)) })

    expect(screen.getByRole('button', { name: /Continue to card payment/ })).toBeTruthy()
    expect(screen.getByText(/^€48\.00\/year/)).toBeTruthy()
    expect(screen.queryByText(/€36\.00\/year/)).toBeNull()
    expect(screen.queryByText('Payment options are temporarily unavailable.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry current annual offer' })).toBeNull()
    expect(dismissible()).toBe(true)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it.each(Object.keys(lateInitial) as Array<keyof typeof lateInitial>)('keeps a pending joint verification when a late initial offer (%s) arrives first', async (late) => {
    const initial = deferred()
    const verifying = deferred()
    serve({
      current: [() => response({ flow: activeFlow }), () => response({ flow: null })],
      offer: [() => initial.promise, () => verifying.promise],
      cancel: [() => response({ cancelled: true, flowKind: 'stripe_pay_now' })],
    })
    const { dismissible } = renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel card payment' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Checking current payment...' }).length).toBeGreaterThan(0))

    await act(async () => { initial.resolve(lateInitial[late]()); await initial.promise; await new Promise(resolve => setTimeout(resolve, 20)) })
    // Still pending: the stale loader published no terms, failure or loaded state.
    expect(screen.queryByText(/€36\.00\/year/)).toBeNull()
    expect(screen.queryByText('Payment options are temporarily unavailable.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry current annual offer' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Checking current payment...' }).length).toBeGreaterThan(0)
    expect(dismissible()).toBe(false)

    await act(async () => { verifying.resolve(response(validOffer)); await verifying.promise; await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(screen.getByRole('button', { name: /Continue to card payment/ })).toBeTruthy()
    expect(screen.getByText(/^€48\.00\/year/)).toBeTruthy()
    expect(dismissible()).toBe(true)
  })

  const unavailable = () => response({ type: 'https://api.silentsuite.io/errors/offer-unavailable', status: 503 }, 503)
  it.each([
    ['current-failed', 'Retry payment status', true, [() => response({}, 503)], []],
    ['current-failed', 'Retry payment status', false, [() => response({}, 503), () => response({}, 503)], []],
    ['invalid-disclosure offer-failed', 'Retry current annual offer', true, [], [() => response(invalidDisclosureOffer)]],
    ['invalid-disclosure offer-failed', 'Retry current annual offer', false, [], [() => response(invalidDisclosureOffer), () => response(invalidDisclosureOffer)]],
    ['unavailable offer-failed', 'Retry current annual offer', true, [], [unavailable]],
    ['unavailable offer-failed', 'Retry current annual offer', false, [], [unavailable, unavailable]],
    ['flow-present', 'Check payment status', true, [() => response({ flow: otherFlow })], []],
    ['flow-present', 'Check payment status', false, [() => response({ flow: otherFlow }), () => response({ flow: otherFlow })], []],
  ] as const)('restarts the joint verification from a %s verdict via "%s" (recovers=%s)', async (_verdict, retry, recovers, currentAfterCancel, offerAfterCancel) => {
    const calls = serve({
      current: [() => response({}, 500), ...currentAfterCancel, () => response({ flow: null })],
      offer: [() => response(validOffer), ...offerAfterCancel, () => response(validOffer)],
      cancel: [() => response({ cancelled: true, flowKind: 'stripe_pay_now' })],
    })
    const { onCancel, dismissible } = renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel any payment in progress and close' }))
    const retryButton = await screen.findByRole('button', { name: retry })
    const before = { current: calls.current, offer: calls.offer }
    expect(dismissible()).toBe(false)

    fireEvent.click(retryButton)

    await waitFor(() => expect({ current: calls.current, offer: calls.offer }).toEqual({ current: before.current + 1, offer: before.offer + 1 }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(onCancel).not.toHaveBeenCalled()
    expect(calls.cancel).toBe(1)
    if (recovers) {
      expect(dismissible()).toBe(true)
      expect(creationButtons().length).toBeGreaterThan(0)
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(onCancel).toHaveBeenCalledTimes(1)
    } else {
      expect(dismissible()).toBe(false)
      expect(creationButtons()).toHaveLength(0)
    }
  })
})
