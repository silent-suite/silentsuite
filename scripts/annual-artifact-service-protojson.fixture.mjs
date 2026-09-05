// Test-only strict wire contract for github.actions.results.api.v1.ArtifactService requests.
// The shapes are the exact ProtoJSON output of the official @actions/artifact 6.2.0 client
// (@protobuf-ts/runtime 2.11.1) bundled in actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
// (v7.0.1): `toJson(request, { useProtoFieldName: true, emitDefaultValues: false })`.
// google.protobuf.StringValue and Int64Value fields are bare JSON scalars, never `{ value }`;
// int64 fields are decimal strings; int32 fields are JSON numbers; Timestamp fields are
// RFC 3339 strings. A conformant ProtoJSON server rejects any other form, including unknown
// members, so the mock service in the publisher test enforces exactly this.
export const officialWireFixtures = Object.freeze({
  CreateArtifact: { workflow_run_backend_id: 'run-b', workflow_job_run_backend_id: 'job-b', name: 'n', version: 7, mime_type: 'application/zip' },
  CreateArtifactWithExpiry: { workflow_run_backend_id: 'run-b', workflow_job_run_backend_id: 'job-b', name: 'n', expires_at: '2026-09-05T00:00:00Z', version: 7, mime_type: 'application/zip' },
  ListArtifacts: { workflow_run_backend_id: 'run-b', workflow_job_run_backend_id: 'job-b' },
  ListArtifactsWithFilters: { workflow_run_backend_id: 'run-b', workflow_job_run_backend_id: 'job-b', name_filter: 'n', id_filter: '77' },
  FinalizeArtifact: { workflow_run_backend_id: 'run-b', workflow_job_run_backend_id: 'job-b', name: 'n', size: '1234', hash: 'sha256:abc' },
})
const string = (value) => typeof value === 'string'
const nonEmptyString = (value) => string(value) && value.length > 0
// ProtoJSON accepts an int64 as a decimal string or a JSON integer; the official client emits the string.
const int64 = (value) => (string(value) && /^-?(0|[1-9][0-9]*)$/.test(value)) || (Number.isSafeInteger(value))
const int32 = (value) => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
const timestamp = (value) => string(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(value)
const identity = { workflow_run_backend_id: { check: nonEmptyString, required: true }, workflow_job_run_backend_id: { check: nonEmptyString, required: true } }
const schemas = {
  CreateArtifact: { ...identity, name: { check: nonEmptyString, required: true }, expires_at: { check: timestamp }, version: { check: int32 }, mime_type: { check: string } },
  ListArtifacts: { ...identity, name_filter: { check: string }, id_filter: { check: int64 } },
  FinalizeArtifact: { ...identity, name: { check: nonEmptyString, required: true }, size: { check: int64 }, hash: { check: string } },
}
// Returns undefined when `body` is a valid ProtoJSON request for `method`, otherwise a reason.
export function validateArtifactServiceRequest(method, body) {
  const schema = schemas[method]
  if (!schema) return `unknown method ${method}`
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'request body is not a JSON object'
  for (const key of Object.keys(body)) if (!(key in schema)) return `unknown field ${key}`
  for (const [field, { check, required }] of Object.entries(schema)) {
    if (!(field in body)) { if (required) return `missing field ${field}`; continue }
    if (!check(body[field])) return `field ${field} is not in ProtoJSON form`
  }
  return undefined
}
