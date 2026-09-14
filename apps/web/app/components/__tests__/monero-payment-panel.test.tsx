import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import BitcoinPaymentPanel from '../bitcoin-payment-panel'
vi.mock('qrcode.react', () => ({ QRCodeSVG: ({ value }: { value: string }) => <output aria-label="Payment QR">{value}</output> }))
afterEach(() => vi.unstubAllGlobals())
it('selects Monero with its exact amount, currency, QR and copied URI in stable method order', async () => {
 const uri = 'monero:fixture-address?tx_amount=0.250000000001'
 const methods = [
  { id: 'XMR-CHAIN', label: 'Monero', cryptoCode: 'XMR', amountDue: '0.250000000001', address: 'fixture-address', qrValue: uri },
  { id: 'BTC-LN', label: 'Lightning', cryptoCode: 'BTC', amountDue: '0.0005', address: 'lnbcfixture', qrValue: 'lightning:lnbcfixture' },
  { id: 'BTC-CHAIN', label: 'Bitcoin', cryptoCode: 'BTC', amountDue: '0.0005', address: 'bc1fixture', qrValue: 'bitcoin:bc1fixture' },
 ]
 vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/payment-methods') ? { paymentMethods: methods } : { status: 'new' }))))
 const writeText = vi.fn().mockResolvedValue(undefined)
 Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
 render(<BitcoinPaymentPanel session={{ invoiceId: 'fixture', lookupToken: 'fixture', checkoutUrl: 'https://btcpay.example/i/fixture' }} onBack={() => {}} onPaymentComplete={() => {}} />)
 await screen.findByRole('button', { name: 'Monero' })
 expect(screen.getAllByRole('button').filter(b => ['Bitcoin','Lightning','Monero'].includes(b.textContent ?? '')).map(b => b.textContent)).toEqual(['Bitcoin','Lightning','Monero'])
 fireEvent.click(screen.getByRole('button', { name: 'Monero' }))
 expect(screen.getByLabelText('Payment QR')).toHaveTextContent(uri)
 expect(screen.getByText('0.250000000001 XMR')).toBeVisible()
 expect(screen.getByRole('button', { name: 'Monero' })).toHaveAttribute('aria-pressed', 'true')
 fireEvent.click(screen.getByRole('button', { name: 'Copy payment details' }))
 await waitFor(() => expect(writeText).toHaveBeenCalledWith(uri))
})
