// The owner-authorized manual publication request
// (.github/workflows/zapstore-manual-publish.yml): the exact release a manual
// run may publish, and the checks that keep it to that release.
//
// The request is untrusted text from the dispatch form. It reaches this module
// only through the environment, is matched against a strict grammar with no
// trimming, and stays a canonical string: numeric identifiers are bounded to
// the safe integer range before anything converts them to a number.

const DECIMAL_ID = /^[1-9][0-9]{0,15}$/
const MAX_SAFE_ID = BigInt(Number.MAX_SAFE_INTEGER)

function exactId(value) {
  return typeof value === 'string' && DECIMAL_ID.test(value) && BigInt(value) <= MAX_SAFE_ID
}

const hex = (length) => (value) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value)

const FIELDS = {
  releaseId: { env: 'MANUAL_RELEASE_ID', input: 'release_id', valid: exactId, grammar: 'a positive decimal release id within the safe integer range' },
  sourceSha: { env: 'MANUAL_EXPECTED_SOURCE_SHA', input: 'expected_source_sha', valid: hex(40), grammar: 'a 40-hex lowercase commit' },
  apkAssetId: { env: 'MANUAL_EXPECTED_APK_ASSET_ID', input: 'expected_apk_asset_id', valid: exactId, grammar: 'a positive decimal asset id within the safe integer range' },
  apkSha256: { env: 'MANUAL_EXPECTED_APK_SHA256', input: 'expected_apk_sha256', valid: hex(64), grammar: 'a 64-hex lowercase SHA-256' },
  workflowSha: { env: 'MANUAL_EXPECTED_WORKFLOW_SHA', input: 'expected_workflow_sha', valid: hex(40), grammar: 'a 40-hex lowercase commit' },
}

export const APPROVED_BINDING_FIELDS = ['releaseId', 'sourceSha', 'apkAssetId', 'apkSha256']
export const MANUAL_REQUEST_FIELDS = [...APPROVED_BINDING_FIELDS, 'workflowSha']

// Missing and malformed are the same refusal. The offending value is never
// echoed: it is arbitrary dispatch input.
export function parseManualPublishRequest(env, fields = APPROVED_BINDING_FIELDS) {
  const request = {}
  for (const name of fields) {
    const field = FIELDS[name]
    if (!field) throw new Error(`unknown manual publication field ${String(name)}`)
    const value = env[field.env]
    if (!field.valid(value)) throw new Error(`refusing manual publication: input ${field.input} must be ${field.grammar}`)
    request[name] = value
  }
  return request
}

// The requested release must be the single newest eligible release of a fresh
// enumeration. It is the only candidate this lane keeps; every other eligible
// release is reported as omitted and is never assessed or published here.
export function selectManualCandidate({ candidates, omitted = [] }, releaseId) {
  const publishable = candidates.filter((c) => c.publishable === true)
  if (publishable.length === 0) throw new Error(`release ${releaseId} is not the newest eligible release: no eligible release exists; refusing`)
  if (publishable.length !== 1) throw new Error(`expected exactly one newest eligible release, found ${publishable.length}`)
  const [newest] = publishable
  if (!Number.isSafeInteger(newest.releaseId) || String(newest.releaseId) !== releaseId) {
    throw new Error(`release ${releaseId} is not the newest eligible release ${newest.releaseId} (${newest.tag}); refusing`)
  }
  const others = candidates.filter((c) => c !== newest).map((c) => ({ releaseId: c.releaseId, tag: c.tag, reason: 'not the manually requested release; the manual lane never assesses or publishes history' }))
  return { candidates: [newest], omitted: [...omitted, ...others] }
}

// Four-way equality between a binding and the approved request.
export function requireApprovedBinding(binding, request) {
  const exact = (value) => (Number.isSafeInteger(value) && value > 0 ? String(value) : null)
  const differences = []
  if (exact(binding?.releaseId) !== request.releaseId) differences.push('release id')
  if (binding?.sourceSha !== request.sourceSha) differences.push('source commit')
  if (exact(binding?.assets?.apk?.id) !== request.apkAssetId) differences.push('APK asset id')
  if (binding?.assets?.apk?.sha256 !== request.apkSha256) differences.push('APK sha256')
  if (differences.length) throw new Error(`bound release is not the approved manual publication request: ${differences.join(', ')} differ`)
  return true
}
