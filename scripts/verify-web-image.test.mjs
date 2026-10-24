import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('image paths map only inside the shipped application', async () => {
  assert.ok(existsSync(new URL('./verify-web-image.mjs', import.meta.url)), 'image verifier is required')
  const { imagePathToStandalone } = await import('./verify-web-image.mjs')
  assert.equal(imagePathToStandalone('/app/node_modules/next/index.js'),
    'apps/web/.next/standalone/node_modules/next/index.js')
  for (const path of ['/etc/passwd', '/app/../etc/passwd', '/application/file', '/app//file']) {
    assert.throws(() => imagePathToStandalone(path))
  }
})

test('checkout, merge parent, image and served identity must bind to one SHA', async () => {
  const { verifyIdentity } = await import('./verify-web-image.mjs')
  assert.equal(typeof verifyIdentity, 'function', 'identity verifier is required')
  const sha = 'a'.repeat(40), pr = 'b'.repeat(40)
  const input = { testedSha: sha, prHeadSha: pr, eventName: 'pull_request', headSha: sha,
    commitObject: `tree ${'c'.repeat(40)}\nparent ${'d'.repeat(40)}\nparent ${pr}\n\nsubject`,
    image: { Config: { User: 'nextjs', Labels: { 'org.opencontainers.image.revision': sha },
      Env: [`SILENTSUITE_PUBLIC_BUILD_SHA=${sha}`] } },
    route: { status: 200, body: { publicSha: sha }, cacheControl: 'private, no-store' } }
  assert.equal(verifyIdentity(input), 'pull_request: direct second parent verified')
  for (const change of [
    { testedSha: 'not-a-sha' }, { headSha: pr }, { prHeadSha: 'x'.repeat(40) },
    { eventName: 'workflow_dispatch' }, { commitObject: `parent ${pr}\n\nbody` },
    { commitObject: `${input.commitObject.split('\n\n')[0]}\nparent ${sha}\n\nbody` },
    { route: { ...input.route, status: 503 } },
    { route: { ...input.route, body: { publicSha: pr } } },
    { route: { ...input.route, cacheControl: 'public, max-age=600' } },
    { image: { Config: { ...input.image.Config, User: 'root' } } },
    { image: { Config: { ...input.image.Config, Labels: {} } } },
    { image: { Config: { ...input.image.Config, Env: [] } } },
  ]) assert.throws(() => verifyIdentity({ ...input, ...change }))
  assert.equal(verifyIdentity({ ...input, eventName: 'push', prHeadSha: '', refName: 'refs/heads/main' }), 'push: no PR')
  assert.throws(() => verifyIdentity({ ...input, eventName: 'push', prHeadSha: '', refName: 'refs/heads/feature' }))
  assert.throws(() => verifyIdentity({ ...input, eventName: 'push', refName: 'refs/heads/main' }))
})

test('exact protected standalone Web dispatch admits the same checkout, image and served identity', async () => {
  const { verifyIdentity } = await import('./verify-web-image.mjs')
  const sha = 'a'.repeat(40), otherSha = 'b'.repeat(40)
  const standalone = {
    repository: 'silent-suite/silentsuite',
    workflowRef: 'silent-suite/silentsuite/.github/workflows/deploy-web-standalone.yml@refs/heads/main',
    workflowSha: sha, expectedSha: sha, approvedSha: sha,
  }
  const input = {
    testedSha: sha, headSha: sha, prHeadSha: '',
    eventName: 'workflow_dispatch', refName: 'refs/heads/main',
    commitObject: `tree ${'c'.repeat(40)}\nparent ${otherSha}\n\nstandalone Web fixture`,
    standalone,
    image: { Config: { User: 'nextjs', Labels: { 'org.opencontainers.image.revision': sha },
      Env: [`SILENTSUITE_PUBLIC_BUILD_SHA=${sha}`] } },
    route: { status: 200, body: { publicSha: sha }, cacheControl: 'private, no-store, max-age=0' },
  }
  // The actual boundary already admits these checkout/image/route values on main push.
  assert.equal(verifyIdentity({ ...input, eventName: 'push' }), 'push: no PR')
  assert.throws(() => verifyIdentity({ ...input, standalone: undefined }), 'unqualified dispatch remains forbidden')

  assert.doesNotThrow(() => verifyIdentity(input), 'matching protected standalone Web dispatch must be admitted')

  for (const change of [
    { standalone: { ...standalone, repository: 'silent-suite/other' } },
    { standalone: { ...standalone, workflowRef: 'silent-suite/silentsuite/.github/workflows/deploy-web.yml@refs/heads/main' } },
    { standalone: { ...standalone, workflowRef: 'silent-suite/silentsuite/.github/workflows/deploy-web-standalone.yml@refs/heads/attacker' } },
    { standalone: { ...standalone, workflowSha: otherSha } },
    { standalone: { ...standalone, expectedSha: undefined } },
    { standalone: { ...standalone, expectedSha: otherSha } },
    { standalone: { ...standalone, approvedSha: undefined } },
    { standalone: { ...standalone, approvedSha: '' } },
    { standalone: { ...standalone, approvedSha: otherSha } },
    { refName: 'refs/heads/attacker' },
    { headSha: otherSha },
    { prHeadSha: otherSha },
    { image: { Config: { ...input.image.Config, Labels: { 'org.opencontainers.image.revision': otherSha } } } },
    { route: { ...input.route, body: { publicSha: otherSha } } },
  ]) assert.throws(() => verifyIdentity({ ...input, ...change }))
})

test('runtime records require the real server and reject forbidden modules or attempted egress', async () => {
  const { verifyRuntimeRecords } = await import('./verify-web-image.mjs')
  assert.equal(typeof verifyRuntimeRecords, 'function', 'runtime record verifier is required')
  const record = { pid: 1, modules: ['/app/apps/web/server.js', '/app/node_modules/next/dist/server/next-server.js'], blockedOutbound: [] }
  assert.equal(verifyRuntimeRecords([record], 1), 2)
  for (const records of [[], [null], [{ ...record, pid: 2 }],
    [{ ...record, modules: [] }], [{ ...record, modules: [null] }],
    [{ ...record, blockedOutbound: ['example.invalid'] }],
    [{ ...record, blockedOutbound: null }],
    [{ ...record, modules: [...record.modules, '/app/node_modules/braces/index.js'] }],
    [{ ...record, modules: [...record.modules, '/app/node_modules/next/dist/compiled/@vercel/nft/index.js'] }],
  ]) assert.throws(() => verifyRuntimeRecords(records, 1))
})

test('the image lane reuses the existing collector protocol and scan boundaries', async () => {
  const collector = await import('./verify-braces-tooling-exposure.mjs')
  assert.equal(typeof collector.runtimePreload, 'string', 'shared preload export is required')
  assert.equal(typeof collector.namesConsumer, 'function')
  assert.equal(collector.maxFiles, 100000)
  assert.equal(collector.maxScanBytes, 64 * 1024 * 1024)
  assert.match(collector.runtimePreload, /process\.on\('SIGTERM'/)
  assert.match(collector.runtimePreload, /BRACES_SMOKE_OUT/)
  assert.match(collector.runtimePreload, /runtime-modules-/)
  assert.deepEqual(collector.smokeRoutes, ['/', '/login', '/offline', '/calendar', '/settings', '/api/deployment-identity', '/braces-smoke-not-found'])
})

test('effective build arguments retain their Dockerfile stage and defaults, separate from image ENV', async () => {
  const { effectiveBuildArgs } = await import('./verify-web-image.mjs')
  assert.equal(typeof effectiveBuildArgs, 'function', 'effective build argument parser is required')
  const source = 'FROM node:22-alpine AS builder\nARG URL=https://example.invalid\nARG FLAG=false\nFROM node:22-alpine AS runner\nARG VCS_REF\n'
  assert.deepEqual(effectiveBuildArgs(source, 'URL=https://other.invalid/?a=b\nVCS_REF=abc'), [
    { stage: 'builder', name: 'URL', value: 'https://other.invalid/?a=b' },
    { stage: 'builder', name: 'FLAG', value: 'false' },
    { stage: 'runner', name: 'VCS_REF', value: 'abc' },
  ])
  assert.throws(() => effectiveBuildArgs(source, 'FLAG=true\nFLAG=false'))
  assert.throws(() => effectiveBuildArgs(source, 'UNKNOWN=value'))
})

test('characterization: CLI standalone proof maps exact environment fields and refuses missing or malformed bindings', async () => {
  const { standaloneIdentityFromEnvironment, verifyIdentity } = await import('./verify-web-image.mjs')
  const sha = 'a'.repeat(40)
  const env = {
    GITHUB_REPOSITORY: 'silent-suite/silentsuite',
    GITHUB_WORKFLOW_REF: 'silent-suite/silentsuite/.github/workflows/deploy-web-standalone.yml@refs/heads/main',
    GITHUB_WORKFLOW_SHA: sha, EXPECTED_SHA: sha, WEB_STANDALONE_DEPLOY_APPROVED_SHA: sha,
  }
  const proof = standaloneIdentityFromEnvironment(env)
  assert.deepEqual(proof, { repository: env.GITHUB_REPOSITORY, workflowRef: env.GITHUB_WORKFLOW_REF,
    workflowSha: sha, expectedSha: sha, approvedSha: sha })
  const input = {
    testedSha: sha, headSha: sha, prHeadSha: '', eventName: 'workflow_dispatch', refName: 'refs/heads/main',
    commitObject: '', standalone: proof,
    image: { Config: { User: 'nextjs', Labels: { 'org.opencontainers.image.revision': sha },
      Env: [`SILENTSUITE_PUBLIC_BUILD_SHA=${sha}`] } },
    route: { status: 200, body: { publicSha: sha }, cacheControl: 'no-store' },
  }
  assert.doesNotThrow(() => verifyIdentity(input))
  for (const name of Object.keys(env)) {
    for (const value of [undefined, '', 'unqualified', 42]) {
      assert.throws(() => verifyIdentity({ ...input, standalone: standaloneIdentityFromEnvironment({ ...env, [name]: value }) }))
    }
  }
  const newlineSha = sha + '\n'
  assert.throws(() => verifyIdentity({ ...input, testedSha: newlineSha, headSha: newlineSha,
    standalone: { ...proof, workflowSha: newlineSha, expectedSha: newlineSha, approvedSha: newlineSha } }))
})

test('characterization: actual hosted build arguments validate in memory and report serialization omits the protected key', async () => {
  const { effectiveBuildArgs, verifyStandaloneBuildArgs, serializeImageReport } = await import('./verify-web-image.mjs')
  const dockerfile = readFileSync(new URL('../Dockerfile.web', import.meta.url), 'utf8')
  const sha = 'a'.repeat(40), canary = 'pk_live_SYNTHETIC_PROTECTED_BUILD_KEY_CANARY'
  const actual = {
    NEXT_PUBLIC_BILLING_API_URL: 'https://api.silentsuite.io',
    NEXT_PUBLIC_ETEBASE_SERVER_URL: 'https://server.silentsuite.io',
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: canary, NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED: 'true',
    NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED: 'true', NEXT_PUBLIC_LOCAL_CACHE_ENABLED: 'false',
    NEXT_PUBLIC_SELF_HOSTED: 'false', NEXT_PUBLIC_OWNER_REGISTRATION: 'false', VCS_REF: sha,
  }
  const overrides = Object.entries(actual).map(([name, value]) => `${name}=${value}`).join('\n')
  assert.doesNotThrow(() => verifyStandaloneBuildArgs(dockerfile, overrides, { testedSha: sha, publishableKey: canary }))
  const report = { imageId: `sha256:${'b'.repeat(64)}`, testedSha: sha, relation: 'standalone identity verified',
    buildArgs: effectiveBuildArgs(dockerfile, overrides), inventorySha256: 'c'.repeat(64), cleanupVerified: true,
    runnerImageEnv: [`PROTECTED=${canary}`], unreviewedMetadata: canary }
  const serialized = serializeImageReport(report, { standalone: true })
  assert.ok(!serialized.includes(canary))
  assert.ok(!serialized.includes(overrides))
  const safe = JSON.parse(serialized)
  assert.equal(safe.verification, 'passed')
  assert.equal(safe.imageId, report.imageId)
  assert.equal(safe.testedSha, sha)
  assert.equal(safe.cleanupVerified, true)
  assert.equal(safe.runnerImageEnv, undefined)
  assert.equal(safe.unreviewedMetadata, undefined)
  assert.deepEqual(safe.buildArgs.find(arg => arg.name === 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY'),
    { stage: 'builder', name: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', binding: 'value omitted' })
  for (const name of ['NEXT_PUBLIC_LOCAL_CACHE_ENABLED', 'NEXT_PUBLIC_SELF_HOSTED', 'NEXT_PUBLIC_OWNER_REGISTRATION']) {
    assert.equal(safe.buildArgs.find(arg => arg.name === name).value, 'false')
  }
  // The existing CI report also omits the key argument, including a Dockerfile default.
  const ciReport = { ...report, runnerImageEnv: [], unreviewedMetadata: undefined }
  assert.ok(!serializeImageReport(ciReport).includes(canary))
  const defaultKey = effectiveBuildArgs(dockerfile, '').find(arg => arg.name === 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY').value
  assert.ok(!serializeImageReport({ ...ciReport, buildArgs: effectiveBuildArgs(dockerfile, '') }).includes(defaultKey))
})

test('characterization: mismatched production argument vectors and key types fail without reflecting protected values', async () => {
  const { verifyStandaloneBuildArgs } = await import('./verify-web-image.mjs')
  const dockerfile = readFileSync(new URL('../Dockerfile.web', import.meta.url), 'utf8')
  const sha = 'a'.repeat(40), canary = 'pk_live_SYNTHETIC_PROTECTED_BUILD_KEY_CANARY', otherKey = 'pk_live_OTHER_PROTECTED_CANARY'
  const actual = {
    NEXT_PUBLIC_BILLING_API_URL: 'https://api.silentsuite.io',
    NEXT_PUBLIC_ETEBASE_SERVER_URL: 'https://server.silentsuite.io',
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: canary, NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED: 'true',
    NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED: 'true', NEXT_PUBLIC_LOCAL_CACHE_ENABLED: 'false',
    NEXT_PUBLIC_SELF_HOSTED: 'false', NEXT_PUBLIC_OWNER_REGISTRATION: 'false', VCS_REF: sha,
  }
  const encode = values => Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n')
  const overrides = encode(actual), proof = { testedSha: sha, publishableKey: canary }
  const cases = []
  for (const name of Object.keys(actual)) {
    cases.push([dockerfile, encode({ ...actual, [name]: name === 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY' ? otherKey : 'mismatch' }), proof])
    const missing = { ...actual }; delete missing[name]
    cases.push([dockerfile, encode(missing), proof])
  }
  for (const publishableKey of [undefined, null, 42, '', new String(canary), canary + '\n', otherKey]) {
    cases.push([dockerfile, overrides, { ...proof, publishableKey }])
  }
  for (const name of ['NEXT_PUBLIC_LOCAL_CACHE_ENABLED', 'NEXT_PUBLIC_SELF_HOSTED', 'NEXT_PUBLIC_OWNER_REGISTRATION']) {
    cases.push([dockerfile.replace(`ARG ${name}=false`, `ARG ${name}=true`), overrides, proof])
  }
  cases.push([dockerfile, overrides + '\nNEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=' + otherKey, proof])
  cases.push([dockerfile, overrides + '\nUNDECLARED=' + canary, proof])
  cases.push([dockerfile, overrides + '\n' + canary, proof])
  cases.push([dockerfile, overrides, { ...proof, testedSha: sha + '\n' }])
  cases.push([dockerfile, null, proof])
  for (const [source, args, binding] of cases) {
    assert.throws(() => verifyStandaloneBuildArgs(source, args, binding), error => {
      assert.match(error.message, /build arguments are invalid \(values withheld\)/)
      assert.equal(error.cause, undefined)
      for (const rendered of [String(error), error.stack, JSON.stringify(error)]) {
        assert.ok(!rendered.includes(canary))
        assert.ok(!rendered.includes(otherKey))
        assert.ok(!rendered.includes(overrides))
      }
      return true
    })
  }
})

test('native proof admits only the authenticated musl mappings and an executed SVG/PNG result', async () => {
  const { parseNativeMappings, verifyNativeProbe } = await import('./verify-web-image.mjs')
  assert.equal(typeof verifyNativeProbe, 'function', 'native image admission is required')
  const sharp = '/app/node_modules/.pnpm/@img+sharp-linuxmusl-x64@0.35.5/node_modules/@img/sharp-linuxmusl-x64/lib/sharp-linuxmusl-x64-0.35.5.node'
  const vips = '/app/node_modules/.pnpm/@img+sharp-libvips-linuxmusl-x64@1.3.4/node_modules/@img/sharp-libvips-linuxmusl-x64/lib/libvips-cpp.so.8.18.7'
  assert.deepEqual(parseNativeMappings(`1-2 r-xp 0 0 1 ${sharp}\n2-3 r--p 0 0 1 ${vips}\n3-4 r--p 0 0 1 ${sharp}`), [sharp, vips])
  const probe = { versions: { next: '15.5.28', react: '19.2.4', 'react-dom': '19.2.4' },
    sentry: { declared: '10.75.2', runtimeVersion: null },
    sharpVersion: '0.35.5', vipsVersion: '8.18.7', rsvg: '2.63.2', svgPixel: [12, 34, 56, 255],
    png: { width: 4, height: 4, format: 'png' },
    mappings: [{ path: sharp, sha256: '14ce8ddd283c101f225089152da805632568bfa372d336ccbfdd811f4f1dca02' },
      { path: vips, sha256: '979b625437190a1970b835164e0e30d47dc60159ce6a394ce78cc40cb9d59ab8' }] }
  assert.equal(verifyNativeProbe(probe), true)
  assert.equal(verifyNativeProbe({ ...probe, rsvg: null }), true)
  assert.equal(verifyNativeProbe({ ...probe, sentry: { declared: '10.75.2', runtimeVersion: '10.75.2' } }), true)
  for (const change of [{ mappings: [] }, { sharpVersion: '0.35.3' }, { rsvg: '2.63.1' },
    { sentry: { declared: '^10.75.2', runtimeVersion: null } },
    { sentry: { declared: '10.75.2', runtimeVersion: '10.46.0' } },
    { vipsVersion: '8.18.6' },
    { rsvg: null, mappings: probe.mappings.map(mapping => ({ ...mapping, sha256: '0'.repeat(64) })) },
    { versions: { ...probe.versions, next: '15.5.24' } }, { svgPixel: [0, 0, 0, 0] },
    { png: { width: 8, height: 8, format: 'png' } },
    { mappings: probe.mappings.map(mapping => ({ ...mapping, path: mapping.path.replaceAll('linuxmusl', 'linux') })) },
    { mappings: probe.mappings.map(mapping => ({ ...mapping, sha256: '0'.repeat(64) })) },
  ]) assert.throws(() => verifyNativeProbe({ ...probe, ...change }))
})

test('image inventory rejects tooling, escaped links, unpinned signatures and public source maps', async () => {
  const { verifyImageEntries } = await import('./verify-web-image.mjs')
  assert.equal(typeof verifyImageEntries, 'function', 'image inventory admission is required')
  const server = { type: 'file', path: '/app/apps/web/server.js', size: 10, sha256: '0'.repeat(64), signatures: [] }
  assert.equal(verifyImageEntries([server]), true)
  assert.throws(() => verifyImageEntries([]))
  for (const entry of [
    { ...server, path: '/app/node_modules/braces/index.js' },
    { ...server, path: '/app/apps/web/.next/static/chunks/app.js.map' },
    { ...server, path: '/app/apps/web/public/sw.js.map' },
    { ...server, path: '/app/apps/web/.next/server/chunk.js', signatures: ['rangeLimit'] },
    { ...server, size: 64 * 1024 * 1024 + 1 },
    { type: 'link', path: '/app/link', target: '/etc/passwd' },
    { type: 'link', path: '/app/link', target: 'node_modules/braces/index.js' },
  ]) assert.throws(() => verifyImageEntries([server, entry]))
  const { toleratedSignatureFiles: [nft] } = await import('./verify-braces-tooling-exposure.mjs')
  const tolerated = { ...server, path: `/app/${nft.file.slice('apps/web/.next/standalone/'.length)}`,
    sha256: nft.sha256, signatures: ['rangeLimit', 'exceeds max characters ('] }
  assert.equal(verifyImageEntries([server, tolerated]), true)
  assert.throws(() => verifyImageEntries([server, { ...tolerated, sha256: '0'.repeat(64) }]))
})

test('the executable refuses outside hosted CI before attempting Docker', () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./verify-web-image.mjs', import.meta.url))],
    { encoding: 'utf8', timeout: 5000, env: { GITHUB_ACTIONS: 'false' } })
  assert.notEqual(child.status, 0, 'image execution must be CI-only')
  assert.match(child.stderr, /CI-only/)
})

test('runtime images reject all public maps, including PWA debug maps and spoofed producer names', async () => {
  const { verifyImageEntries } = await import('./verify-web-image.mjs')
  const server = { type: 'file', path: '/app/apps/web/server.js', size: 10, sha256: '0'.repeat(64), signatures: [] }
  const worker = { ...server, path: '/app/apps/web/public/sw.js.map', sources: ['../../scratch/generated/sw.js'] }
  const workbox = { ...server, path: '/app/apps/web/public/workbox-5194662c.js.map',
    sha256: 'f5ec5e18b3cf8c6fb1a06c97d24e6e933ea387b01a2a227165d0b467106dda10', sources: ['workbox-core/_version.js'] }
  const fallback = { ...server, path: '/app/apps/web/public/fallback-ce627215c0e4a9af.js.map', sources: [
    'webpack://_N_E/node_modules/next/dist/build/polyfills/process.js',
    'webpack://_N_E/node_modules/next/dist/compiled/process/browser.js',
    'webpack://_N_E/webpack/bootstrap', 'webpack://_N_E/webpack/runtime/global',
    'webpack://_N_E/node_modules/@ducanh2912/next-pwa/dist/fallback.js',
  ] }
  for (const entry of [
    worker, workbox, fallback,
    { ...worker, sources: ['apps/web/sw.js'], sourcesContent: ['private application source'] },
    { ...fallback, sourcesContent: fallback.sources.map(() => 'private application source') },
    { ...worker, sources: ['webpack://_N_E/apps/web/app/page.tsx'] },
    { ...fallback, sources: [...fallback.sources, 'webpack://_N_E/apps/web/app/page.tsx'] },
    { ...workbox, sha256: '0'.repeat(64) },
    { ...worker, path: '/app/apps/web/public/app.js.map' },
    ...['\u2028', '\u2029'].flatMap(separator => ['public', '.next/static'].map(root =>
      ({ ...server, path: `/app/apps/web/${root}/debug${separator}.js.map` }))),
  ]) assert.throws(() => verifyImageEntries([server, entry]))
})

test('public assets and their serving-root ancestors cannot be symlinks', async () => {
  const { verifyImageEntries } = await import('./verify-web-image.mjs')
  const server = { type: 'file', path: '/app/apps/web/server.js', size: 10, sha256: '0'.repeat(64), signatures: [] }
  const privateMap = { ...server, path: '/app/apps/web/.next/server/private.js.map' }
  for (const path of ['/app/apps/web/public/app.js.map', '/app/apps/web/public/app.js',
    '/app/apps/web/.next/static/app.js.map', '/app/apps/web/public', '/app/apps/web/.next']) {
    assert.throws(() => verifyImageEntries([server, privateMap,
      { type: 'link', path, target: '/app/apps/web/.next/server/private.js.map' }]), /public asset symlink/)
  }
  assert.equal(verifyImageEntries([server, { type: 'link', path: '/app/node_modules/example', target: '../packages/example' }]), true)
})

test('link containment follows intermediate symlinks before processing parent traversal', async () => {
  const { verifyImageEntries } = await import('./verify-web-image.mjs')
  const server = { type: 'file', path: '/app/apps/web/server.js', size: 10, sha256: '0'.repeat(64), signatures: [] }
  const fixture = mkdtempSync(join(tmpdir(), 'image-link-containment-'))
  try {
    for (const path of ['app/a', 'app/c', 'outside']) mkdirSync(join(fixture, path), { recursive: true })
    writeFileSync(join(fixture, 'outside/probe'), 'synthetic fixture')
    symlinkSync('../c', join(fixture, 'app/a/b'))
    symlinkSync('a/b/../../outside/probe', join(fixture, 'app/link'))
    assert.equal(realpathSync.native(join(fixture, 'app/link')), join(fixture, 'outside/probe'))
    assert.throws(() => verifyImageEntries([server,
      { type: 'link', path: '/app/a/b', target: '../c' },
      { type: 'link', path: '/app/link', target: 'a/b/../../outside/probe' }]), /link escapes application/)
  } finally { rmSync(fixture, { recursive: true, force: true }) }
  assert.throws(() => verifyImageEntries([server,
    { type: 'link', path: '/app/a', target: 'b' },
    { type: 'link', path: '/app/b', target: 'a' }]), /symlink resolution limit/)
  assert.equal(verifyImageEntries([server,
    { type: 'link', path: '/app/a/b', target: '/app/c/d' },
    { type: 'link', path: '/app/link', target: 'a/b/../package' }]), true)
})

test('CI loads its one built image and passes provenance through env without granting publication', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const build = workflow.slice(workflow.indexOf('\n  build-web:'))
  assert.match(build, /WEB_BUILD_ARGS:/, 'shared build arguments are required')
  assert.match(build, /build-args: \$\{\{ env\.WEB_BUILD_ARGS \}\}/)
  assert.match(build, /id: image/)
  assert.match(build, /load: true/)
  assert.match(build, /push: false/)
  for (const name of ['TESTED_SHA', 'PR_HEAD_SHA', 'EVENT_NAME', 'WEB_IMAGE_ID']) assert.ok(build.includes(`${name}:`))
  assert.match(build, /node --test scripts\/verify-web-image\.test\.mjs && node scripts\/verify-web-image\.mjs/)
  assert.doesNotMatch(build, /permissions:|secrets:|push: true|workflow_dispatch:/)
  const dockerfile = readFileSync(new URL('../Dockerfile.web', import.meta.url), 'utf8')
  assert.ok(dockerfile.includes('VERIFIED_WEB_BUILD_SENTRY_VERSION='), 'SDK version must be asserted in its real builder resolution context')
  const omitted = dockerfile.slice(dockerfile.indexOf('RUN rm ./apps/web/public/sw.js.map'), dockerfile.indexOf('# ---- Production stage ----'))
  for (const name of ['sw.js.map', 'workbox-5194662c.js.map', 'fallback-ce627215c0e4a9af.js.map']) {
    assert.ok(omitted.includes(`./apps/web/public/${name}`), 'PWA debug maps must be omitted before copying any runtime-image layer')
  }
})
