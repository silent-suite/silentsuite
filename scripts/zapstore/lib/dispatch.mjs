// Trigger admission for the Zapstore lane.
//
// Exactly one trigger is admitted: a `schedule` run whose definition was loaded
// from protected main. GitHub loads scheduled workflows from the default
// branch, so `GITHUB_SHA` is both the definition revision and the code revision
// every job checks out. `release` events are refused because GitHub loads that
// workflow from the tagged commit; `repository_dispatch` and `workflow_dispatch`
// are refused because they would be a second control plane or a selected-ref
// load. Nothing here fabricates a ref: every value comes from the run context.

import { requireProtectedWorkflow } from './identity.mjs'

export const PROTECTED_REF = 'refs/heads/main'

export function requireProtectedRef(ref, expected = PROTECTED_REF) {
  if (ref !== expected) throw new Error(`refusing run: workflow ref ${String(ref)} is not ${expected}`)
  return true
}

export { requireProtectedWorkflow }

export function admitTrigger(eventName) {
  if (eventName === 'schedule') return 'schedule'
  throw new Error(`unsupported event ${String(eventName)}; Zapstore admits only protected-main schedule runs (no release, repository_dispatch or workflow_dispatch)`)
}

// Returns the protected revision the whole run is bound to.
export function requireProtectedSchedule({ eventName, ref, workflowRef, sha, workflowSha, repository }) {
  admitTrigger(eventName)
  requireProtectedRef(ref)
  requireProtectedWorkflow(workflowRef, { repository })
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('refusing run: GITHUB_SHA is not a 40-hex commit')
  if (typeof workflowSha !== 'string' || workflowSha !== sha) throw new Error(`refusing run: GITHUB_WORKFLOW_SHA ${String(workflowSha)} is not the run commit ${sha}`)
  return { revision: sha }
}

export function activationState(value) {
  if (value === 'enabled') return { active: true, label: 'ENABLED' }
  if (value === 'rehearsal') return { active: false, rehearsal: true, label: 'REHEARSAL (enumeration and assessment only, no publication)' }
  return { active: false, label: 'DISABLED (ZAPSTORE_AUTOMATION_ENABLED is not "enabled"; nothing will be published)' }
}
