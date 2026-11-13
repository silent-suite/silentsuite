import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./app/(auth)/signup/page.tsx', import.meta.url), 'utf8')
function body(start, end) { return source.slice(source.indexOf(start), source.indexOf(end)) }

test('annual Plan Selected is recorded before the chosen payment checkout starts', () => {
  assert.match(body('const handleSelectCard', 'const handleSelectBitcoin'), /trackPlanSelected\(annualOfferDetails\)/)
  // Checkout Initiated is recorded by the shared payment starter, which runs
  // after the method click (Plan Selected) and after Billing activation.
  assert.match(body('const startAnnualPayment', 'const handleSelectPaid'), /trackCheckoutInitiated\(annualOffer\.offer, 'stripe'\)/)
  assert.match(body('const startAnnualPayment', 'const handleSelectPaid'), /trackCheckoutInitiated\(annualOffer\.offer, 'btcpay'\)/)
  assert.match(body('const handleSelectPaid', 'const handleSelectCrypto'), /await startAnnualPayment\(claim\)/)
  assert.match(body('const handleSelectCrypto', 'const handleConfirmAnnualClaim'), /await startAnnualPayment\(claim\)/)
  assert.doesNotMatch(source, /trackPlanSelected\('monthly'\)/)
})
