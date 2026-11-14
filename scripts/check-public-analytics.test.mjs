import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const endpoint = '/api/event'

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

test('generated scans reject the upstream analytics host in browser chunks', async () => {
  await withGeneratedAppTree({
    'signup/layout-a.js': `${endpoint} keepalive:!0`,
    'signup/page-a.js': 'fetch("https://plausible.silentsuite.io/api/event")',
  }, async (root) => {
    assert.match(await checkGeneratedAuthTree(root), /signup\/page-a\.js: upstream analytics host in browser bundle/)
  })
  await withGeneratedAppTree({
    'settings/subscription/page-a.js': `${endpoint} plausible.silentsuite.io`,
  }, async (root) => {
    assert.match(await checkGeneratedAppTree(root), /settings\/subscription\/page-a\.js: upstream analytics host in browser bundle/)
  })
})

// A real build nests route chunks at .next/static/chunks/app/(app) and lists every
// chunk a route loads in .next/app-build-manifest.json.
async function withManifestBuild(files, manifest, run) {
  await withGeneratedAppTree({
    ...Object.fromEntries(Object.entries(files).map(([file, contents]) => [`.next/${file}`, contents])),
    '.next/app-build-manifest.json': JSON.stringify({ pages: manifest }),
  }, (root) => run(path.join(root, '.next/static/chunks/app/(app)')))
}

test('enabled generated app scan accepts the endpoint in a shared chunk the subscription route loads', async () => {
  await withManifestBuild({
    'static/chunks/app/(app)/settings/subscription/page-a.js': 'console.log("subscription")',
    'static/chunks/9704-a.js': `${endpoint} keepalive:!0`,
  }, {
    '/(app)/settings/subscription/page': ['static/chunks/9704-a.js', 'static/chunks/app/(app)/settings/subscription/page-a.js'],
  }, async (appRoot) => {
    assert.equal(await checkGeneratedAppTree(appRoot), '')
  })
})

test('enabled generated app scan rejects a shared endpoint chunk loaded by another authenticated route', async () => {
  await withManifestBuild({
    'static/chunks/app/(app)/settings/subscription/page-a.js': 'console.log("subscription")',
    'static/chunks/app/(app)/calendar/page-b.js': 'console.log("calendar")',
    'static/chunks/9704-a.js': endpoint,
  }, {
    '/(app)/settings/subscription/page': ['static/chunks/9704-a.js', 'static/chunks/app/(app)/settings/subscription/page-a.js'],
    '/(app)/calendar/page': ['static/chunks/9704-a.js', 'static/chunks/app/(app)/calendar/page-b.js'],
  }, async (appRoot) => {
    assert.match(await checkGeneratedAppTree(appRoot), /\/\(app\)\/calendar\/page: analytics endpoint in authenticated production bundle/)
  })
})

test('enabled generated app scan still fails when no chunk the subscription route loads carries the endpoint', async () => {
  await withManifestBuild({
    'static/chunks/app/(app)/settings/subscription/page-a.js': 'console.log("subscription")',
    'static/chunks/9704-a.js': endpoint,
  }, {
    '/(app)/settings/subscription/page': ['static/chunks/app/(app)/settings/subscription/page-a.js'],
    '/(auth)/signup/page': ['static/chunks/9704-a.js'],
  }, async (appRoot) => {
    assert.match(await checkGeneratedAppTree(appRoot), /subscription route chunk: expected analytics endpoint absent/)
  })
})

async function checkGeneratedStaticTree(root, env = {}) {
  try {
    await execFileAsync(process.execPath, [
      'scripts/check-public-analytics.mjs',
      `--generated-app-root=${path.join(root, 'absent-app-root')}`,
      `--generated-auth-root=${path.join(root, 'absent-auth-root')}`,
      `--generated-static-root=${root}`,
    ], { env: { ...process.env, NEXT_PUBLIC_SENTRY_DSN: '', NEXT_PUBLIC_WEB_VITALS_ENABLED: '', ...env } })
    return ''
  } catch (error) {
    return `${error.stdout}\n${error.stderr}`
  }
}

test('static scan rejects telemetry senders in a build without their gates', async () => {
  await withGeneratedAppTree({
    'chunks/main-app-1.js': 'fetch("/api/error",{keepalive:!0})',
    'chunks/app/(auth)/layout-1.js': 'name:"Web Vital",url:"https://app.silentsuite.io/login"',
  }, async (root) => {
    const output = await checkGeneratedStaticTree(root)
    assert.match(output, /main-app-1\.js: error reporter present without NEXT_PUBLIC_SENTRY_DSN/)
    assert.match(output, /layout-1\.js: speed reporter present without NEXT_PUBLIC_WEB_VITALS_ENABLED=true/)
  })
})

test('static scan permits telemetry senders when their build gates are given', async () => {
  await withGeneratedAppTree({
    'chunks/main-app-1.js': 'fetch("/api/error",{keepalive:!0})',
    'chunks/app/(auth)/layout-1.js': 'name:"Web Vital"',
  }, async (root) => {
    assert.equal(await checkGeneratedStaticTree(root, { NEXT_PUBLIC_SENTRY_DSN: 'https://k@errors.example/1', NEXT_PUBLIC_WEB_VITALS_ENABLED: 'true' }), '')
  })
})

test('static scan rejects tracing, session replay and served source maps in every build', async () => {
  for (const marker of ['rrweb', 'name:"Replay"', '"BrowserTracing"']) {
    await withGeneratedAppTree({ 'chunks/1.js': `x(${marker})` }, async (root) => {
      const output = await checkGeneratedStaticTree(root, { NEXT_PUBLIC_SENTRY_DSN: 'https://k@errors.example/1' })
      assert.match(output, /tracing or session replay code in browser bundle/, marker)
    })
  }
  await withGeneratedAppTree({ 'chunks/1.js': 'ok', 'chunks/1.js.map': '{}' }, async (root) => {
    assert.match(await checkGeneratedStaticTree(root), /source map in served static output/)
  })
})
