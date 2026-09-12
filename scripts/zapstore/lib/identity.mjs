// Source admission for the Zapstore lane. The trusted helper is the same
// script the release controller runs: tag grammar, live tag identity,
// protected-main ancestry, and both v* tag rulesets. It is executed from the
// protected workflow checkout, never from the release tag's tree.

import { spawnSync } from 'node:child_process'

export const IDENTITY_HELPER = 'scripts/verify-release-identity.sh'
export const PROTECTED_REF = 'refs/heads/main'
export const WORKFLOW_PATH_SUFFIX = '.github/workflows/zapstore-publish.yml'

// The workflow *definition* must come from protected main. `GITHUB_REF` is the
// wrong signal for `release` events (it is the tag); `GITHUB_WORKFLOW_REF` is
// `{owner}/{repo}/{path}@{ref}` and names the loaded file.
export function requireProtectedWorkflow(workflowRef, { repository, expectedRef = PROTECTED_REF } = {}) {
  const value = String(workflowRef ?? '')
  const at = value.lastIndexOf('@')
  if (at <= 0) throw new Error('refusing run: GITHUB_WORKFLOW_REF is missing or malformed')
  const loadedPath = value.slice(0, at)
  const loadedRef = value.slice(at + 1)
  if (!loadedPath.endsWith(WORKFLOW_PATH_SUFFIX)) {
    throw new Error(`refusing run: workflow path ${loadedPath} is not ${WORKFLOW_PATH_SUFFIX}`)
  }
  if (repository && !loadedPath.startsWith(`${repository}/`)) {
    throw new Error(`refusing run: workflow ${loadedPath} is not this repository's`)
  }
  if (loadedRef !== expectedRef) {
    throw new Error(`refusing run: workflow was loaded from ${loadedRef}, not ${expectedRef}`)
  }
  return true
}

export function verifySourceIdentity({
  tag,
  commit,
  stage = 'zapstore-binding',
  helperPath = IDENTITY_HELPER,
  gitAncestry = null,
  env = process.env,
  spawn = spawnSync,
} = {}) {
  if (typeof tag !== 'string' || tag === '') throw new Error('identity helper requires --tag')
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) throw new Error('identity helper requires a 40-hex commit')
  const args = [helperPath, '--tag', tag, '--commit', commit, '--stage', stage]
  if (gitAncestry) args.push('--git-ancestry', gitAncestry)
  const result = spawn('bash', args, {
    encoding: 'utf8',
    env: {
      PATH: env.PATH ?? '/usr/bin:/bin',
      HOME: env.HOME ?? '/tmp',
      GITHUB_REPOSITORY: env.GITHUB_REPOSITORY ?? '',
      GITHUB_API_URL: env.GITHUB_API_URL ?? 'https://api.github.com',
      ...(env.GITHUB_TOKEN ? { GITHUB_TOKEN: env.GITHUB_TOKEN } : {}),
      // The helper treats GITHUB_REF as "where this workflow was loaded from".
      // Callers must already have proven that via GITHUB_WORKFLOW_REF; a
      // release-event tag ref would false-refuse a legitimate protected load.
      GITHUB_REF: PROTECTED_REF,
    },
  })
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(-800)
    throw new Error(`release identity helper refused (${stage}): ${detail || `exit ${result.status}`}`)
  }
  return true
}
