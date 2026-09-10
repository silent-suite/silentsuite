#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

// Use the web app's installed compiler without adding a second dependency.
const ts = createRequire(new URL('../apps/web/package.json', import.meta.url))('typescript')

const PIN_FILE = 'contracts/annual-only-billing-v2.schema.sha256'
const SCHEMA_FILE = 'contracts/annual-only-billing-v2.schema.json'
const CLIENT_FILE = 'apps/web/app/lib/billing-v2.ts'
const AUTH_STORE_FILE = 'apps/web/app/stores/use-auth-store.ts'
const PAYMENT_PANEL_FILE = 'apps/web/app/components/payment-choice-panel.tsx'
const SIGNUP_PAGE_FILE = 'apps/web/app/(auth)/signup/page.tsx'
const SIGNUP_TERMS_FILE = 'apps/web/app/(auth)/signup/components/annual-confirmation-summary.tsx'
const PENDING_PAYMENT_FILE = 'apps/web/app/(auth)/signup/pending-payment/page.tsx'
const OFFER_PRESENTATION_FILE = 'apps/web/app/lib/annual-offer-presentation.ts'
const PUBLIC_ANALYTICS_FILE = 'apps/web/app/lib/public-analytics.ts'
const SHA256 = /^[0-9a-f]{64}$/
const assert = (condition, message) => { if (!condition) throw new Error(message) }

const canonicalPaths = {
  emailProofRequest: '/auth/signup-email-verifications/v2',
  emailProofConsume: '/auth/signup-email-verifications/v2/consume',
  anonymousOffer: '/auth/offers/v2',
  anonymousActivate: '/auth/offers/v2/activate',
  authenticatedOffer: '/subscription/offers/v2',
  authenticatedActivate: '/subscription/offers/v2/activate',
  provision: '/auth/provision/v2',
  paymentSession: '/auth/signup/payment-session/v2',
  finalize: '/auth/signup/finalize-payment/v2',
  authenticatedPaymentFlow: '/subscription/payment-flows/v2',
  paymentSessionCurrent: '/auth/signup/payment-session/v2/current',
  paymentSessionReconcile: '/auth/signup/payment-session/v2/reconcile',
  paymentSessionCancel: '/auth/signup/payment-session/v2/cancel',
}

function functionBlock(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert(start >= 0, `Missing ${name} exact-response guard`)
  const end = source.indexOf('\n}\n', start)
  assert(end >= 0, `Could not delimit ${name} exact-response guard`)
  return source.slice(start, end + 2)
}

function checkPendingPaymentRecovery(source) {
  const requireContract = (condition, message) => assert(condition, `Pending payment contract: ${message}`)
  const parse = (text) => ts.createSourceFile('pending.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const tree = parse(source)
  requireContract(tree.parseDiagnostics.length === 0, 'pending-payment source must parse')
  const nodes = []
  const visit = (node) => { nodes.push(node); ts.forEachChild(node, visit) }
  visit(tree)
  // Compare syntax trees, never comments or text-search sentinels. Leaf text is
  // retained so changing a capability binding or state value is a real change.
  const shape = (node) => {
    const children = []
    ts.forEachChild(node, (child) => { children.push(shape(child)) })
    return [node.kind, children.length ? children : (node.text ?? node.getText())]
  }
  const same = (node, expected) => JSON.stringify(shape(node)) === JSON.stringify(shape(expected))
  const statement = (text) => parse(text).statements[0]
  const expression = (text) => statement(`const expected = ${text};`).declarationList.declarations[0].initializer
  const exact = (node, text) => same(node, expression(text))
  const one = (matches, message) => {
    requireContract(matches.length === 1, message)
    return matches[0]
  }
  const declarations = nodes.filter(ts.isVariableDeclaration)
  // Source contract with the Billing route budgets; rendered fake-timer tests
  // exercise these same limits under automatic and explicit recovery reads.
  for (const [name, value] of [
    ['RECOVERY_WINDOW_MS', '15 * 60_000'],
    ['RECOVERY_LIMITS', '{ current: 10, reconcile: 5 } as const'],
    ['SETTLEMENT_POLL_DELAY_MS', '4 * 60_000'],
    ['SETTLEMENT_POLL_MAX_ATTEMPTS', '20'],
  ]) {
    const declaration = one(declarations.filter(node => node.name.getText(tree) === name), name + ' must be explicit')
    requireContract(declaration.initializer && exact(declaration.initializer, value), name + ' must respect the bounded recovery budget')
  }
  const flow = one(declarations.filter((node) => node.name.getText(tree) === 'loadCurrentFlow'), 'one recovery callback is required')
  requireContract(ts.isCallExpression(flow.initializer) && exact(flow.initializer.expression, 'useCallback'), 'recovery callback must remain explicit')
  const callback = flow.initializer.arguments[0]
  requireContract(ts.isArrowFunction(callback) && ts.isBlock(callback.body), 'recovery callback must have a block body')
  const flowNodes = []
  const walkFlow = (node) => { flowNodes.push(node); ts.forEachChild(node, walkFlow) }
  walkFlow(callback.body)
  for (const [condition, body] of [
    ["result.state === 'closed'", "{ setFlowCheckState('ready'); setState('unknown'); return 'stop'; }"],
    ['!recovery', "{ if (stillCurrent()) { setFlowCheckState('ready'); } return 'stop'; }"],
  ]) {
    const branch = one(flowNodes.filter((node) => ts.isIfStatement(node) && exact(node.expression, condition)), `${condition} must fail closed`)
    requireContract(!branch.elseStatement && same(branch.thenStatement, statement(body)), `${condition} cannot release, restart, or confer payment authority`)
  }
  const recoveryReaders = ['getAnonymousPaymentSessionRecovery', 'reconcileAnonymousPaymentSessionRecovery']
  for (const name of recoveryReaders) {
    const call = one(flowNodes.filter((node) => ts.isCallExpression(node) && exact(node.expression, name)), `${name} must be called once`)
    requireContract(call.arguments.length === 1 && exact(call.arguments[0], `({
      fetcher: fetch, billingApiUrl: BILLING_API_URL,
      paymentSessionToken: recovery.paymentSessionToken,
      recoverySecret: recovery.paymentSessionToken,
      requestKey: recovery.requestKey, email: recovery.email
    })`.slice(1, -1)), `${name} must carry the same attempt's email, request key, and proof`)
  }
  // Only proof-bound recovery readers may be imported. Exact released receipts
  // may clear their own capability; generic closed and fresh creation stay sealed.
  const storeCapabilities = new Set(['completeSignup', 'createEtebaseAccount', 'finalizePaidSignup', 'saveSignupStateForRedirect', 'restoreSignupStateFromRedirect', 'pendingSignup', 'recoverCompletedSignupSession'])
  for (const node of nodes) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === '@/app/lib/billing-v2') {
      if (node.importClause?.isTypeOnly) continue
      const bindings = node.importClause?.namedBindings
      requireContract(!node.importClause?.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length === 3
        && bindings.elements.every((item) => !item.propertyName && [...recoveryReaders, 'BillingResponseError'].includes(item.name.text)), 'billing imports are recovery-only; legacy restart must fail closed')
    }
    if (ts.isCallExpression(node) && exact(node.expression, 'useAuthStore')) {
      const selector = node.arguments[0]
      requireContract(node.arguments.length === 1 && ts.isArrowFunction(selector)
        && ts.isPropertyAccessExpression(selector.body) && selector.parameters.length === 1
        && same(selector.body.expression, selector.parameters[0].name)
        && storeCapabilities.has(selector.body.name.text), 'store selectors cannot acquire fresh-payment or release authority')
    }
    if (ts.isPropertyAccessExpression(node) && ts.isCallExpression(node.expression)
      && exact(node.expression.expression, 'useAuthStore.getState')) {
      if (node.name.text !== 'pendingSignup') {
        requireContract(node.name.text === 'clearPendingSignupPaymentRecovery', 'imperative store access cannot create payment')
        let ancestor = node.parent
        while (ancestor && !(ts.isIfStatement(ancestor) && exact(ancestor.expression, "result.state === 'released' && result.release"))) ancestor = ancestor.parent
        requireContract(Boolean(ancestor), 'only an exact released receipt can clear recovery')
        requireContract(exact(node.parent, 'useAuthStore.getState().clearPendingSignupPaymentRecovery({ email: recovery.email, requestKey: recovery.requestKey, recoverySecret: recovery.paymentSessionToken })'), 'release must retain exact proof identity')
      }
    }
    if (ts.isCallExpression(node) && exact(node.expression, 'fetch')) {
      requireContract(false, 'direct transport cannot bypass proof-bound recovery')
    }
    if ((ts.isIdentifier(node) || (ts.isStringLiteral(node) && ts.isCallExpression(node.parent)
      && ts.isPropertyAccessExpression(node.parent.expression) && node.parent.expression.name.text === 'getItem')) && /invoice/i.test(node.text)) {
      requireContract(false, 'unbound local invoice data cannot authorize checkout availability or fresh payment')
    }
  }
  const linkEffect = one(nodes.filter((node) => ts.isVariableDeclaration(node)
    && node.name.getText(tree) === 'params' && node.initializer
    && exact(node.initializer, 'new URLSearchParams(window.location.search)')), 'legacy link handling must remain explicit')
  requireContract(same(linkEffect.parent.parent.parent, statement(`{
    const params = new URLSearchParams(window.location.search);
    if (params.has('email_verification_token') || params.has('token')) setEmailProofUnavailable(true);
  }`)), 'legacy restart links must only disclose unavailable proof, not consume or create authority')
}

export function checkAnnualBillingV2Contract(root = process.cwd()) {
  const schemaBytes = readFileSync(resolve(root, SCHEMA_FILE))
  const pinnedSha = readFileSync(resolve(root, PIN_FILE), 'utf8').trim()
  assert(SHA256.test(pinnedSha), `${PIN_FILE} must contain one lowercase SHA-256`)
  assert(createHash('sha256').update(schemaBytes).digest('hex') === pinnedSha, `${SCHEMA_FILE} does not match its pinned canonical SHA-256`)

  const schema = JSON.parse(schemaBytes)
  const definitions = schema?.$defs
  assert(definitions && typeof definitions === 'object', 'Canonical annual v2 schema lacks definitions')
  assert(JSON.stringify(Object.fromEntries(Object.entries(definitions.Paths.properties).map(([name, shape]) => [name, shape.const]))) === JSON.stringify(canonicalPaths), 'Canonical annual v2 endpoint map drifted')
  for (const name of ['OfferRequest', 'OfferResponse', 'EmailProofRequest', 'EmailProofConsume', 'EmailProofResponse', 'ActivateRequest', 'ActivateResponse', 'ProvisionRequest', 'ProvisionResponse', 'PaymentSessionRequest', 'StripePaymentSessionResponse', 'BtcpayPaymentSessionResponse', 'FinalizeRequest', 'FinalizeResponse', 'AuthenticatedFlowRequest', 'AuthenticatedStripeFlowResponse', 'AuthenticatedBtcpayFlowResponse', 'PaymentSessionRecoveryRequest', 'PaymentSessionRecoveryResponse']) {
    assert(definitions[name]?.additionalProperties === false, `${name} must remain a closed canonical object`)
  }
  assert(JSON.stringify(definitions.Disclosure.properties.periodEndRule.enum) === JSON.stringify(['activation_plus_trial', 'first_charge_plus_1_utc_calendar_year', 'confirmation_plus_1_utc_calendar_year', 'confirmation_bonus_then_1_utc_calendar_year']), 'Canonical disclosure period-end rules drifted')
  assert(JSON.stringify(definitions.EmailProofResponse.required) === JSON.stringify(['contractVersion', 'emailOwnershipToken', 'expiresAt']), 'Canonical email proof response drifted')
  assert(JSON.stringify(definitions.StripePaymentSessionResponse.required) === JSON.stringify(['contractVersion', 'kind', 'clientSecret', 'paymentSessionToken']), 'Canonical Stripe session response drifted')
  assert(JSON.stringify(definitions.BtcpayPaymentSessionResponse.required) === JSON.stringify(['contractVersion', 'kind', 'cryptoCheckoutUrl', 'cryptoInvoiceId', 'cryptoInvoiceLookupToken', 'paymentSessionToken']), 'Canonical BTCPay session response drifted')
  assert(JSON.stringify(definitions.AuthenticatedStripeFlowResponse.required) === JSON.stringify(['contractVersion', 'kind', 'authorityId', 'clientSecret']), 'Canonical authenticated Stripe flow drifted')
  assert(JSON.stringify(definitions.AuthenticatedBtcpayFlowResponse.required) === JSON.stringify(['contractVersion', 'kind', 'authorityId', 'checkoutUrl', 'invoiceId', 'invoiceLookupToken']), 'Canonical authenticated BTCPay flow drifted')
  assert(definitions.PaymentSessionRequest.properties.returnUrl?.$ref === '#/$defs/HttpUrl' && definitions.AuthenticatedFlowRequest.properties.returnUrl?.$ref === '#/$defs/HttpUrl', 'Payment return URLs must share the absolute HTTP(S) definition')
  assert(definitions.HttpUrl?.pattern === '^https?://', 'Payment return URL definition must be absolute HTTP(S)')

  const client = readFileSync(resolve(root, CLIENT_FILE), 'utf8')
  const authStore = readFileSync(resolve(root, AUTH_STORE_FILE), 'utf8')
  const publicV2Callers = `${client}\n${authStore}`
  for (const [name, route] of Object.entries(canonicalPaths)) {
    if (name === 'paymentSessionCurrent' || name === 'paymentSessionReconcile' || name === 'paymentSessionCancel') continue
    assert(publicV2Callers.includes(route), `Public v2 callers do not use canonical route ${route}`)
  }
  assert(client.includes('/auth/signup/payment-session/v2${path}') && client.includes("'/current'") && client.includes("'/reconcile'") && client.includes("'/cancel'"), 'Public v2 client does not use every canonical anonymous recovery route')
  for (const forbidden of ['/auth/email-ownership/v2', 'paymentSessionId', 'recoveryToken', 'cryptoLookupToken', 'confirmation_plus_365_days', 'trial_end_plus_365_days', 'payment_plus_365_days']) assert(!client.includes(forbidden), `Public v2 client contains non-canonical ${forbidden}`)
  assert(!/checkoutIntentToken: params\.checkoutIntentToken,[\s\S]{0,300}provider: params\.provider/.test(client), 'Public v2 payment request sends a caller-selected provider after activation froze authority')
  assert(client.includes('paymentSessionToken') && client.includes('cryptoInvoiceLookupToken') && client.includes('authorityId') && client.includes('checkoutUrl') && client.includes('invoiceId') && client.includes('invoiceLookupToken'), 'Public v2 client does not validate every canonical payment authority shape')

  const noCard = functionBlock(authStore, 'isExactNoCardProvision')
  const finalized = functionBlock(authStore, 'isExactV2PaidFinalization')
  assert(noCard.includes('earlyAdopter') && !noCard.includes('isAdmin'), 'No-card finalization must require earlyAdopter and must not invent isAdmin')
  assert(finalized.includes('earlyAdopter') && finalized.includes('isAdmin'), 'Paid finalization must require the exact canonical earlyAdopter and isAdmin fields')
  assert(!authStore.includes('payment.recoveryToken') && !authStore.includes('payment.cryptoLookupToken'), 'Signup persistence still uses non-canonical payment response fields')

  const paymentPanel = readFileSync(resolve(root, PAYMENT_PANEL_FILE), 'utf8')
  assert(!paymentPanel.includes('data.cryptoCheckoutUrl') && !paymentPanel.includes('data.cryptoInvoiceId') && !paymentPanel.includes('data.cryptoLookupToken'), 'Authenticated payment UI still expects signup-only BTCPay response fields')

  // The signed offer is the single public presentation authority.  These
  // byte-level controls make a pricing/provider regression noisy even before
  // component tests run against the standard offer.
  const signup = readFileSync(resolve(root, SIGNUP_PAGE_FILE), 'utf8')
  const pendingPayment = readFileSync(resolve(root, PENDING_PAYMENT_FILE), 'utf8')
  const presentation = readFileSync(resolve(root, OFFER_PRESENTATION_FILE), 'utf8')
  const analytics = readFileSync(resolve(root, PUBLIC_ANALYTICS_FILE), 'utf8')
  for (const source of [signup, paymentPanel]) {
    assert(source.includes('annualOfferPlanLabel') && source.includes('annualOfferAnnualLabel'), 'Public annual UI must derive class and amount from the canonical offer')
    assert(source.includes("isAnnualOfferProviderAvailable") && source.includes("'stripe'") && source.includes("'btcpay'"), 'Public annual UI must gate Stripe and BTCPay with canonical offer providers')
  }
  assert(paymentPanel.includes('annualOfferRenewalCopy'), 'Authenticated annual UI must derive renewal copy from the canonical offer')
  // Signup now puts validated disclosure terms beside the form/QR, rather than
  // repeating offer-only annual wording on the initial trial-choice screen.
  const signupTree = ts.createSourceFile('signup.tsx', signup, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const termsTree = ts.createSourceFile('terms.tsx', functionBlock(readFileSync(resolve(root, SIGNUP_TERMS_FILE), 'utf8'), 'AnnualTermsSummary'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const suppliedDisclosures = new Set()
  const readDisclosureFields = new Set()
  const visitSignup = (node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(signupTree) === 'AnnualTermsSummary') {
      const attribute = node.attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText(signupTree) === 'disclosure')
      if (attribute?.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) suppliedDisclosures.add(attribute.initializer.expression.getText(signupTree))
    }
    ts.forEachChild(node, visitSignup)
  }
  const visitTerms = (node) => {
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(termsTree) === 'disclosure') readDisclosureFields.add(node.name.text)
    ts.forEachChild(node, visitTerms)
  }
  visitSignup(signupTree)
  visitTerms(termsTree)
  assert(suppliedDisclosures.has('disclosure') && suppliedDisclosures.has('cardDisclosure'), 'Signup terms must render the validated disclosure for card and Bitcoin')
  for (const field of ['kind', 'firstChargeAmountMinor', 'firstChargeAt', 'autoRenew', 'renewalAmountMinor', 'refundWindowDays']) {
    assert(readDisclosureFields.has(field), `Signup terms must derive ${field} from the validated disclosure`)
  }
  assert(signup.includes('annualOffer={annualOffer}'), 'Signup must pass the signed annual offer through StepChoosePlan')
  checkPendingPaymentRecovery(pendingPayment)
  for (const forbiddenPresentationConstant of [/&euro;36/, /€36(?:\.00)?(?:\/year)?/, /€3(?:\.00)?(?:\/month)?/, /Early Adopter(?: Plan)?/]) {
    assert(!forbiddenPresentationConstant.test(signup) && !forbiddenPresentationConstant.test(paymentPanel), `Public annual UI contains reintroduced fixed offer copy: ${forbiddenPresentationConstant}`)
  }
  assert(presentation.includes('annualAmountMinor') && presentation.includes('monthlyEquivalentMinor') && presentation.includes('customerClass') && presentation.includes('planId') && presentation.includes('providers'), 'Annual presentation helpers must use canonical class, plan, amount, and provider fields')
  assert(analytics.includes('annualOfferAnalyticsDimensions(offer)') && presentation.includes('plan_id') && presentation.includes('customer_class') && presentation.includes('annual_amount_minor') && presentation.includes('monthly_equivalent_minor'), 'Signup analytics must use non-identifying dimensions from the canonical offer')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { checkAnnualBillingV2Contract() } catch (error) { process.stderr.write(`Annual billing v2 contract guard rejected: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1 }
}
