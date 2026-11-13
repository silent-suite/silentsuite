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

test('no-card Plan Selected is recorded when the 7-day trial is chosen, like the paid methods', () => {
  const handleContinue = body('const handleContinue', 'const handleSelectCard')
  assert.match(handleContinue, /selectedTrial === '7day'\) \{\s*trackPlanSelected\(annualOfferDetails\)\s*onSelectFree\(\)/)
})

test('signup steps follow the page state machine and completion', () => {
  assert.match(source, /const \[recordSignupStep\] = useState\(createSignupStepRecorder\)/)
  assert.match(source, /recordSignupStep\(signupStepFor\(\{ step, awaitingEmailProof, usingSelfHostedServer \}\)\)/)
  assert.match(body('const handleVaultComplete', 'const email = formDataRef'), /if \(!usingSelfHostedServer\) recordSignupStep\('completed'\)\s*\/\/ Finalize authentication[^\n]*\n\s*completeSignup\(\)/)
})
