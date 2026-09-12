// Trigger admission for the Zapstore lane.
//
// Not a second GitHub-release control plane: never writes a GitHub release,
// never `repository_dispatch`, never `workflow_dispatch`.
//
// Exact on-demand retry uses GitHub `release` published/edited events. GitHub
// loads that workflow YAML from the default branch; this lane then checks out
// `refs/heads/main` (never `github.sha` / `github.workflow_sha`, which name the
// tag on release events). The owner numeric sender id is compared before the
// release id is used. The daily schedule covers GITHUB_TOKEN-suppressed events
// and late APK attachment by enumerating exact published release ids.
//
// Wiring this into release-controller.yml is not permitted here: that dispatch
// re-runs Android signing and the umbrella draft. Adding a second dispatch
// type or job to the controller is rejected by existing exact-set gates.

import { TAG_GRAMMAR } from './eligibility.mjs'
import { requireProtectedWorkflow } from './identity.mjs'

export const OWNER_ID = '265568982'
export const PROTECTED_REF = 'refs/heads/main'

export function requireOwnerSender(senderId, ownerId = OWNER_ID) {
  const value = String(senderId ?? '')
  if (!/^[0-9]+$/.test(value)) throw new Error('refusing trigger: no numeric sender id')
  if (value !== ownerId) throw new Error(`refusing trigger: sender id ${value} is not the release owner`)
  return true
}

export function requireProtectedRef(ref, expected = PROTECTED_REF) {
  if (ref !== expected) throw new Error(`refusing run: workflow ref ${String(ref)} is not ${expected}`)
  return true
}

export { requireProtectedWorkflow }

export function validateReleaseEvent({ id, tag, draft }) {
  if (draft === true || draft === 'true') throw new Error('refusing trigger: draft releases are never published to Zapstore')
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,15}$/.test(id)) throw new Error('refusing trigger: release_id is not a positive integer string')
  if (typeof tag !== 'string' || !TAG_GRAMMAR.test(tag)) throw new Error('refusing trigger: release_tag is not an eligible SilentSuite tag')
  return { releaseId: Number(id), tag, sourceSha: null }
}

export function admitTrigger(eventName) {
  if (eventName === 'schedule') return 'schedule'
  if (eventName === 'release') return 'release'
  throw new Error(`unsupported event ${String(eventName)}; Zapstore admits only protected-main schedule and owner release events (no repository_dispatch or workflow_dispatch)`)
}

export function activationState(value) {
  if (value === 'enabled') return { active: true, label: 'ENABLED' }
  if (value === 'rehearsal') return { active: false, rehearsal: true, label: 'REHEARSAL (classification only, no publication)' }
  return { active: false, label: 'DISABLED (ZAPSTORE_AUTOMATION_ENABLED is not "enabled"; nothing will be published)' }
}
