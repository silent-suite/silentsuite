import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import BitcoinPaymentPanel from '../bitcoin-payment-panel'

vi.mock('lucide-react', () => ({ ArrowLeft: () => <svg />, ExternalLink: () => <svg /> }))
vi.mock('qrcode.react', () => ({ QRCodeSVG: ({ value }: { value: string }) => <div data-testid="payment-qr" data-value={value} /> }))
vi.mock('@/app/lib/config', () => ({ BILLING_API_URL: 'https://billing.example.test' }))

const methods = [
  {
    id: 'BTC-CHAIN', label: 'Bitcoin', qrValue: 'bitcoin:bc1qexample?amount=0.0005',
    address: 'bc1qexample', paymentLink: 'bitcoin:bc1qexample?amount=0.0005', amountDue: '0.0005', cryptoCode: 'BTC',
  },
  {
    id: 'BTC-LN', label: 'Lightning', qrValue: 'lightning:lnbc123',
    address: 'lnbc123', paymentLink: 'lightning:lnbc123', amountDue: '0.00049', cryptoCode: 'BTC',
  },
  {
    id: 'XMR-CHAIN', label: 'Monero', qrValue: 'monero:48A1ExampleMoneroAddress?tx_amount=0.250000000000',
    address: '48A1ExampleMoneroAddress', paymentLink: 'monero:48A1ExampleMoneroAddress?tx_amount=0.250000000000', amountDue: '0.250000000000', cryptoCode: 'XMR',
  },
]

function response(body: unknown) {
  return { ok: true, json: async () => body } as Response
}

describe('BTCPay multi-asset payment panel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith('/payment-methods')
        ? response({ paymentMethods: methods })
        : response({ status: 'pending' })
    )))
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders Bitcoin, Lightning, and Monero in order and switches the QR and copyable details', async () => {
    render(<BitcoinPaymentPanel
      session={{ invoiceId: 'invoice-test', lookupToken: 'lookup-test', checkoutUrl: 'https://btcpay.test/i/invoice-test' }}
      onBack={vi.fn()}
      onPaymentComplete={vi.fn()}
    />)

    expect(await screen.findByRole('heading', { name: 'Pay with Bitcoin, Lightning or Monero' })).toBeInTheDocument()
    expect(screen.getByText(/Choose a payment method, then scan the QR code or copy the payment details/i)).toBeInTheDocument()
    const selectors = screen.getAllByRole('button', { name: /^(Bitcoin|Lightning|Monero)$/ })
    expect(selectors.map(selector => selector.textContent)).toEqual(['Bitcoin', 'Lightning', 'Monero'])
    expect(selectors[0]).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('payment-qr')).toHaveAttribute('data-value', methods[0]!.qrValue)
    expect(screen.getByText('0.0005 BTC')).toBeInTheDocument()
    expect(screen.getByText('bc1qexample')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Monero' }))

    expect(screen.getByRole('button', { name: 'Monero' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Bitcoin' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('payment-qr')).toHaveAttribute('data-value', methods[2]!.qrValue)
    expect(screen.getByText('0.250000000000 XMR')).toBeInTheDocument()
    expect(screen.getByText('48A1ExampleMoneroAddress')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Monero' })).not.toHaveTextContent(/bitcoin/i)

    fireEvent.click(screen.getByRole('button', { name: 'Copy payment details' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(methods[2]!.qrValue))
    expect(screen.getByRole('link', { name: /Open in BTCPay instead/i })).toHaveAttribute('href', 'https://btcpay.test/i/invoice-test')
  })
})
