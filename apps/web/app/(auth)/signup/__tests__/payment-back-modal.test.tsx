import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaymentBackModal } from '../components/payment-back-modal'

const requestId = 'e91a6d70-0d4e-4352-9bdc-426d1f76d771'
const recoverySecret = 'r'.repeat(43)
const store = vi.hoisted(() => ({
  pendingSignup: null as Record<string, unknown> | null,
  clearPendingSignupPaymentRecovery: vi.fn(),
}))

vi.mock('@/app/stores/use-auth-store', () => ({ useAuthStore: { getState: () => store } }))
vi.mock('@/app/lib/config', () => ({ BILLING_API_URL: 'https://billing.test' }))

// Fixed client copy, asserted literally rather than against exported constants.
const UNCONFIRMED = 'Cancellation is not confirmed yet. Retry cancellation or stay with this payment. Do not start another payment.'
const COOLDOWN_2 = 'Too many attempts. Wait 2 minutes, then retry cancellation. This payment is still active; do not start another payment.'
const FINE = { type: 'https://api.silentsuite.io/errors/rate-limit-exceeded', title: 'Too Many Requests', status: 429, detail: 'Rate limit exceeded for recovery:secret-session' }
const COARSE = { statusCode: 429, error: 'Too Many Requests', message: 'Rate limit exceeded, retry in 1 minute' }

function tooMany(body: unknown) {
  return new Response(JSON.stringify(body), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '120' } })
}
function open() {
  return new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }))
}
function cancelCount() {
  return vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/cancel')).length
}
function dialogAlert() {
  return screen.getByRole('dialog').querySelector('[role="alert"]')?.textContent ?? null
}
// The single destructive control; its label may be either while cooling down.
function cancelControl() {
  return screen.getByRole('button', { name: /^(Retry cancellation|Cancel and go back)$/ })
}

/** Stands in for the stable parent (signup page / pending recovery) that owns the deadline. */
function Parent({ initialUntil, onRateLimited, onReleased }: { initialUntil?: number; onRateLimited: (until: number) => void; onReleased: () => void }) {
  const [until, setUntil] = useState<number | undefined>(initialUntil)
  return <PaymentBackModal provider="btcpay" onStay={vi.fn()} onReleased={onReleased}
    cooldownUntil={until} onRateLimited={(value: number) => { onRateLimited(value); setUntil(value) }} />
}

describe('PaymentBackModal unconfirmed and rate-limited cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.pendingSignup = { email: 'modal@example.test', paymentMethod: 'btcpay', paymentSessionToken: recoverySecret, paymentSessionRequestKey: requestId }
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('offers only Retry or Stay after an unconfirmed cancellation and retains the capability', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => open()))
    const onReleased = vi.fn()
    render(<PaymentBackModal provider="btcpay" onStay={vi.fn()} onReleased={onReleased} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel and go back' }))
    await waitFor(() => expect(dialogAlert()).toBe(UNCONFIRMED))
    expect(screen.queryByRole('button', { name: /without cancelling/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/without cancelling/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stay' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Retry cancellation' })).toBeEnabled()
    expect(store.clearPendingSignupPaymentRecovery).not.toHaveBeenCalled()
    expect(onReleased).not.toHaveBeenCalled()
  })

  // B11: non-429 failures stay immediately retryable and never start a cooldown.
  it.each([
    ['503', () => new Response(JSON.stringify({ detail: 'busy' }), { status: 503 })],
    ['closed', () => new Response(JSON.stringify({ contractVersion: 2, state: 'closed', flow: null }))],
    ['open', open],
  ] as const)('keeps a %s outcome unconfirmed with Retry immediately available', async (_label, make) => {
    vi.stubGlobal('fetch', vi.fn(async () => make()))
    const onRateLimited = vi.fn()
    render(<Parent onRateLimited={onRateLimited} onReleased={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel and go back' }))
    await waitFor(() => expect(dialogAlert()).toBe(UNCONFIRMED))
    expect(screen.getByRole('button', { name: 'Retry cancellation' })).toBeEnabled()
    expect(onRateLimited).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation' }))
    await waitFor(() => expect(cancelCount()).toBe(2))
  })

  it.each([['fine Problem', FINE], ['coarse plugin Error', COARSE]] as const)('a %s 429 reports the deadline, shows fixed wait copy and sends nothing until it elapses', async (_label, body) => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.stubGlobal('fetch', vi.fn(async () => tooMany(body)))
    const onRateLimited = vi.fn()
    const onReleased = vi.fn()
    const startedAt = Date.now()
    render(<Parent onRateLimited={onRateLimited} onReleased={onReleased} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel and go back' }))
    await waitFor(() => expect(dialogAlert()).toBe(COOLDOWN_2))
    expect(onRateLimited).toHaveBeenCalledTimes(1)
    const until = onRateLimited.mock.calls[0]![0] as number
    expect(until).toBeGreaterThanOrEqual(startedAt + 120_000)
    expect(until).toBeLessThan(startedAt + 125_000)
    expect(cancelControl()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stay' })).toBeEnabled()
    expect(document.body).not.toHaveTextContent(/Rate limit exceeded|Too Many Requests|secret-session/)
    expect(store.clearPendingSignupPaymentRecovery).not.toHaveBeenCalled()
    expect(store.pendingSignup).toMatchObject({ paymentSessionToken: recoverySecret, paymentSessionRequestKey: requestId })
    expect(onReleased).not.toHaveBeenCalled()
    fireEvent.click(cancelControl())
    expect(cancelCount()).toBe(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(cancelControl()).toBeDisabled()
    expect(cancelCount()).toBe(1)

    // B4: expiry re-enables Retry and restores the unconfirmed copy, with no automatic request.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry cancellation' })).toBeEnabled())
    expect(dialogAlert()).toBe(UNCONFIRMED)
    expect(cancelCount()).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation' }))
    await waitFor(() => expect(cancelCount()).toBe(2))
  })

  // B3 at the component boundary: a parent-held deadline opens the modal already cooling down.
  it('opens in the cooldown state from a parent deadline without sending a request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.stubGlobal('fetch', vi.fn(async () => open()))
    render(<Parent initialUntil={Date.now() + 120_000} onRateLimited={vi.fn()} onReleased={vi.fn()} />)
    await waitFor(() => expect(dialogAlert()).toBe(COOLDOWN_2))
    expect(cancelControl()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stay' })).toBeEnabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(121_000) })
    await waitFor(() => expect(cancelControl()).toBeEnabled())
    expect(cancelCount()).toBe(0)
  })

  // B5: an elapsed deadline is the normal confirm state.
  it('ignores an already elapsed parent deadline', () => {
    vi.stubGlobal('fetch', vi.fn(async () => open()))
    render(<Parent initialUntil={Date.now() - 1} onRateLimited={vi.fn()} onReleased={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Cancel and go back' })).toBeEnabled()
    expect(dialogAlert()).toBeNull()
  })

  // C1 review CR-4 parity: a zero wait is immediately retryable in the modal too.
  it.each([
    ['retry-after: 0', () => '0'],
    ['a past HTTP date', () => new Date(Date.now() - 60_000).toUTCString()],
  ] as const)('treats a %s 429 as immediately retryable with the unconfirmed copy', async (_label, header) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(COARSE), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': header() } })))
    render(<Parent onRateLimited={vi.fn()} onReleased={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel and go back' }))
    await waitFor(() => expect(dialogAlert()).toBe(UNCONFIRMED))
    expect(screen.queryByText(/Wait \d+ minutes/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry cancellation' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation' }))
    await waitFor(() => expect(cancelCount()).toBe(2))
  })

  // B9: the existing single-flight guard still holds.
  it('sends one request for duplicate clicks', async () => {
    let resolve!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done })))
    render(<Parent onRateLimited={vi.fn()} onReleased={vi.fn()} />)
    const control = screen.getByRole('button', { name: 'Cancel and go back' })
    fireEvent.click(control)
    fireEvent.click(control)
    expect(cancelCount()).toBe(1)
    await act(async () => { resolve(open()) })
    await waitFor(() => expect(dialogAlert()).toBe(UNCONFIRMED))
  })
})
