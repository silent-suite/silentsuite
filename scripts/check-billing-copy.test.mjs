import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { collectBillingCopyViolations } from './check-billing-copy.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('annual-only billing copy guard accepts the repository', () => {
  assert.deepEqual(collectBillingCopyViolations(), [])
})

test('getting-started docs preserve the mandatory hosted email-verification signup sequence', () => {
  for (const file of ['apps/docs/user-guide/getting-started.md']) {
    const content = readFileSync(resolve(repoRoot, file), 'utf8')
    assert.match(content, /verification link/i,
      `${file} must describe the emailed verification link required for hosted signup`)
    assert.match(content, /same browser/i,
      `${file} must direct users to open the verification link in the same browser they signed up in`)
    assert.match(content, /plan[^.\n]{0,160}(?:unlocks?|locked)|(?:unlocks?|locked)[^.\n]{0,160}plan/i,
      `${file} must state that plan selection stays locked until the emailed link is opened`)
    assert.match(content, /re-?enter[^.\n]{0,80}password|password[^.\n]{0,80}re-?enter/i,
      `${file} must describe password re-entry after the email-link continuation`)
    const verifyIndex = content.search(/verification link/i)
    const planChoiceIndex = content.search(/choose[^.\n]{0,60}(?:plan|trial)/i)
    assert.ok(verifyIndex !== -1 && planChoiceIndex > verifyIndex,
      `${file} must describe email verification before plan/trial selection`)
    assert.doesNotMatch(content, /verify your email[^.\n]{0,140}banner|banner[^.\n]{0,140}until you (?:click|open)/i,
      `${file} must not present hosted email verification as an optional post-signup banner`)
  }
})

test('annual-only billing copy guard catches prohibited purchase copy', () => {
  assert.ok(
    collectBillingCopyViolations({ 'README.md': 'Monthly and annual plans are available.' })
      .some(violation => violation.file === 'README.md' && violation.rule === 'prohibited-hosted-copy'),
  )
})

test('annual-only billing copy guard requires trials, cancellation, refund, and free all-feature self-hosting', () => {
  assert.ok(
    collectBillingCopyViolations({
      'apps/docs/user-guide/faq.md': 'New hosted billing is annual only: €36 and €48. Self-hosting is free.',
    }).some(violation => violation.file === 'apps/docs/user-guide/faq.md' && violation.rule === 'missing-complete-hosted-disclosure'),
  )
})

test('annual-only billing guard rejects fresh transition source branches', () => {
  assert.ok(
    collectBillingCopyViolations({
      'apps/web/app/components/payment-choice-panel.tsx': 'const endpoint = \'/subscription/payment-options?interval=monthly\'',
    }).some(violation => violation.file.endsWith('payment-choice-panel.tsx') && violation.rule === 'billing-interval-toggle'),
  )
})

test('repository-wide inventory catches prohibited commerce outside the former UI allowlist', () => {
  const violations = collectBillingCopyViolations({
    'apps/web/app/lib/reintroduced-commerce.ts': `
      fetch('/auth/provision', { body: JSON.stringify({ planId: 'early_monthly', annualAmountMinor: 3600 }) })
    `,
    'apps/docs/blog/new-pricing.md': 'Become a supporter for €4/month.',
    'android/app/src/main/java/io/silentsuite/sync/billing/FreshCheckout.kt': 'val billingInterval = "monthly"',
    'apps/web/app/components/new-checkout.tsx': '<input name="promotionCode" />',
    'apps/web/app/lib/reintroduced-shorthand.ts': 'const planId = "early_monthly"; fetch("/x", { body: JSON.stringify({ planId }) })',
    '.github/workflows/reintroduced-commerce.yml': 'run: curl /subscription/change-plan',
  })

  assert.deepEqual(
    new Set(violations.map(({ file, rule }) => `${file}:${rule}`)),
    new Set([
      'apps/web/app/lib/reintroduced-commerce.ts:legacy-v1-creation',
      'apps/web/app/lib/reintroduced-commerce.ts:client-derived-commerce',
      'apps/web/app/lib/reintroduced-commerce.ts:monthly-or-supporter-pricing',
      'apps/docs/blog/new-pricing.md:monthly-or-supporter-pricing',
      'android/app/src/main/java/io/silentsuite/sync/billing/FreshCheckout.kt:billing-interval-toggle',
      'apps/web/app/components/new-checkout.tsx:promotion-input',
      'apps/web/app/lib/reintroduced-shorthand.ts:monthly-or-supporter-pricing',
      'apps/web/app/lib/reintroduced-shorthand.ts:client-derived-commerce',
      '.github/workflows/reintroduced-commerce.yml:legacy-v1-creation',
    ]),
  )
})

test('repository-wide inventory intentionally excludes historical tests and fixtures', () => {
  const violations = collectBillingCopyViolations({
    'apps/web/app/lib/__tests__/historical-payment.test.ts': 'planId: "early_monthly"; promotionCode: "legacy"',
    'scripts/test-fixtures/historical-payment.json': '{"planId":"selfhost_supporter"}',
  })
  assert.equal(violations.some(({ file }) => file.includes('historical-payment')), false)
})

test('production inventory covers Web root/config/public sources and imported Web packages', () => {
  const violations = collectBillingCopyViolations({
    'apps/web/middleware.ts': "fetch('/auth/provision')",
    'apps/web/next.config.js': 'const promotionCode = "unreviewed"',
    'apps/web/public/reintroduced-commerce.js': 'const billingInterval = "monthly"',
    'apps/web/app/commerce-entry.ts': "import '../../../packages/commerce/src/fixtures/fresh-commerce.ts'",
    'packages/commerce/src/fixtures/fresh-commerce.ts': 'const planId = "early_monthly"',
    'android/build.gradle': 'def promotionCode = "unreviewed"',
    'apps/web/app/core-commerce-entry.ts': "import '@silentsuite/core/fixtures/fresh-commerce'",
    'packages/core/src/fixtures/fresh-commerce.ts': 'const planId = "early_monthly"',
  })

  assert.ok(violations.some(({ file, rule }) => file === 'apps/web/middleware.ts' && rule === 'legacy-v1-creation'))
  assert.ok(violations.some(({ file, rule }) => file === 'apps/web/next.config.js' && rule === 'promotion-input'))
  assert.ok(violations.some(({ file, rule }) => file === 'apps/web/public/reintroduced-commerce.js' && rule === 'billing-interval-toggle'))
  assert.ok(violations.some(({ file, rule }) => file === 'packages/commerce/src/fixtures/fresh-commerce.ts' && rule === 'production-imports-prohibited-fixture'))
  assert.ok(violations.some(({ file, rule }) => file === 'android/build.gradle' && rule === 'promotion-input'))
  assert.ok(violations.some(({ file, rule }) => file === 'packages/core/src/fixtures/fresh-commerce.ts' && rule === 'production-imports-prohibited-fixture'))
})

test('a production import cannot bypass the closed-world guard through an excluded test module', () => {
  const violations = collectBillingCopyViolations({
    'apps/web/app/commerce-entry.ts': "import './__tests__/reintroduced-commerce.test'",
    'apps/web/app/__tests__/reintroduced-commerce.test.ts': 'const planId = "early_monthly"',
  })

  assert.ok(violations.some(({ file, rule }) => file === 'apps/web/app/__tests__/reintroduced-commerce.test.ts' && rule === 'production-imports-excluded-test-module'))
})
