import React, { useState } from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BitcoinPaymentPanel from '../bitcoin-payment-panel'

vi.mock('lucide-react', () => ({
  ArrowLeft: () => <svg />,
  ExternalLink: () => <svg />,
}))

vi.mock('@/app/lib/config', () => ({
  BILLING_API_URL: 'https://billing.example.test',
  ETEBASE_SERVER_URL: 'https://server.example.test',
}))

const session = { invoiceId: 'inv-1', lookupToken: 'lookup-1', checkoutUrl: 'https://btcpay.test/i/inv-1' }
const STATUS_URL = 'https://billing.example.test/subscription/crypto/invoice/inv-1'

/** Re-renders with a new onPaymentComplete whenever completion is reported, as PaymentChoicePanel does. */
function Parent({ onComplete }: { onComplete: () => void }) {
  const [completing, setCompleting] = useState(false)
  return (
    <>
      <span data-testid="completing">{String(completing)}</span>
      <BitcoinPaymentPanel
        session={session}
        onBack={() => {}}
        onCompletingChange={setCompleting}
        onPaymentComplete={() => { onComplete() }}
      />
    </>
  )
}

describe('BitcoinPaymentPanel completion (review fix 2: SIGNUP-02)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('completes exactly once after a settled reply, even when the parent re-renders and a later read fails', async () => {
    let statusReads = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/payment-methods')) {
        return { ok: true, json: async () => ({ paymentMethods: [{ id: 'BTC-CHAIN', label: 'Bitcoin', qrValue: 'bitcoin:abc', address: 'abc', amountDue: '0.001', cryptoCode: 'BTC' }] }) }
      }
      if (url === STATUS_URL) {
        statusReads += 1
        return statusReads === 1
          ? { ok: true, json: async () => ({ status: 'settled' }) }
          : { ok: false, status: 503, json: async () => ({}) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }))
    const onComplete = vi.fn()

    render(<Parent onComplete={onComplete} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByTestId('completing')).toHaveTextContent('true')

    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('completing')).toHaveTextContent('false')

    // Nothing later repeats it, and the settled invoice is not read again.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(statusReads).toBe(1)
  })
})
