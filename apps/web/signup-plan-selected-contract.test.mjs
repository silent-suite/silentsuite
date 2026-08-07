import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./app/(auth)/signup/page.tsx', import.meta.url), 'utf8')

function callbackBody(name, nextName) {
  return source.slice(source.indexOf(`const ${name}`), source.indexOf(`const ${nextName}`))
}

test('Plan Selected is recorded on paid payment-method selection, not after signup succeeds', () => {
  assert.match(callbackBody('handleSelectCard', 'handleSelectBitcoin'), /trackPlanSelected\(interval\)[\s\S]*onSelectPaid\(promoCode\)/)
  assert.match(callbackBody('handleSelectBitcoin', 'hasEnteredPromoCode'), /trackPlanSelected\('annual'\)[\s\S]*onSelectCrypto\(interval !== 'annual'\)/)
  assert.doesNotMatch(callbackBody('handleSelectPaid', 'handleSelectCrypto'), /trackPlanSelected/)
  assert.doesNotMatch(callbackBody('handleSelectCrypto', 'handlePlanBack'), /trackPlanSelected/)
})
