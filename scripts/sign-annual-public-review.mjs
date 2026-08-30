import { createHash, createHmac } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const env = process.env
const sha = /^[0-9a-f]{40}$/
const key = env.ANNUAL_PUBLIC_REVIEW_HMAC_KEY
if (!sha.test(env.PUBLIC_SHA ?? '') || !key || key.length < 32) throw new Error('public review signing inputs are invalid')
const runId = Number(env.PUBLIC_RUN_ID); const runAttempt = Number(env.PUBLIC_RUN_ATTEMPT)
if (!Number.isInteger(runId) || runId < 1 || !Number.isInteger(runAttempt) || runAttempt < 1) throw new Error('public review run identity is invalid')
const sourcePath = 'contracts/annual-only-billing-v2.schema.json'
const sourceBytes = await readFile(sourcePath)
const source = JSON.parse(sourceBytes)
const serializedDigest = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
const bytesDigest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const sign = (unsigned) => createHmac('sha256', key).update(serializedDigest(unsigned)).digest('hex')
const disclosureUnsigned = { schemaVersion: 2, predicateType: 'https://silentsuite.io/attestations/annual-only-public-disclosure/v2', publicSha: env.PUBLIC_SHA, disclosure: { contractVersion: 2, source: sourcePath, sourceDigest: bytesDigest(sourceBytes), offer: { planIds: source.$defs.Offer.properties.planId.enum, billingInterval: source.$defs.Offer.properties.billingInterval.const, currency: source.$defs.Offer.properties.currency.const, providers: source.$defs.Offer.properties.providers.items.enum } } }
const disclosureBytes = Buffer.from(`${JSON.stringify({ ...disclosureUnsigned, signature: sign(disclosureUnsigned) })}\n`)
const reviewUnsigned = { schemaVersion: 2, predicateType: 'https://silentsuite.io/attestations/annual-only-public-review/v2', repository: 'silent-suite/silentsuite', publicSha: env.PUBLIC_SHA, runId, runAttempt, disclosureDigest: bytesDigest(disclosureBytes) }
const output = env.ANNUAL_PUBLIC_REVIEW_OUTPUT_DIRECTORY ?? '.'
await mkdir(output, { recursive: true, mode: 0o700 })
await writeFile(`${output}/annual-only-public-disclosure.json`, disclosureBytes, { mode: 0o600 })
await writeFile(`${output}/annual-only-public-review.json`, `${JSON.stringify({ ...reviewUnsigned, signature: sign(reviewUnsigned) })}\n`, { mode: 0o600 })
