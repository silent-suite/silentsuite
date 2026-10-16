import { checkoutIntentToken as signedCheckoutIntent } from '@/src/__tests__/fixtures/annual-authority'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import PaymentChoicePanel from '../payment-choice-panel'

vi.mock('next/dynamic', () => ({
  default: () => ({ submitLabel }: { submitLabel?: string }) => <div data-testid="stripe-payment-form" data-submit-label={submitLabel} />,
}))

vi.mock('@silentsuite/ui', () => ({
  Button: ({ children, variant = 'default', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => <button data-variant={variant} {...props}>{children}</button>,
}))

vi.mock('lucide-react', () => ({
  // BitcoinPaymentPanel renders now that a Bitcoin choice goes straight to the invoice.
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

const annualOffer = {
  contractVersion: 2,
  requestId: 'e91a6d70-0d4e-4352-9bdc-426d1f76d771',
  offer: {
    planId: 'early_annual',
    customerClass: 'early',
    billingInterval: 'annual',
    annualAmountMinor: 3600,
    monthlyEquivalentMinor: 300,
    currency: 'EUR',
    providers: ['stripe', 'btcpay'],
    offerRevision: 1,
    offerToken: 'signed-offer',
    expiresAt: '2026-08-10T12:10:00Z',
  },
}

// Billing mints the payment flow id server-side; it never equals the offer requestId.
const serverFlowId = '6d1f0a94-8c52-4b7e-9f31-2a5d6e8b0c47'

const activeFlow = {
  flowKind: 'stripe_pay_now',
  provider: 'stripe',
  status: 'processing',
  planId: 'early_annual',
  amount: '36.00',
  currency: 'EUR',
  createdAt: '2026-08-10T12:00:00Z',
  cancellable: true,
}

// The account panel reads the opt-in preview, which
// carries the exact signed terms per provider before any choice is made.
const PROFILE = 'account_confirmation_rules_v1'
function cardDisclosure(annualAmountMinor = 3600, monthlyEquivalentMinor = 300) {
  return {
    kind: 'charge_now', annualAmountMinor, firstChargeAmountMinor: annualAmountMinor, renewalAmountMinor: annualAmountMinor,
    monthlyEquivalentMinor, currency: 'EUR', trialEndsAt: null, firstChargeAt: null, cancelBy: null, cancelByInclusive: false,
    autoRenew: true, prepaid: false, refundWindowDays: 30, bonusDays: 0, periodEndRule: PROFILE, renewalAt: null, entitlementEndsAt: null,
  }
}
const bitcoinDisclosure = { ...cardDisclosure(), kind: 'prepaid', renewalAmountMinor: null, autoRenew: false, prepaid: true }
const previewOffer = { ...annualOffer, accountTermsProfile: PROFILE, accountDisclosures: { stripe: cardDisclosure(), btcpay: bitcoinDisclosure } }
const standardOffer = {
  ...annualOffer,
  offer: { ...annualOffer.offer, planId: 'standard_annual', customerClass: 'standard', annualAmountMinor: 4800, monthlyEquivalentMinor: 400, providers: ['stripe'] },
}
const standardPreview = { ...standardOffer, accountTermsProfile: PROFILE, accountDisclosures: { stripe: cardDisclosure(4800, 400) } }
const historicalBonusDisclosure = { ...cardDisclosure(), bonusDays: 14, periodEndRule: 'confirmation_bonus_then_1_utc_calendar_year' }
const UNAVAILABLE = 'Payment options are temporarily unavailable.'

/** Routes on path so the opt-in `?preview=1` query never changes which mock answers. */
function route(input: RequestInfo | URL) {
  const url = new URL(String(input))
  return { path: url.pathname, preview: url.searchParams.get('preview') === '1' }
}

function activation(disclosure: unknown) {
  return response({ contractVersion: 2, checkoutIntentToken: signedCheckoutIntent, expiresAt: '2026-08-10T12:05:00Z', disclosure })
}

function called(path: string) {
  return vi.mocked(fetch).mock.calls.filter(([input]) => route(input).path === path)
}

function response(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body } as Response
}

function renderPanel(onCancel = vi.fn()) {
  render(<PaymentChoicePanel onSuccess={vi.fn()} onCancel={onCancel} />)
  return onCancel
}

/** The Bitcoin choice exists only with crypto checkout enabled at module load. */
async function bitcoinEnabledPanel() {
  vi.stubEnv('NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED', 'true')
  vi.stubEnv('NEXT_PUBLIC_BTCPAY_CHECKOUT_ORIGIN', 'https://btcpay.test')
  vi.resetModules()
  return (await import('../payment-choice-panel')).default
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('PaymentChoicePanel direct progression with terms before choice', () => {
  it('uses matching primary choices without the rejected payment boilerplate', async () => {
    const BitcoinPanel = await bitcoinEnabledPanel()
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: null })
      if (path === '/subscription/offers/v2') return response(previewOffer)
      return response({}, false)
    })
    render(<BitcoinPanel onSuccess={vi.fn()} onCancel={vi.fn()} />)
    const crypto = await screen.findByRole('button', { name: /pay .* with bitcoin, lightning and monero/i })
    const card = screen.getByRole('button', { name: /continue to card payment/i })
    expect(crypto).toHaveAttribute('data-variant', 'default')
    expect(card).toHaveAttribute('data-variant', 'default')
    expect(crypto.className).toBe(card.className)
    expect(screen.queryByRole('heading', { name: 'Pay now' })).not.toBeInTheDocument()
    expect(screen.queryByText(/server-authorized|server-owned|conversion bonus|current subscription period|refund window/i)).not.toBeInTheDocument()
    expect(screen.getByText('€36.00 now · renews at €36.00/year until cancelled.')).toBeInTheDocument()
    expect(screen.getByText('€36.00 for one year · no automatic renewal.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('data-variant', 'outline')
    expect(called('/subscription/offers/v2/activate')).toHaveLength(0)
    expect(called('/subscription/payment-flows/v2')).toHaveLength(0)
  })

  it('replaces the verbose inline card paragraph with compact frozen payment terms', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: { ...activeFlow, authorityId: serverFlowId, disclosure: cardDisclosure(4800, 400) } })
      if (path === '/subscription/offers/v2') return response(previewOffer)
      if (path === '/subscription/payment-flows/v2/resume') return response({ contractVersion: 2, kind: 'stripe', authorityId: serverFlowId, clientSecret: 'pi_resumed', disclosure: cardDisclosure(4800, 400) })
      return response({}, false)
    })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /resume card payment/i }))
    expect(await screen.findByTestId('stripe-payment-form')).toHaveAttribute('data-submit-label', 'Pay €48.00')
    expect(screen.queryByText(/conversion bonus|refund window|early_annual|standard_annual/)).not.toBeInTheDocument()
    expect(screen.getByText('€48.00 now · renews at €48.00/year until cancelled.')).toBeInTheDocument()
    expect(called('/subscription/offers/v2/activate')).toHaveLength(0)
    expect(called('/subscription/payment-flows/v2')).toHaveLength(0)
  })

  it('shows compact signed card terms before the choice and goes straight to the card form', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: null })
      if (path === '/subscription/offers/v2') return response(preview ? previewOffer : annualOffer)
      if (path === '/subscription/offers/v2/activate') return activation(cardDisclosure())
      if (path === '/subscription/payment-flows/v2') return response({ contractVersion: 2, kind: 'stripe', authorityId: serverFlowId, clientSecret: 'pi_secret' })
      return response({}, false)
    })
    renderPanel()
    expect(await screen.findByText('€36.00 now · renews at €36.00/year until cancelled.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Pay now' })).not.toBeInTheDocument()
    expect(screen.queryByText(/14 bonus days/i)).not.toBeInTheDocument()
    expect(called('/subscription/offers/v2/activate')).toHaveLength(0)
    expect(called('/subscription/payment-flows/v2')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: /continue to card payment/i }))
    expect(await screen.findByTestId('stripe-payment-form')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /confirm annual terms/i })).not.toBeInTheDocument()
    expect(JSON.parse(String(called('/subscription/offers/v2/activate')[0]![1]!.body))).toMatchObject({ provider: 'stripe', termsProfile: PROFILE })
    expect(called('/subscription/payment-flows/v2')).toHaveLength(1)
    expect(screen.queryByText(/14 bonus days are included/i)).not.toBeInTheDocument()
  })

  it('goes straight to the Bitcoin invoice after the choice (owner: it should straight go in there)', async () => {
    const BitcoinPanel = await bitcoinEnabledPanel()
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: null })
      if (path === '/subscription/offers/v2') return response(preview ? previewOffer : annualOffer)
      if (path === '/subscription/offers/v2/activate') return activation(bitcoinDisclosure)
      if (path === '/subscription/payment-flows/v2') return response({ contractVersion: 2, kind: 'btcpay', authorityId: serverFlowId, checkoutUrl: 'https://btcpay.test/i/abc123', invoiceId: 'invoice-1', invoiceLookupToken: 'lookup-token' })
      return response({}, false)
    })
    render(<BitcoinPanel onSuccess={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByText('€36.00 for one year · no automatic renewal.')).toBeInTheDocument()
    expect(screen.queryByText(/paid or free trial/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /pay .* with bitcoin, lightning and monero/i }))
    await waitFor(() => expect(called('/subscription/payment-flows/v2')).toHaveLength(1))
    expect(screen.queryByRole('heading', { name: /confirm annual terms/i })).not.toBeInTheDocument()
    expect(JSON.parse(String(called('/subscription/offers/v2/activate')[0]![1]!.body))).toMatchObject({ provider: 'btcpay', termsProfile: PROFILE })
    expect(screen.queryByText(/your 14 bonus days/i)).not.toBeInTheDocument()
  })

  it('renders Standard terms from the signed amounts, not a fixed €36', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: null })
      if (path === '/subscription/offers/v2') return response(preview ? standardPreview : standardOffer)
      return response({}, false)
    })
    renderPanel()
    expect(await screen.findByText('€48.00 now · renews at €48.00/year until cancelled.')).toBeInTheDocument()
    expect(screen.queryByText(/€36\.00 now/i)).not.toBeInTheDocument()
  })

  it.each([
    ['no account profile (B1 or older Billing)', annualOffer],
    ['an unknown profile', { ...previewOffer, accountTermsProfile: 'other_rules_v9' }],
    ['a missing Bitcoin disclosure for an offered provider', { ...previewOffer, accountDisclosures: { stripe: cardDisclosure() } }],
    ['a disclosure amount that disagrees with the offer', { ...previewOffer, accountDisclosures: { stripe: cardDisclosure(4800, 400), btcpay: bitcoinDisclosure } }],
  ] as const)('fails closed before activation when the preview has %s', async (_name, previewBody) => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: null })
      if (path === '/subscription/offers/v2') return response(preview ? previewBody : annualOffer)
      if (path === '/subscription/offers/v2/activate') return activation(cardDisclosure())
      return response({}, false)
    })
    renderPanel()
    expect(await screen.findByText(UNAVAILABLE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /continue to card payment/i })).not.toBeInTheDocument()
    expect(called('/subscription/offers/v2/activate')).toHaveLength(0)
  })

  it('does not start when a stale preview meets B1 refusing the profile', async () => {
    let offerReads = 0
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: null })
      if (path === '/subscription/offers/v2') {
        offerReads += 1
        return response(preview && offerReads === 1 ? previewOffer : annualOffer)
      }
      if (path === '/subscription/offers/v2/activate') return response({ detail: 'The selected annual checkout is unavailable.', type: 'https://api.silentsuite.io/errors/plan-not-purchasable' }, false, 409)
      return response({}, false)
    })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))
    expect(await screen.findByText(UNAVAILABLE)).toBeInTheDocument()
    expect(called('/subscription/payment-flows/v2')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /continue to card payment/i })).not.toBeInTheDocument()
  })

  it('does not start when the activation disclosure differs from the terms shown before the choice', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: null })
      if (path === '/subscription/offers/v2') return response(preview ? previewOffer : annualOffer)
      if (path === '/subscription/offers/v2/activate') return activation(historicalBonusDisclosure)
      if (path === '/subscription/payment-flows/v2') return response({ contractVersion: 2, kind: 'stripe', authorityId: serverFlowId, clientSecret: 'pi_secret' })
      return response({}, false)
    })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))
    expect(await screen.findByText(UNAVAILABLE)).toBeInTheDocument()
    expect(called('/subscription/payment-flows/v2')).toHaveLength(0)
    expect(screen.queryByTestId('stripe-payment-form')).not.toBeInTheDocument()
  })

  // After a failed start the same owned authority must be resumable,
  // and switching provider must stay reachable through its cancellation.
  const ownedFlow = { ...activeFlow, status: 'provider_creation_reconciling', authorityId: serverFlowId, disclosure: cardDisclosure() }
  function resumeMock(firstFlow: unknown) {
    let currentReads = 0
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: currentReads++ === 0 ? firstFlow : ownedFlow })
      if (path === '/subscription/offers/v2') return response(preview ? previewOffer : annualOffer)
      if (path === '/subscription/offers/v2/activate') return activation(cardDisclosure())
      if (path === '/subscription/payment-flows/v2') return response({ detail: 'Payment provider confirmation is pending. Retry the same payment flow.', type: 'https://api.silentsuite.io/errors/provider-unavailable' }, false, 503)
      if (path === '/subscription/payment-flows/v2/resume') return response({ contractVersion: 2, kind: 'stripe', authorityId: serverFlowId, clientSecret: 'pi_resumed', disclosure: cardDisclosure() })
      return response({}, false)
    })
  }

  it('offers resume and cancel-and-switch for the same authority after a failed start', async () => {
    resumeMock(null)
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))

    const resume = await screen.findByRole('button', { name: /resume card payment/i })
    expect(screen.getByRole('button', { name: 'Cancel card payment' })).toBeInTheDocument()
    fireEvent.click(resume)
    await waitFor(() => expect(called('/subscription/payment-flows/v2/resume')).toHaveLength(1))
    expect(JSON.parse(String(called('/subscription/payment-flows/v2/resume')[0]![1]!.body))).toEqual({ contractVersion: 2, authorityId: serverFlowId })
    expect(await screen.findByTestId('stripe-payment-form')).toBeInTheDocument()
    expect(called('/subscription/offers/v2/activate')).toHaveLength(1)
  })

  // XMR report: another browser holds the account's checkout authority, so this
  // tab's activation is refused with the exact authority-in-progress 409.
  function activationLockedMock(afterRefusal: unknown) {
    let currentReads = 0
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: currentReads++ === 0 ? null : afterRefusal })
      if (path === '/subscription/offers/v2') return response(preview ? previewOffer : annualOffer)
      if (path === '/subscription/offers/v2/activate') return response({ type: 'https://api.silentsuite.io/errors/authority-in-progress', title: 'Annual Billing Request Rejected', status: 409, detail: 'An annual checkout is already in progress for this subject.', instance: '/subscription/offers/v2/activate' }, false, 409)
      if (path === '/subscription/payment-flows/v2/resume') return response({ contractVersion: 2, kind: 'stripe', authorityId: serverFlowId, clientSecret: 'pi_resumed', disclosure: cardDisclosure() })
      return response({}, false)
    })
  }

  it('re-reads the owned flow after an authority-in-progress activation and offers its resume and cancel-and-switch, never a second start', async () => {
    activationLockedMock(ownedFlow)
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))

    expect(await screen.findByRole('button', { name: /resume card payment/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel card payment' })).toBeInTheDocument()
    expect(called('/subscription/payment-flows/current').length).toBeGreaterThanOrEqual(2)
    expect(called('/subscription/payment-flows/v2')).toHaveLength(0)
  })

  it('keeps creation closed and states the refusal when the lock holder is not a visible flow', async () => {
    // An activated-but-unclaimed authority (or a lock /current cannot show) is not resumable here.
    activationLockedMock(null)
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))

    expect(await screen.findByText('An annual checkout is already in progress for this subject.')).toBeInTheDocument()
    await waitFor(() => expect(called('/subscription/payment-flows/current').length).toBeGreaterThanOrEqual(2))
    expect(called('/subscription/payment-flows/v2')).toHaveLength(0)
    expect(called('/subscription/payment-flows/v2/resume')).toHaveLength(0)
    expect(called('/subscription/payment-flows/cancel')).toHaveLength(0)
  })

  it('offers resume for an owned in-progress authority after a reload, never a new activation', async () => {
    resumeMock(ownedFlow)
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: /resume card payment/i }))
    expect(await screen.findByTestId('stripe-payment-form')).toBeInTheDocument()
    expect(JSON.parse(String(called('/subscription/payment-flows/v2/resume')[0]![1]!.body))).toEqual({ contractVersion: 2, authorityId: serverFlowId })
    expect(called('/subscription/offers/v2/activate')).toHaveLength(0)
  })

  it('resumes an owned Bitcoin authority into the same invoice with its frozen terms and no new activation', async () => {
    const BitcoinPanel = await bitcoinEnabledPanel()
    const ownedBitcoin = {
      flowKind: 'btcpay_annual', provider: 'btcpay', status: 'provider_creation_reconciling', planId: 'early_annual', amount: '36.00',
      currency: 'EUR', createdAt: '2026-08-10T12:00:00Z', cancellable: true, invoiceId: 'invoice-1',
      checkoutUrl: 'https://btcpay.test/i/abc123', authorityId: serverFlowId, disclosure: bitcoinDisclosure,
    }
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: ownedBitcoin })
      if (path === '/subscription/offers/v2') return response(preview ? previewOffer : annualOffer)
      if (path === '/subscription/payment-flows/v2/resume') return response({ contractVersion: 2, kind: 'btcpay', authorityId: serverFlowId, checkoutUrl: 'https://btcpay.test/i/abc123', invoiceId: 'invoice-1', invoiceLookupToken: 'lookup-token', disclosure: bitcoinDisclosure })
      return response({}, false)
    })
    render(<BitcoinPanel onSuccess={vi.fn()} onCancel={vi.fn()} />)

    expect(await screen.findByText('€36.00 for one year · no automatic renewal.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /resume cryptocurrency payment/i }))
    await waitFor(() => expect(called('/subscription/payment-flows/v2/resume')).toHaveLength(1))
    expect(JSON.parse(String(called('/subscription/payment-flows/v2/resume')[0]![1]!.body))).toEqual({ contractVersion: 2, authorityId: serverFlowId })
    expect(await screen.findByText(/pay €36\.00\/year annual with bitcoin, lightning and monero/i)).toBeInTheDocument()
    expect(called('/subscription/offers/v2/activate')).toHaveLength(0)
    expect(called('/subscription/payment-flows/v2')).toHaveLength(0)
    expect(screen.queryByText(/your 14 bonus days/i)).not.toBeInTheDocument()
  })

  it('renders the frozen disclosure of the current flow and binds cancellation to its authority', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: { ...activeFlow, authorityId: serverFlowId, disclosure: cardDisclosure() } })
      // The live offer has since changed; only the frozen terms may be shown for this flow.
      if (path === '/subscription/offers/v2') return response(preview ? standardPreview : standardOffer)
      if (path === '/subscription/payment-flows/cancel') return response({ cancelled: true, flowKind: 'stripe_pay_now' })
      return response({}, false)
    })
    renderPanel()
    expect(await screen.findByText('€36.00 now · renews at €36.00/year until cancelled.')).toBeInTheDocument()
    expect(screen.queryByText(/€48\.00/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel card payment' }))
    await waitFor(() => expect(called('/subscription/payment-flows/cancel')).toHaveLength(1))
    expect(JSON.parse(String(called('/subscription/payment-flows/cancel')[0]![1]!.body))).toMatchObject({ expectedAuthorityId: serverFlowId })
  })
})

// Review correction: an owned authority is recovered from its own frozen terms,
// independently of whether a fresh purchase is offered today.
describe('PaymentChoicePanel owned-flow recovery without a fresh offer', () => {
  const ownedCard = { ...activeFlow, status: 'provider_creation_reconciling', authorityId: serverFlowId, disclosure: cardDisclosure() }
  const ownedBitcoin = {
    flowKind: 'btcpay_annual', provider: 'btcpay', status: 'provider_creation_reconciling', planId: 'early_annual', amount: '36.00',
    currency: 'EUR', createdAt: '2026-08-10T12:00:00Z', cancellable: true, checkoutUrl: 'https://btcpay.test/i/abc123',
    authorityId: serverFlowId, disclosure: bitcoinDisclosure,
  }
  const freshOfferStates = [
    ['the account profile is absent (issuance off or rolled back)', () => response(annualOffer)],
    ['the fresh offer is refused', () => response({ detail: 'The selected annual checkout is unavailable.', type: 'https://api.silentsuite.io/errors/plan-not-purchasable' }, false, 409)],
    ['the offer service is unavailable', () => response({}, false, 503)],
  ] as const

  it.each(freshOfferStates)('resumes an owned card authority when %s, with zero activation or creation', async (_name, offerReply) => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: ownedCard })
      if (path === '/subscription/offers/v2') return offerReply()
      if (path === '/subscription/payment-flows/v2/resume') return response({ contractVersion: 2, kind: 'stripe', authorityId: serverFlowId, clientSecret: 'pi_resumed', disclosure: cardDisclosure() })
      return response({}, false)
    })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /resume card payment/i }))
    expect(await screen.findByTestId('stripe-payment-form')).toHaveAttribute('data-submit-label', 'Pay €36.00')
    expect(JSON.parse(String(called('/subscription/payment-flows/v2/resume')[0]![1]!.body))).toEqual({ contractVersion: 2, authorityId: serverFlowId })
    expect(called('/subscription/offers/v2/activate')).toHaveLength(0)
    expect(called('/subscription/payment-flows/v2')).toHaveLength(0)
  })

  it.each(freshOfferStates)('resumes an owned Bitcoin invoice when %s, keeping the BTCPay origin check', async (_name, offerReply) => {
    const BitcoinPanel = await bitcoinEnabledPanel()
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: ownedBitcoin })
      if (path === '/subscription/offers/v2') return offerReply()
      if (path === '/subscription/payment-flows/v2/resume') return response({ contractVersion: 2, kind: 'btcpay', authorityId: serverFlowId, checkoutUrl: 'https://btcpay.test/i/abc123', invoiceId: 'invoice-1', invoiceLookupToken: 'lookup-token', disclosure: bitcoinDisclosure })
      return response({}, false)
    })
    render(<BitcoinPanel onSuccess={vi.fn()} onCancel={vi.fn()} />)
    await screen.findByText('Payment already in progress')
    expect(screen.queryByRole('link', { name: 'Continue in BTCPay' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /resume cryptocurrency payment/i }))
    expect(await screen.findByText(/pay €36\.00\/year annual with bitcoin, lightning and monero/i)).toBeInTheDocument()
    expect(called('/subscription/offers/v2/activate')).toHaveLength(0)
    expect(called('/subscription/payment-flows/v2')).toHaveLength(0)
  })

  it('still refuses a resumed Bitcoin URL outside the configured BTCPay origin', async () => {
    const BitcoinPanel = await bitcoinEnabledPanel()
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: ownedBitcoin })
      if (path === '/subscription/offers/v2') return response(annualOffer)
      if (path === '/subscription/payment-flows/v2/resume') return response({ contractVersion: 2, kind: 'btcpay', authorityId: serverFlowId, checkoutUrl: 'https://evil.test/i/abc123', invoiceId: 'invoice-1', invoiceLookupToken: 'lookup-token', disclosure: bitcoinDisclosure })
      return response({}, false)
    })
    render(<BitcoinPanel onSuccess={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /resume cryptocurrency payment/i }))
    expect(await screen.findByText('Cryptocurrency checkout returned an unexpected payment URL.')).toBeInTheDocument()
    expect(screen.queryByText(/with bitcoin, lightning and monero/i)).not.toBeInTheDocument()
  })

  it('does not offer resume for a flow whose authority or frozen terms are not proven', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: { ...ownedCard, disclosure: { ...cardDisclosure(), refundWindowDays: 14 } } })
      if (path === '/subscription/offers/v2') return response(annualOffer)
      return response({}, false)
    })
    renderPanel()
    expect(await screen.findByRole('heading', { name: 'Payment already in progress' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /resume/i })).not.toBeInTheDocument()
  })

  it('takes every resumed card amount from the frozen historical disclosure, never today\'s offer', async () => {
    const historical = { ...ownedCard, planId: 'standard_annual', amount: '48.00', disclosure: cardDisclosure(4800, 400) }
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: historical })
      if (path === '/subscription/offers/v2') return response(preview ? previewOffer : annualOffer)
      if (path === '/subscription/payment-flows/v2/resume') return response({ contractVersion: 2, kind: 'stripe', authorityId: serverFlowId, clientSecret: 'pi_resumed', disclosure: cardDisclosure(4800, 400) })
      return response({}, false)
    })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /resume card payment/i }))
    expect(await screen.findByTestId('stripe-payment-form')).toHaveAttribute('data-submit-label', 'Pay €48.00')
    expect(screen.getByText('Amount due').nextSibling).toHaveTextContent('€48.00')
    expect(screen.queryByText(/€36\.00/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Early Adopter|Standard Plan|early_annual|standard_annual/)).not.toBeInTheDocument()
  })

  it('titles a resumed historical Bitcoin invoice from its frozen amount while today\'s offer is Standard and card-only', async () => {
    const BitcoinPanel = await bitcoinEnabledPanel()
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: ownedBitcoin })
      if (path === '/subscription/offers/v2') return response(preview ? standardPreview : standardOffer)
      if (path === '/subscription/payment-flows/v2/resume') return response({ contractVersion: 2, kind: 'btcpay', authorityId: serverFlowId, checkoutUrl: 'https://btcpay.test/i/abc123', invoiceId: 'invoice-1', invoiceLookupToken: 'lookup-token', disclosure: bitcoinDisclosure })
      return response({}, false)
    })
    render(<BitcoinPanel onSuccess={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /resume cryptocurrency payment/i }))
    expect(await screen.findByText(/pay €36\.00\/year annual with bitcoin, lightning and monero/i)).toBeInTheDocument()
    expect(screen.queryByText(/€48\.00/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Standard Plan|standard_annual/)).not.toBeInTheDocument()
  })

  it('keeps compact signed payment terms before activation without the rejected refund paragraph', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: null })
      if (path === '/subscription/offers/v2') return response(preview ? previewOffer : annualOffer)
      return response({}, false)
    })
    renderPanel()
    expect(await screen.findByText('€36.00 now · renews at €36.00/year until cancelled.')).toBeInTheDocument()
    expect(screen.queryByText(/conversion bonus|refund window/)).not.toBeInTheDocument()
    expect(called('/subscription/offers/v2/activate')).toHaveLength(0)
  })

  it('keeps compact frozen payment terms for an owned flow even without a fresh offer', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: ownedCard })
      if (path === '/subscription/offers/v2') return response({}, false, 503)
      return response({}, false)
    })
    renderPanel()
    expect(await screen.findByText('€36.00 now · renews at €36.00/year until cancelled.')).toBeInTheDocument()
    expect(screen.queryByText(/conversion bonus|refund window/)).not.toBeInTheDocument()
  })
})

// Review correction: the authority returned with a displayed capability is the
// only one any cancel/back/switch may name, even when /current never showed it.
describe('PaymentChoicePanel displayed-authority cancellation binding', () => {
  const newerAuthority = '0b5c6a1e-2f3d-4c8b-9a7e-1d2c3b4a5f60'
  function cancelBodies() {
    return called('/subscription/payment-flows/cancel').map(([, init]) => JSON.parse(String(init!.body)))
  }

  it('binds every card cancel to the freshly created authority while a newer server authority exists, and keeps it on lost, malformed and stale replies', async () => {
    let currentReads = 0
    const cancelReplies: Array<() => Response> = [
      () => { throw new TypeError('network lost') },
      () => response({}),
      () => response({ type: 'https://api.silentsuite.io/errors/invalid-cancellation-request' }, false, 400),
    ]
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      // Another tab has since replaced the authority this tab is displaying.
      if (path === '/subscription/payment-flows/current') return response({ flow: currentReads++ === 0 ? null : { ...activeFlow, authorityId: newerAuthority, disclosure: cardDisclosure() } })
      if (path === '/subscription/offers/v2') return response(preview ? previewOffer : annualOffer)
      if (path === '/subscription/offers/v2/activate') return activation(cardDisclosure())
      if (path === '/subscription/payment-flows/v2') return response({ contractVersion: 2, kind: 'stripe', authorityId: serverFlowId, clientSecret: 'pi_secret' })
      if (path === '/subscription/payment-flows/cancel') return cancelReplies.shift()!()
      return response({}, false)
    })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))
    expect(await screen.findByTestId('stripe-payment-form')).toBeInTheDocument()

    for (let attempt = 1; attempt <= 3; attempt++) {
      fireEvent.click(screen.getAllByRole('button', { name: 'Cancel card payment' })[0]!)
      await waitFor(() => expect(called('/subscription/payment-flows/cancel')).toHaveLength(attempt))
      await waitFor(() => expect(screen.getAllByRole('button', { name: 'Cancel card payment' })[0]).not.toBeDisabled())
      expect(screen.getByTestId('stripe-payment-form')).toBeInTheDocument()
    }
    expect(cancelBodies()).toEqual([{ expectedAuthorityId: serverFlowId }, { expectedAuthorityId: serverFlowId }, { expectedAuthorityId: serverFlowId }])
  })

  it('binds the Bitcoin back/switch to the freshly created authority and keeps the no-sent acknowledgement per attempt', async () => {
    const BitcoinPanel = await bitcoinEnabledPanel()
    let cancelReads = 0
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: null })
      if (path === '/subscription/offers/v2') return response(preview ? previewOffer : annualOffer)
      if (path === '/subscription/offers/v2/activate') return activation(bitcoinDisclosure)
      if (path === '/subscription/payment-flows/v2') return response({ contractVersion: 2, kind: 'btcpay', authorityId: serverFlowId, checkoutUrl: 'https://btcpay.test/i/abc123', invoiceId: 'invoice-1', invoiceLookupToken: 'lookup-token' })
      if (path === '/subscription/payment-flows/cancel') return cancelReads++ === 0 ? response({}, false, 502) : response({ cancelled: true, flowKind: 'btcpay_annual' })
      return response({}, false)
    })
    render(<BitcoinPanel onSuccess={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /pay .* with bitcoin, lightning and monero/i }))
    const back = () => screen.getAllByRole('button', { name: /cancel cryptocurrency payment and choose card/i })[0]!
    await screen.findAllByRole('button', { name: /cancel cryptocurrency payment and choose card/i })
    expect(back()).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox', { name: /i have not sent cryptocurrency/i }))
    fireEvent.click(back())
    await waitFor(() => expect(called('/subscription/payment-flows/cancel')).toHaveLength(1))
    // A lost cancellation leaves the invoice displayed and requires a fresh acknowledgement.
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /i have not sent cryptocurrency/i })).not.toBeChecked())
    expect(screen.getByText(/pay €36\.00\/year annual with bitcoin/i)).toBeInTheDocument()
    expect(back()).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox', { name: /i have not sent cryptocurrency/i }))
    fireEvent.click(back())
    expect(await screen.findByRole('button', { name: /continue to card payment/i })).toBeInTheDocument()
    expect(cancelBodies()).toEqual([
      { confirmNoBitcoinSent: true, expectedAuthorityId: serverFlowId },
      { confirmNoBitcoinSent: true, expectedAuthorityId: serverFlowId },
    ])
  })
})

describe('PaymentChoicePanel cancellation safety', () => {
  it('clears rejected activation consent before showing a renewed offer', async () => {
    let offerReads = 0
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: null })
      if (path === '/subscription/offers/v2') {
        offerReads += 1
        const body = preview ? previewOffer : annualOffer
        return response({ ...body, requestId: offerReads === 1 ? annualOffer.requestId : '22222222-2222-4222-8222-222222222222' })
      }
      if (path === '/subscription/offers/v2/activate') return activation(cardDisclosure())
      if (path === '/subscription/payment-flows/v2') return response({ detail: 'Offer expired', type: 'https://api.silentsuite.io/errors/plan-not-purchasable' }, false, 409)
      return response({}, false)
    })

    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))
    // No approval screen: the rejected start returns directly to renewed, re-shown terms.
    await waitFor(() => expect(offerReads).toBe(2))
    expect(await screen.findByRole('button', { name: /continue to card payment/i })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /confirm annual terms/i })).not.toBeInTheDocument()
    expect(called('/subscription/payment-flows/v2')).toHaveLength(1)
  })

  it('does not dismiss while the initial current-flow verification is pending', async () => {
    let resolveCurrentFlow: ((value: Response) => void) | undefined
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      if (path === '/subscription/payment-flows/current') {
        return new Promise<Response>((resolve) => { resolveCurrentFlow = resolve })
      }
      if (path === '/subscription/offers/v2') return response(preview ? previewOffer : annualOffer)
      return response({}, false)
    })
    const onCancel = renderPanel()

    const cancel = (await screen.findAllByRole('button', { name: /checking current payment/i }))[1]!
    expect(cancel).toBeDisabled()
    fireEvent.click(cancel)
    expect(onCancel).not.toHaveBeenCalled()
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith('/payment-flows/cancel'))).toBe(false)

    await act(async () => {
      resolveCurrentFlow?.(response({ flow: null }))
    })
  })

  it('keeps the chooser open after failed verification until cancellation succeeds, and exposes a status retry', async () => {
    let currentFlowReads = 0
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      if (path === '/subscription/payment-flows/current') {
        currentFlowReads += 1
        return currentFlowReads === 1 ? response({}, false) : response({ flow: null })
      }
      if (path === '/subscription/offers/v2') return response(preview ? previewOffer : annualOffer)
      if (path === '/subscription/payment-flows/cancel') return response({ detail: 'Cancellation could not be confirmed.' }, false)
      return response({}, false)
    })
    const onCancel = renderPanel()

    expect(await screen.findByRole('button', { name: /retry payment status/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel any payment in progress and close' }))

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith('/payment-flows/cancel'))).toBe(true))
    expect(onCancel).not.toHaveBeenCalled()
    expect(await screen.findByText('Could not cancel the pending payment flow.')).toBeInTheDocument()
    expect(screen.queryByText('Cancellation could not be confirmed.')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /retry payment status/i }))
    expect(await screen.findByRole('button', { name: /continue to card payment/i })).toBeInTheDocument()
  })

  it('cancels an active flow through the authoritative endpoint before returning to payment options', async () => {
    let resolveCancellation: ((value: Response) => void) | undefined
    let currentFlowReads = 0
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      if (path === '/subscription/payment-flows/current') {
        currentFlowReads += 1
        return response({ flow: currentFlowReads === 1 ? activeFlow : null })
      }
      if (path === '/subscription/offers/v2') return response(preview ? previewOffer : annualOffer)
      if (path === '/subscription/payment-flows/cancel') {
        return new Promise<Response>((resolve) => { resolveCancellation = resolve })
      }
      return response({}, false)
    })
    const onCancel = renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel card payment' }))
    await waitFor(() => expect(resolveCancellation).toBeTypeOf('function'))
    expect(onCancel).not.toHaveBeenCalled()

    await act(async () => {
      resolveCancellation?.(response({ cancelled: true }))
    })
    await screen.findByRole('button', { name: /continue to card payment/i })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('closes directly only after a verified safe no-flow state', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const { path, preview } = route(input)
      if (path === '/subscription/payment-flows/current') return response({ flow: null })
      if (path === '/subscription/offers/v2') return response(preview ? previewOffer : annualOffer)
      return response({}, false)
    })
    const onCancel = renderPanel()

    await screen.findByRole('button', { name: /continue to card payment/i })
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith('/payment-flows/cancel'))).toBe(false)
  })
})
