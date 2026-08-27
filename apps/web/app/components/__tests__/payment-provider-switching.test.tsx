import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import PaymentChoicePanel from '../payment-choice-panel'
import { BITCOIN_CANCELLATION_WARNING, PAYMENT_FLOW_CANCELLATION_MESSAGES } from '@/app/lib/payment-flow-cancellation'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED = 'true'
  process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ORIGIN = 'https://btcpay.test'
})

vi.mock('next/dynamic', () => ({
  default: () => () => <div data-testid="stripe-payment-form" />,
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

vi.mock('@/app/lib/config', () => ({
  BILLING_API_URL: 'https://billing.example.test',
}))

const earlyOffer = {
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

const stripeOnlyOffer = {
  ...earlyOffer,
  offer: {
    ...earlyOffer.offer,
    planId: 'standard_annual',
    customerClass: 'standard',
    annualAmountMinor: 4800,
    monthlyEquivalentMinor: 400,
    providers: ['stripe'],
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

function flow(overrides: Record<string, unknown> = {}) {
  return {
    flowKind: 'stripe_pay_now',
    provider: 'stripe',
    status: 'processing',
    planId: 'early_annual',
    amount: '36.00',
    currency: 'EUR',
    createdAt: '2026-08-10T12:00:00Z',
    cancellable: true,
    ...overrides,
  }
}

const bitcoinFlow = flow({
  flowKind: 'btcpay_annual',
  provider: 'btcpay',
  status: 'provider_pending',
  invoiceId: 'invoice-1',
  checkoutUrl: 'https://btcpay.test/i/abc123',
})

function response(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body } as Response
}

type Routes = {
  currentFlow?: () => Promise<Response>
  offer?: () => Promise<Response>
  cancel?: () => Promise<Response>
  paymentFlow?: () => Promise<Response>
}

function mockBilling(routes: Routes) {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/subscription/payment-flows/current')) return routes.currentFlow?.() ?? response({ flow: null })
    if (url.endsWith('/subscription/offers/v2')) return routes.offer?.() ?? response(earlyOffer)
    if (url.endsWith('/subscription/offers/v2/activate')) return response(activation)
    if (url.endsWith('/subscription/payment-flows/v2')) return routes.paymentFlow?.() ?? response({}, false)
    if (url.endsWith('/subscription/payment-flows/cancel')) return routes.cancel?.() ?? response({ cancelled: true, flowKind: 'stripe_pay_now' })
    if (url.includes('/subscription/crypto/invoice/')) {
      if (url.endsWith('/payment-methods')) {
        return response({ paymentMethods: [{ id: 'BTC', label: 'Bitcoin', qrValue: 'bitcoin:bc1qexample', address: 'bc1qexample', amountDue: '0.0004', cryptoCode: 'BTC' }] })
      }
      return response({ status: 'pending' })
    }
    return response({}, false)
  })
}

function renderPanel() {
  const onCancel = vi.fn()
  render(<PaymentChoicePanel onSuccess={vi.fn()} onCancel={onCancel} />)
  return onCancel
}

async function openInlineStripePanel() {
  mockBilling({
    paymentFlow: async () => response({ contractVersion: 2, kind: 'stripe', authorityId: earlyOffer.requestId, clientSecret: 'pi_secret_value' }),
  })
  renderPanel()
  fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))
  fireEvent.click(await screen.findByRole('button', { name: /confirm annual terms and continue/i }))
  await screen.findByTestId('stripe-payment-form')
}

async function openInlineBitcoinPanel() {
  mockBilling({
    paymentFlow: async () => response({
      contractVersion: 2,
      kind: 'btcpay',
      authorityId: earlyOffer.requestId,
      checkoutUrl: 'https://btcpay.test/i/abc123',
      invoiceId: 'invoice-1',
      invoiceLookupToken: 'B'.repeat(43),
    }),
  })
  renderPanel()
  fireEvent.click(await screen.findByRole('button', { name: /pay .* with bitcoin for/i }))
  fireEvent.click(await screen.findByRole('button', { name: /confirm annual terms and continue/i }))
  await screen.findByRole('heading', { name: /pay .* annual with bitcoin/i })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('explicit provider-switch consequence labels', () => {
  it('labels the resumed card flow with the Bitcoin switch it actually performs', async () => {
    mockBilling({ currentFlow: async () => response({ flow: flow() }) })
    renderPanel()

    expect(await screen.findByRole('button', { name: 'Cancel card payment and choose Bitcoin' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /cancel and choose another method/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByText(BITCOIN_CANCELLATION_WARNING)).not.toBeInTheDocument()
  })

  it('labels the resumed Bitcoin flow with the card switch and preserves the validated BTCPay continuation link', async () => {
    mockBilling({ currentFlow: async () => response({ flow: bitcoinFlow }) })
    renderPanel()

    expect(await screen.findByRole('button', { name: 'Cancel Bitcoin payment and choose card' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /continue in btcpay/i })).toHaveAttribute('href', 'https://btcpay.test/i/abc123')
  })

  it('does not promise a provider the current server offer does not expose', async () => {
    mockBilling({ currentFlow: async () => response({ flow: flow() }), offer: async () => response(stripeOnlyOffer) })
    renderPanel()

    expect(await screen.findByRole('button', { name: 'Cancel card payment' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /choose bitcoin/i })).not.toBeInTheDocument()
  })

  it('keeps a truthful Bitcoin cancellation consequence when no offer authority is available', async () => {
    mockBilling({ currentFlow: async () => response({ flow: bitcoinFlow }), offer: async () => response({}, false) })
    renderPanel()

    expect(await screen.findByRole('button', { name: 'Cancel Bitcoin payment' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /choose card/i })).not.toBeInTheDocument()
  })

  it('replaces every generic Back control on the inline card panel with the switch consequence', async () => {
    await openInlineStripePanel()

    const switches = screen.getAllByRole('button', { name: 'Cancel card payment and choose Bitcoin' })
    expect(switches).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /back to (payment )?options/i })).not.toBeInTheDocument()
  })

  it('replaces the generic Back control on the inline Bitcoin panel with the switch consequence', async () => {
    await openInlineBitcoinPanel()

    expect(screen.getAllByRole('button', { name: 'Cancel Bitcoin payment and choose card' })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /back to payment options/i })).not.toBeInTheDocument()
  })

  it('keeps the pre-authority terms screen on a plain non-cancelling Back control', async () => {
    mockBilling({})
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))

    fireEvent.click(await screen.findByRole('button', { name: /back to payment options/i }))

    expect(await screen.findByRole('button', { name: /continue to card payment/i })).toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith('/payment-flows/cancel'))).toBe(false)
  })
})

describe('Bitcoin cancellation acknowledgement', () => {
  it('gates the resumed Bitcoin switch behind an unchecked acknowledgement and the exact neutral warning', async () => {
    mockBilling({ currentFlow: async () => response({ flow: bitcoinFlow }) })
    renderPanel()

    const action = await screen.findByRole('button', { name: 'Cancel Bitcoin payment and choose card' })
    const acknowledgement = screen.getByRole('checkbox', { name: /have not sent bitcoin/i })
    expect(acknowledgement).not.toBeChecked()
    expect(action).toBeDisabled()
    expect(screen.getByText(BITCOIN_CANCELLATION_WARNING)).toBeInTheDocument()

    fireEvent.click(acknowledgement)

    expect(acknowledgement).toBeChecked()
    expect(action).toBeEnabled()
  })

  it('gates the inline Bitcoin panel switch behind the same acknowledgement', async () => {
    await openInlineBitcoinPanel()

    const actions = screen.getAllByRole('button', { name: 'Cancel Bitcoin payment and choose card' })
    actions.forEach((action) => expect(action).toBeDisabled())
    expect(screen.getByText(BITCOIN_CANCELLATION_WARNING)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: /have not sent bitcoin/i }))

    screen.getAllByRole('button', { name: 'Cancel Bitcoin payment and choose card' }).forEach((action) => expect(action).toBeEnabled())
  })

  it('renders exactly one acknowledgement control adjacent to the Bitcoin action', async () => {
    await openInlineBitcoinPanel()

    expect(screen.getAllByRole('checkbox', { name: /have not sent bitcoin/i })).toHaveLength(1)
    expect(screen.getAllByText(BITCOIN_CANCELLATION_WARNING)).toHaveLength(1)
  })

  it('never auto-checks the acknowledgement and resets it when the provider flow changes', async () => {
    let currentFlowReads = 0
    mockBilling({
      currentFlow: async () => {
        currentFlowReads += 1
        return response({ flow: currentFlowReads === 1 ? bitcoinFlow : flow() })
      },
      cancel: async () => response({}, false, 502),
    })
    renderPanel()

    fireEvent.click(await screen.findByRole('checkbox', { name: /have not sent bitcoin/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Bitcoin payment and choose card' }))

    // A refused cancellation leaves the Bitcoin authority in place and must
    // force a fresh, deliberate acknowledgement before the next attempt.
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /have not sent bitcoin/i })).not.toBeChecked())
    expect(screen.getByRole('button', { name: 'Cancel Bitcoin payment and choose card' })).toBeDisabled()
  })

  it('sends the literal acknowledgement only after the user checks it', async () => {
    let currentFlowReads = 0
    mockBilling({
      currentFlow: async () => {
        currentFlowReads += 1
        return response({ flow: currentFlowReads === 1 ? bitcoinFlow : null })
      },
      cancel: async () => response({ cancelled: true, flowKind: 'btcpay_annual' }),
    })
    renderPanel()

    const action = await screen.findByRole('button', { name: 'Cancel Bitcoin payment and choose card' })
    fireEvent.click(action)
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith('/payment-flows/cancel'))).toBe(false)

    fireEvent.click(screen.getByRole('checkbox', { name: /have not sent bitcoin/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Bitcoin payment and choose card' }))

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith('/payment-flows/cancel'))
      expect(call).toBeDefined()
      expect((call?.[1] as RequestInit).body).toBe('{"confirmNoBitcoinSent":true}')
    })
  })

  it('sends no Bitcoin assertion when cancelling a card flow', async () => {
    let currentFlowReads = 0
    mockBilling({
      currentFlow: async () => {
        currentFlowReads += 1
        return response({ flow: currentFlowReads === 1 ? flow() : null })
      },
    })
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel card payment and choose Bitcoin' }))

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith('/payment-flows/cancel'))
      expect(call).toBeDefined()
      expect((call?.[1] as RequestInit).body).toBe('{}')
    })
  })

  it('reveals the acknowledgement when an unverified cancellation proves a Bitcoin authority exists', async () => {
    mockBilling({
      currentFlow: async () => response({}, false),
      cancel: async () => response(
        { type: 'https://api.silentsuite.io/errors/bitcoin-cancellation-acknowledgement-required', detail: 'invoice inv_secret_1 still open' },
        false,
        400,
      ),
    })
    renderPanel()

    await screen.findByRole('button', { name: /retry payment status/i })
    const cancelAction = screen.getByRole('button', { name: /cancel any payment in progress and close/i })
    fireEvent.click(cancelAction)

    const acknowledgement = await screen.findByRole('checkbox', { name: /have not sent bitcoin/i })
    expect(acknowledgement).not.toBeChecked()
    expect(screen.getByText(BITCOIN_CANCELLATION_WARNING)).toBeInTheDocument()
    expect(screen.queryByText(/inv_secret_1/)).not.toBeInTheDocument()
    expect(within(document.body).queryByText(/still open/)).not.toBeInTheDocument()
  })
})

const CREATE_CARD = /continue to card payment/i
const CREATE_BITCOIN = /pay .* with bitcoin for/i

function creationActions() {
  return [
    ...screen.queryAllByRole('button', { name: CREATE_CARD }),
    ...screen.queryAllByRole('button', { name: CREATE_BITCOIN }),
  ]
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('provider switching never creates a second authority', () => {
  it('exposes Bitcoin creation only after the card cancellation is proven by a null current flow', async () => {
    const secondLookup = deferred<Response>()
    let currentFlowReads = 0
    mockBilling({
      currentFlow: async () => {
        currentFlowReads += 1
        return currentFlowReads === 1 ? response({ flow: flow() }) : secondLookup.promise
      },
      cancel: async () => response({ cancelled: true, flowKind: 'stripe_pay_now' }),
    })
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel card payment and choose Bitcoin' }))

    await waitFor(() => expect(currentFlowReads).toBe(2))
    expect(creationActions()).toHaveLength(0)
    expect(screen.getByRole('button', { name: /checking current payment/i })).toBeInTheDocument()

    await act(async () => { secondLookup.resolve(response({ flow: null })) })

    expect(await screen.findByRole('button', { name: CREATE_BITCOIN })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: CREATE_CARD })).toBeInTheDocument()
  })

  it('exposes card creation only after an acknowledged Bitcoin cancellation is proven by a null current flow', async () => {
    const secondLookup = deferred<Response>()
    let currentFlowReads = 0
    mockBilling({
      currentFlow: async () => {
        currentFlowReads += 1
        return currentFlowReads === 1 ? response({ flow: bitcoinFlow }) : secondLookup.promise
      },
      cancel: async () => response({ cancelled: true, flowKind: 'btcpay_annual' }),
    })
    renderPanel()

    fireEvent.click(await screen.findByRole('checkbox', { name: /have not sent bitcoin/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Bitcoin payment and choose card' }))

    await waitFor(() => expect(currentFlowReads).toBe(2))
    const cancelCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith('/payment-flows/cancel'))
    expect((cancelCall?.[1] as RequestInit).body).toBe('{"confirmNoBitcoinSent":true}')
    expect(creationActions()).toHaveLength(0)

    await act(async () => { secondLookup.resolve(response({ flow: null })) })

    expect(await screen.findByRole('button', { name: CREATE_CARD })).toBeInTheDocument()
    // The acknowledgement never survives the authority it was given for.
    expect(screen.queryByRole('checkbox', { name: /have not sent bitcoin/i })).not.toBeInTheDocument()
  })

  it('offers no provider creation path while a successful cancellation cannot be re-verified', async () => {
    let currentFlowReads = 0
    mockBilling({
      currentFlow: async () => {
        currentFlowReads += 1
        return currentFlowReads === 1 ? response({ flow: flow() }) : response({}, false)
      },
      cancel: async () => response({ cancelled: true, flowKind: 'stripe_pay_now' }),
    })
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel card payment and choose Bitcoin' }))

    expect(await screen.findByRole('button', { name: /retry payment status/i })).toBeInTheDocument()
    expect(creationActions()).toHaveLength(0)
  })

  it.each([
    ['a provider refusal', 502, 'https://api.silentsuite.io/errors/provider-cancellation-failed', 'provider-cancellation-failed'],
    ['local authority ambiguity', 409, 'https://api.silentsuite.io/errors/payment_reconciliation_required', 'payment-reconciliation-required'],
    ['a malformed cancellation request', 400, 'https://api.silentsuite.io/errors/invalid-cancellation-request', 'invalid-cancellation-request'],
  ] as const)('keeps the current Bitcoin authority displayed after %s', async (_label, status, type, failure) => {
    mockBilling({
      currentFlow: async () => response({ flow: bitcoinFlow }),
      cancel: async () => response({ type, detail: 'invoice inv_secret_1 for cus_9999 at https://btcpay.test/i/secret' }, false, status),
    })
    renderPanel()

    fireEvent.click(await screen.findByRole('checkbox', { name: /have not sent bitcoin/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Bitcoin payment and choose card' }))

    expect(await screen.findByText(PAYMENT_FLOW_CANCELLATION_MESSAGES[failure])).toBeInTheDocument()
    expect(screen.getByText(/payment already in progress/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel Bitcoin payment and choose card' })).toBeInTheDocument()
    expect(creationActions()).toHaveLength(0)
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith('/offers/v2/activate'))).toBe(false)
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith('/payment-flows/v2'))).toBe(false)
    for (const secret of ['inv_secret_1', 'cus_9999', '/i/secret']) {
      expect(document.body.textContent).not.toContain(secret)
    }
  })

  it.each([
    ['a malformed success body', () => response({ cancelled: 'yes', detail: 'pi_3Qsecret' })],
    ['a lost response', () => { throw new Error('pi_3Qsecret network detail') }],
  ] as const)('keeps the current card authority displayed after %s', async (_label, cancel) => {
    mockBilling({ currentFlow: async () => response({ flow: flow() }), cancel: async () => cancel() })
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel card payment and choose Bitcoin' }))

    expect(await screen.findByText(PAYMENT_FLOW_CANCELLATION_MESSAGES.unavailable)).toBeInTheDocument()
    expect(screen.getByText(/payment already in progress/i)).toBeInTheDocument()
    expect(creationActions()).toHaveLength(0)
    expect(document.body.textContent).not.toContain('pi_3Qsecret')
  })

  it('offers no provider creation path while the current-flow lookup is still pending', async () => {
    const lookup = deferred<Response>()
    mockBilling({ currentFlow: () => lookup.promise })
    renderPanel()

    await screen.findAllByRole('button', { name: /checking current payment/i })
    expect(creationActions()).toHaveLength(0)

    await act(async () => { lookup.resolve(response({ flow: null })) })
    expect(await screen.findByRole('button', { name: CREATE_CARD })).toBeInTheDocument()
  })

  it('offers no provider creation path when the current-flow lookup fails', async () => {
    mockBilling({ currentFlow: async () => response({}, false) })
    renderPanel()

    expect(await screen.findByRole('button', { name: /retry payment status/i })).toBeInTheDocument()
    expect(creationActions()).toHaveLength(0)
  })

  it('preserves the annual-only offer copy and signed-offer confirmation across a provider switch', async () => {
    let currentFlowReads = 0
    mockBilling({
      currentFlow: async () => {
        currentFlowReads += 1
        return response({ flow: currentFlowReads === 1 ? flow() : null })
      },
      cancel: async () => response({ cancelled: true, flowKind: 'stripe_pay_now' }),
    })
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel card payment and choose Bitcoin' }))

    expect(await screen.findByText(/pay now \+ 14 bonus days/i)).toBeInTheDocument()
    expect(screen.getByText(/€36\.00\/year/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: CREATE_BITCOIN }))

    expect(await screen.findByRole('heading', { name: /confirm annual terms/i })).toBeInTheDocument()
    expect(screen.getByText(/14 bonus days after confirmed payment/i)).toBeInTheDocument()
    expect(screen.getByText(/30-day refund window/i)).toBeInTheDocument()
  })
})

describe('post-cancellation provider creation stays closed until the lookup proves it', () => {
  function switchRoutes(current: () => Promise<Response>, offer: () => Promise<Response>) {
    mockBilling({
      currentFlow: current,
      offer,
      cancel: async () => response({ cancelled: true, flowKind: 'stripe_pay_now' }),
    })
  }

  it('holds creation closed when the post-cancel offer refresh resolves before the current-flow lookup', async () => {
    const offerRefresh = deferred<Response>()
    const secondLookup = deferred<Response>()
    let currentFlowReads = 0
    let offerReads = 0
    switchRoutes(
      async () => {
        currentFlowReads += 1
        return currentFlowReads === 1 ? response({ flow: flow() }) : secondLookup.promise
      },
      async () => {
        offerReads += 1
        return offerReads === 1 ? response(earlyOffer) : offerRefresh.promise
      },
    )
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel card payment and choose Bitcoin' }))
    await waitFor(() => expect(offerReads).toBe(2))

    // The mandatory re-proof is in flight before the offer refresh can return,
    // so there is no window in which a resolved offer meets a stale "loaded"
    // current-flow state.
    expect(currentFlowReads).toBe(2)
    expect(screen.getByRole('button', { name: /checking current payment/i })).toBeInTheDocument()
    expect(creationActions()).toHaveLength(0)

    await act(async () => { offerRefresh.resolve(response(earlyOffer)) })

    // The offer is now authoritative again while the current-flow lookup has
    // still not resolved: creation must remain unavailable.
    expect(creationActions()).toHaveLength(0)
    expect(screen.getByRole('button', { name: /checking current payment/i })).toBeInTheDocument()

    await act(async () => { secondLookup.resolve(response({ flow: null })) })

    expect(await screen.findByRole('button', { name: CREATE_BITCOIN })).toBeEnabled()
    expect(screen.getByRole('button', { name: CREATE_CARD })).toBeEnabled()
  })

  it('keeps creation closed when the re-proof returns an authority the cancellation did not release', async () => {
    const offerRefresh = deferred<Response>()
    const secondLookup = deferred<Response>()
    let currentFlowReads = 0
    let offerReads = 0
    switchRoutes(
      async () => {
        currentFlowReads += 1
        return currentFlowReads === 1 ? response({ flow: flow() }) : secondLookup.promise
      },
      async () => {
        offerReads += 1
        return offerReads === 1 ? response(earlyOffer) : offerRefresh.promise
      },
    )
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel card payment and choose Bitcoin' }))
    await waitFor(() => expect(offerReads).toBe(2))

    await act(async () => { offerRefresh.resolve(response(earlyOffer)) })
    await act(async () => { secondLookup.resolve(response({ flow: bitcoinFlow })) })

    expect(await screen.findByText(/payment already in progress/i)).toBeInTheDocument()
    expect(creationActions()).toHaveLength(0)
  })
})

describe('a 2xx current-flow lookup releases creation only when the body proves no flow', () => {
  const MALFORMED_BODIES: ReadonlyArray<readonly [string, unknown]> = [
    ['an empty object', {}],
    ['an explicitly undefined flow', { flow: undefined }],
    ['an inherited rather than own flow', Object.create({ flow: null }) as unknown],
    ['a null body', null],
    ['an array body', []],
    ['a string body', 'no flow'],
    ['a numeric body', 0],
    ['a boolean body', true],
    ['a non-object flow', { flow: 'stripe_pay_now' }],
    ['an array flow', { flow: [flow()] }],
    ['an unknown flow kind', { flow: flow({ flowKind: 'paypal_annual' }) }],
    ['a missing flow kind', { flow: flow({ flowKind: undefined }) }],
    ['a non-boolean cancellable', { flow: flow({ cancellable: 'yes' }) }],
    ['a missing cancellable', { flow: flow({ cancellable: undefined }) }],
    ['an empty creation timestamp', { flow: flow({ createdAt: '' }) }],
    ['a non-string creation timestamp', { flow: flow({ createdAt: 1755000000 }) }],
  ]

  it.each(MALFORMED_BODIES)('fails closed with a retry on %s', async (_label, body) => {
    mockBilling({ currentFlow: async () => response(body) })
    renderPanel()

    expect(await screen.findByRole('button', { name: /retry payment status/i })).toBeEnabled()
    expect(screen.getByText(/could not verify whether a payment is already in progress/i)).toBeInTheDocument()
    expect(creationActions()).toHaveLength(0)
    expect(screen.queryByText(/payment already in progress/i)).not.toBeInTheDocument()
  })

  it('renders no backend detail, identifier or checkout URL from a malformed reply', async () => {
    mockBilling({
      currentFlow: async () => response({
        detail: 'pi_3Qsecret belongs to cus_9999',
        flow: {
          flowKind: 'paypal_annual',
          invoiceId: 'inv_secret_1',
          checkoutUrl: 'https://btcpay.test/i/secret',
          createdAt: '2026-08-10T12:00:00Z',
          cancellable: true,
        },
      }),
    })
    renderPanel()

    await screen.findByRole('button', { name: /retry payment status/i })
    for (const secret of ['pi_3Qsecret', 'cus_9999', 'inv_secret_1', '/i/secret', 'paypal_annual']) {
      expect(document.body.textContent).not.toContain(secret)
    }
  })

  it('releases creation on an own literal null flow', async () => {
    mockBilling({ currentFlow: async () => response({ flow: null }) })
    renderPanel()

    expect(await screen.findByRole('button', { name: CREATE_CARD })).toBeEnabled()
    expect(screen.getByRole('button', { name: CREATE_BITCOIN })).toBeEnabled()
    expect(screen.queryByText(/could not verify whether a payment is already in progress/i)).not.toBeInTheDocument()
  })

  it('releases creation when a retry replaces a malformed reply with a proven null flow', async () => {
    let currentFlowReads = 0
    mockBilling({
      currentFlow: async () => {
        currentFlowReads += 1
        return response(currentFlowReads === 1 ? {} : { flow: null })
      },
    })
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: /retry payment status/i }))

    expect(await screen.findByRole('button', { name: CREATE_CARD })).toBeEnabled()
    expect(creationActions()).toHaveLength(2)
  })

  it.each([
    ['card', 'stripe_pay_now', 'Cancel card payment and choose Bitcoin'],
    ['Bitcoin', 'btcpay_annual', 'Cancel Bitcoin payment and choose card'],
  ] as const)('keeps a valid %s authority carrying only the fields the panel needs', async (_label, flowKind, action) => {
    mockBilling({
      currentFlow: async () => response({ flow: { flowKind, createdAt: '2026-08-10T12:00:00Z', cancellable: true } }),
    })
    renderPanel()

    expect(await screen.findByRole('button', { name: action })).toBeInTheDocument()
    expect(screen.getByText(/payment already in progress/i)).toBeInTheDocument()
    expect(creationActions()).toHaveLength(0)
  })
})
