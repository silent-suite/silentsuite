/**
 * Closed client for Billing's additive payment-flow cancellation contract.
 *
 * Cancelling a payment authority is the only way to switch providers, and a
 * Bitcoin flow can be settled out-of-band at any moment. The client therefore
 * never guesses: it sends an explicit, closed acknowledgement body, and it
 * renders only fixed client-owned copy. Backend `detail`, problem titles,
 * identifiers, checkout URLs, client secrets and exception text are never
 * surfaced — a cancellation error must not become a data-leak surface.
 */
import type { BillingV2Fetch } from './billing-v2'

/** `unknown` covers a local state where the authoritative flow kind is not proven. */
export type PaymentFlowCancellationProvider = 'stripe' | 'btcpay' | 'unknown'

export type PaymentFlowCancellationFailure =
  | 'bitcoin-acknowledgement-required'
  | 'invalid-cancellation-request'
  | 'payment-reconciliation-required'
  | 'provider-cancellation-failed'
  | 'unavailable'

export type PaymentFlowCancellationResult =
  | { cancelled: true; flowKind: string | null }
  /** Billing found no active flow to release; the caller re-verifies the state. */
  | { cancelled: false; alreadyResolved: true }
  | { cancelled: false; failure: PaymentFlowCancellationFailure; message: string }

/**
 * The exact neutral Bitcoin cancellation warning. It states the irreversible
 * consequence without implying the user has already paid, and it names the
 * manual-review path instead of promising automatic crediting.
 */
export const BITCOIN_CANCELLATION_WARNING =
  'Only cancel if you have not sent cryptocurrency for this payment. After cancelling, do not pay the previous QR code or address. '
  + 'A payment sent afterward cannot be credited automatically; contact support for manual review.'

export const PAYMENT_FLOW_CANCELLATION_MESSAGES: Record<PaymentFlowCancellationFailure, string> = {
  'bitcoin-acknowledgement-required': 'Confirm that you have not sent cryptocurrency before cancelling this cryptocurrency payment.',
  'invalid-cancellation-request': 'This payment could not be cancelled. Reload the page and try again.',
  'payment-reconciliation-required': 'This payment could not be cancelled. Contact support if cancellation remains blocked.',
  'provider-cancellation-failed': 'The payment provider would not cancel this payment. It may already have been paid. Wait for the provider update or contact support.',
  unavailable: 'Could not cancel the pending payment flow.',
}

/** Known (status, problem slug) pairs. Anything else uses the single generic fallback. */
const KNOWN_FAILURES: ReadonlyArray<readonly [number, string, PaymentFlowCancellationFailure]> = [
  [400, 'bitcoin-cancellation-acknowledgement-required', 'bitcoin-acknowledgement-required'],
  [400, 'invalid-cancellation-request', 'invalid-cancellation-request'],
  [409, 'payment-reconciliation-required', 'payment-reconciliation-required'],
  // Deliberate refusals that keep the flow: held/not cancellable, a different
  // flow than the one displayed, and a flow still being finalized.
  [409, 'flow-not-cancellable', 'payment-reconciliation-required'],
  [409, 'payment-flow-changed', 'invalid-cancellation-request'],
  [409, 'flow-finalization-pending', 'invalid-cancellation-request'],
  [502, 'provider-cancellation-failed', 'provider-cancellation-failed'],
]

function failed(failure: PaymentFlowCancellationFailure): PaymentFlowCancellationResult {
  return { cancelled: false, failure, message: PAYMENT_FLOW_CANCELLATION_MESSAGES[failure] }
}

/**
 * Reduce a Problem Details `type` to its trailing slug so the client is not
 * coupled to the absolute problem-type origin, and so `_` and `-` spellings of
 * the same server-owned error are treated identically.
 */
function problemSlug(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  const tail = value.split(/[/#]/).filter(Boolean).pop()
  if (!tail) return null
  return tail.toLowerCase().replaceAll('_', '-')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Bitcoin cancellation asserts a fact only the user can know, so it is sent
 * only when the user acknowledged it locally. A card flow never carries the
 * assertion at all, and an unproven flow carries it only if the user
 * acknowledged it anyway.
 */
function cancellationBody(provider: PaymentFlowCancellationProvider, confirmNoBitcoinSent: boolean, expectedAuthorityId?: string): string {
  const body: Record<string, unknown> = {}
  if (provider !== 'stripe' && confirmNoBitcoinSent) body.confirmNoBitcoinSent = true
  // Present only when Billing's current-flow reply named the authority, so a
  // cancellation can never release a different flow than the one on screen.
  if (expectedAuthorityId) body.expectedAuthorityId = expectedAuthorityId
  return JSON.stringify(body)
}

export async function cancelPaymentFlow(params: {
  fetcher: BillingV2Fetch
  billingApiUrl: string
  provider: PaymentFlowCancellationProvider
  confirmNoBitcoinSent: boolean
  expectedAuthorityId?: string
}): Promise<PaymentFlowCancellationResult> {
  // A Bitcoin flow without a local acknowledgement is refused before any
  // request leaves the browser: the server would reject it anyway, and an
  // un-acknowledged attempt must never reach the provider.
  if (params.provider === 'btcpay' && params.confirmNoBitcoinSent !== true) {
    return failed('bitcoin-acknowledgement-required')
  }

  const { fetcher } = params

  let response: Response
  let body: unknown
  try {
    response = await fetcher(`${params.billingApiUrl.replace(/\/$/, '')}/subscription/payment-flows/cancel`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: cancellationBody(params.provider, params.confirmNoBitcoinSent, params.expectedAuthorityId),
    })
    body = await response.json()
  } catch {
    // Transport loss and unparseable replies are indistinguishable from the
    // client's side: neither proves the authority was released.
    return failed('unavailable')
  }

  if (!response.ok) {
    const slug = isObject(body) ? problemSlug(body.type) : null
    const known = KNOWN_FAILURES.find(([status, knownSlug]) => status === response.status && knownSlug === slug)
    return failed(known ? known[2] : 'unavailable')
  }

  if (isObject(body) && body.cancelled === false && body.reason === 'no_active_flow') return { cancelled: false, alreadyResolved: true }
  if (!isObject(body) || body.cancelled !== true) return failed('unavailable')
  return { cancelled: true, flowKind: typeof body.flowKind === 'string' ? body.flowKind : null }
}
