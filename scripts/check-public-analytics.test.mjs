import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const endpoint = 'https://plausible.silentsuite.io/api/event'

async function withGeneratedAppTree(files, run) {
  const root = await mkdtemp(path.join(tmpdir(), 'public-analytics-'))
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const file = path.join(root, relativePath)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, contents)
    }
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function checkGeneratedAppTree(root) {
  try {
    await execFileAsync(process.execPath, [
      'scripts/check-public-analytics.mjs',
      '--enabled-generated-build',
      `--generated-app-root=${root}`,
    ])
    return ''
  } catch (error) {
    return `${error.stdout}\n${error.stderr}`
  }
}

// The signup (auth) scan is baseline-specific: the pageview sender lives in
// signup-analytics.tsx, which only the signup layout imports, so its transport
// literals must survive into the emitted signup layout chunk. Commercial modules
// reach only page entries, and the shared 'pageview' literal lives in the common
// builder module — neither may satisfy this assertion.
async function checkGeneratedAuthTree(root, extraArguments = []) {
  try {
    await execFileAsync(process.execPath, [
      'scripts/check-public-analytics.mjs',
      `--generated-app-root=${path.join(root, 'absent-app-root')}`,
      `--generated-auth-root=${root}`,
      ...extraArguments,
    ])
    return ''
  } catch (error) {
    return `${error.stdout}\n${error.stderr}`
  }
}

const commercialPageChunk = `${endpoint} keepalive:!0 "pageview" buildSignupPageviewPayload`

test('generated auth scan rejects a commercial page chunk standing in for the baseline sender', async () => {
  await withGeneratedAppTree({
    'signup/page-a.js': commercialPageChunk,
  }, async (root) => {
    assert.match(
      await checkGeneratedAuthTree(root),
      /signup layout chunk: expected baseline pageview transport absent/,
    )
  })
})

test('generated auth scan rejects a stub signup layout chunk alongside a populated commercial chunk', async () => {
  await withGeneratedAppTree({
    'signup/layout-a.js': 'console.log("layout")',
    'signup/page-a.js': commercialPageChunk,
  }, async (root) => {
    assert.match(
      await checkGeneratedAuthTree(root),
      /signup layout chunk: expected baseline pageview transport absent/,
    )
  })
})

test('generated auth scan rejects a signup layout chunk missing the keepalive fallback', async () => {
  await withGeneratedAppTree({
    'signup/layout-a.js': endpoint,
    'signup/page-a.js': commercialPageChunk,
  }, async (root) => {
    assert.match(
      await checkGeneratedAuthTree(root),
      /signup layout chunk: expected baseline pageview transport absent/,
    )
  })
})

test('generated auth scan permits a signup layout chunk carrying the baseline transport', async () => {
  await withGeneratedAppTree({
    'signup/layout-a.js': `${endpoint} keepalive:!0`,
    'signup/page-a.js': commercialPageChunk,
  }, async (root) => {
    assert.equal(await checkGeneratedAuthTree(root), '')
  })
})

test('generated auth scan enforces the baseline transport in both build flag modes', async () => {
  await withGeneratedAppTree({
    'signup/page-a.js': commercialPageChunk,
  }, async (root) => {
    assert.match(
      await checkGeneratedAuthTree(root, ['--enabled-generated-build']),
      /signup layout chunk: expected baseline pageview transport absent/,
    )
  })
})

test('generated auth scan rejects an unresolved signup analytics flag literal', async () => {
  await withGeneratedAppTree({
    'signup/layout-a.js': `${endpoint} keepalive:!0`,
    'signup/page-a.js': 'process.env.NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED',
  }, async (root) => {
    assert.match(
      await checkGeneratedAuthTree(root),
      /signup\/page-a\.js: unresolved signup analytics flag literal in public bundle/,
    )
  })
})

test('enabled generated app scan fails closed when the subscription route chunk lacks the approved endpoint', async () => {
  await withGeneratedAppTree({
    'settings/subscription/page-a.js': 'console.log("subscription")',
  }, async (root) => {
    assert.match(await checkGeneratedAppTree(root), /subscription route chunk: expected analytics endpoint absent/)
  })
})

test('enabled generated app scan rejects endpoint contamination in sibling authenticated chunks', async () => {
  await withGeneratedAppTree({
    'settings/subscription/page-a.js': endpoint,
    'calendar/page-b.js': endpoint,
  }, async (root) => {
    assert.match(await checkGeneratedAppTree(root), /calendar\/page-b\.js: analytics endpoint in authenticated production bundle/)
  })
})

test('enabled generated app scan permits the endpoint only in the subscription route chunk', async () => {
  await withGeneratedAppTree({
    'settings/subscription/page-a.js': endpoint,
  }, async (root) => {
    assert.equal(await checkGeneratedAppTree(root), '')
  })
})
