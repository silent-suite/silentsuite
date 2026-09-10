import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkAnnualBillingV2Contract } from './check-annual-billing-v2-contract.mjs'

const pendingPath = 'apps/web/app/(auth)/signup/pending-payment/payment-recovery.tsx'
const pendingRoutePath = 'apps/web/app/(auth)/signup/pending-payment/page.tsx'
const signupPath = 'apps/web/app/(auth)/signup/page.tsx'
const termsPath = 'apps/web/app/(auth)/signup/components/annual-confirmation-summary.tsx'
const files = [
  'contracts/annual-only-billing-v2.schema.sha256',
  'contracts/annual-only-billing-v2.schema.json',
  'apps/web/app/lib/billing-v2.ts',
  'apps/web/app/stores/use-auth-store.ts',
  'apps/web/app/components/payment-choice-panel.tsx',
  'apps/web/app/(auth)/signup/page.tsx',
  termsPath,
  pendingPath,
  pendingRoutePath,
  'apps/web/app/lib/annual-offer-presentation.ts',
  'apps/web/app/lib/public-analytics.ts',
]

function withSourceMutation(path, mutate, check) {
  const root = mkdtempSync(join(tmpdir(), 'annual-contract-'))
  try {
    for (const file of files) {
      let source = readFileSync(file, 'utf8')
      if (file === path) source = mutate(source)
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), source)
    }
    check(root)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

function withPendingMutation(from, to, check) {
  withSourceMutation(pendingPath, (source) => {
    assert.ok(source.includes(from), 'mutation must change actual source')
    return source.replace(from, to)
  }, check)
}

test('the public annual client, persistence, and authenticated UI stay compatible with the pinned closed v2 wire contract', () => {
  assert.doesNotThrow(() => checkAnnualBillingV2Contract())
})

for (const field of ['kind', 'firstChargeAmountMinor', 'firstChargeAt', 'autoRenew', 'renewalAmountMinor', 'refundWindowDays']) {
  test(`rejects signup terms that replace disclosure ${field} with fixed copy`, () => {
    withSourceMutation(termsPath, (source) => {
      const from = `disclosure.${field}`
      assert.ok(source.includes(from))
      return source.replaceAll(from, 'null') + `\n// ${from}\n`
    }, (root) => assert.throws(() => checkAnnualBillingV2Contract(root), /Signup terms must derive/))
  })
}

for (const disclosure of ['disclosure', 'cardDisclosure']) {
  test(`rejects removing the rendered ${disclosure} terms even with a source comment`, () => {
    withSourceMutation(signupPath, (source) => {
      const from = `<AnnualTermsSummary disclosure={${disclosure}} />`
      assert.ok(source.includes(from))
      return source.replaceAll(from, '<span />') + `\n// ${from}\n`
    }, (root) => assert.throws(() => checkAnnualBillingV2Contract(root), /Signup terms must render/))
  })
}

const mutations = [
  ['automatic polling exceeds the reconcile budget', 'SETTLEMENT_POLL_DELAY_MS = 4 * 60_000', 'SETTLEMENT_POLL_DELAY_MS = 10_000'],
  ['manual reads widen the backend budget', 'current: 10, reconcile: 5', 'current: 11, reconcile: 6'],
  ['polling becomes unbounded', 'SETTLEMENT_POLL_MAX_ATTEMPTS = 20', 'SETTLEMENT_POLL_MAX_ATTEMPTS = Infinity'],
  ['generic closed releases authority', "setState('unknown')", "useAuthStore.getState().clearPendingSignupPaymentRecovery(recovery); setState('unknown')"],
  ['generic closed restarts payment', "setState('unknown')", "useAuthStore.getState().startAnnualSignupPayment('intent', 'btcpay', '/'); setState('unknown')"],
  ['missing recovery authorizes restart', 'if (!recovery) {', "if (!recovery) { useAuthStore.getState().startAnnualSignupPayment('intent', 'btcpay', '/');"],
  ['closed response becomes account authority', "setState('unknown')", "setState('account')"],
  ['unbound local invoice enables checkout', "const isWaiting = state === 'pending'", "const isWaiting = Boolean(sessionStorage.getItem('silentsuite-pending-crypto-invoice'))"],
  ['recovery token crosses attempts', 'paymentSessionToken: recovery.paymentSessionToken,', "paymentSessionToken: 'other-token',"],
  ['reconcile proof crosses attempts', 'recoverySecret: recovery.paymentSessionToken,\n          requestKey:', "recoverySecret: 'other-proof',\n          requestKey:"],
  ['recovery request key crosses attempts', 'requestKey: recovery.requestKey,', "requestKey: 'other-attempt',"],
  ['recovery email crosses attempts', 'email: recovery.email,', "email: 'other@example.test',"],
  ['legacy email link consumes fresh creation proof', '  getAnonymousPaymentSessionRecovery,', '  consumeAnnualEmailOwnershipProof,\n  getAnonymousPaymentSessionRecovery,'],
  ['legacy link enables fresh checkout', 'setEmailProofUnavailable(true)', "useAuthStore.getState().startAnnualSignupPayment('intent', 'btcpay', '/')"],
]
for (const [name, from, to] of mutations) {
  test(`rejects unsafe pending-payment mutation: ${name}`, () => {
    withPendingMutation(from, to, (root) => {
      assert.throws(() => checkAnnualBillingV2Contract(root), /Pending payment contract:/)
    })
  })
}

test('comments cannot satisfy the closed-flow invariant and harmless comments do not change it', () => {
  withPendingMutation("setState('unknown')", "/* setState('account'); startAnnualSignupPayment(); */ setState('unknown')", (root) => {
    assert.doesNotThrow(() => checkAnnualBillingV2Contract(root))
  })
  withPendingMutation("setState('unknown')", "/* setState('unknown') */ setState('account')", (root) => {
    assert.throws(() => checkAnnualBillingV2Contract(root), /Pending payment contract:/)
  })
})

test('the route cannot disconnect the guarded recovery implementation', () => {
  withSourceMutation(pendingRoutePath, source => source.replace('<PendingPaymentRecovery />', '<div />'), root => {
    assert.throws(() => checkAnnualBillingV2Contract(root), /route must render/)
  })
})
