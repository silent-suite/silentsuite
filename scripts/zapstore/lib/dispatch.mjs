// Trigger admission for the Zapstore lane. Mirrors the release controller: the
// numeric sender id is compared before any payload is interpreted, the payload
// has exactly three keys with strict grammars, and code only ever runs from the
// protected default branch.

import { TAG_GRAMMAR } from './eligibility.mjs'

export const OWNER_ID = '265568982'
export const DISPATCH_EVENT_TYPE = 'silentsuite_zapstore_publish'
export const PROTECTED_REF = 'refs/heads/main'

export function requireOwnerSender(senderId, ownerId = OWNER_ID) {
  const value = String(senderId ?? '')
  if (!/^[0-9]+$/.test(value)) throw new Error('refusing dispatch: no numeric sender id')
  if (value !== ownerId) throw new Error(`refusing dispatch: sender id ${value} is not the release owner`)
  return true
}

export function requireProtectedRef(ref, expected = PROTECTED_REF) {
  if (ref !== expected) throw new Error(`refusing run: workflow ref ${String(ref)} is not ${expected}`)
  return true
}

export function validateDispatchPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('refusing dispatch: payload is not an object')
  const keys = Object.keys(payload).sort().join(',')
  if (keys !== 'release_id,release_tag,source_sha') throw new Error(`refusing dispatch: payload keys are '${keys}', expected 'release_id,release_tag,source_sha'`)
  const { release_id: id, release_tag: tag, source_sha: sha } = payload
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,15}$/.test(id)) throw new Error('refusing dispatch: release_id is not a positive integer string')
  if (typeof tag !== 'string' || !TAG_GRAMMAR.test(tag)) throw new Error('refusing dispatch: release_tag is not an eligible SilentSuite tag')
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('refusing dispatch: source_sha is not a 40-hex commit id')
  return { releaseId: Number(id), tag, sourceSha: sha }
}

// The activation switch is a repository variable that does not exist today.
// Anything other than the exact word `enabled` keeps the lane dormant, and the
// result is reported loudly rather than as a green no-op.
export function activationState(value) {
  if (value === 'enabled') return { active: true, label: 'ENABLED' }
  if (value === 'rehearsal') return { active: false, rehearsal: true, label: 'REHEARSAL (classification only, no publication)' }
  return { active: false, label: 'DISABLED (ZAPSTORE_AUTOMATION_ENABLED is not "enabled"; nothing will be published)' }
}
