#!/usr/bin/env node
// Bounded checks of the exact CI-built web image; never publishes or accesses live fixtures.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageRootOf } from './braces-byte-preflight.mjs'
import { forbiddenRuntimeModules, maxFiles, maxScanBytes, namesConsumer, runtimePreload, smokeRoutes, unexplainedSignatureHits } from './verify-braces-tooling-exposure.mjs'

export function imagePathToStandalone(path) {
  assert.equal(typeof path, 'string')
  assert.ok(path.startsWith('/app/'))
  assert.ok(path.slice(5).split('/').every(part => part && part !== '.' && part !== '..'))
  return `apps/web/.next/standalone/${path.slice(5)}`
}

export function verifyIdentity({ testedSha, prHeadSha, eventName, refName, headSha, commitObject, image, route }) {
  assert.match(testedSha, /^[a-f0-9]{40}$/)
  assert.equal(headSha, testedSha, 'checkout must be the tested commit')
  let relation
  if (eventName === 'pull_request') {
    assert.match(prHeadSha, /^[a-f0-9]{40}$/)
    const parents = commitObject.split('\n\n')[0].split('\n').filter(line => line.startsWith('parent '))
    assert.equal(parents.length, 2, 'expected a two-parent PR merge commit')
    for (const parent of parents) assert.match(parent, /^parent [a-f0-9]{40}$/)
    assert.equal(parents[1], `parent ${prHeadSha}`, 'PR head must be the direct second parent')
    relation = 'pull_request: direct second parent verified'
  } else {
    assert.equal(eventName, 'push', 'unsupported workflow event')
    assert.equal(refName, 'refs/heads/main')
    assert.equal(prHeadSha, '')
    relation = 'push: no PR'
  }
  assert.equal(image.Config.User, 'nextjs')
  assert.equal(image.Config.Labels['org.opencontainers.image.revision'], testedSha)
  assert.deepEqual(image.Config.Env.filter(value => value.startsWith('SILENTSUITE_PUBLIC_BUILD_SHA=')),
    [`SILENTSUITE_PUBLIC_BUILD_SHA=${testedSha}`])
  assert.equal(route.status, 200)
  assert.equal(route.body.publicSha, testedSha)
  assert.match(route.cacheControl, /(?:^|,)\s*no-store(?:\s|,|$)/i)
  return relation
}

export function verifyRuntimeRecords(records, serverPid) {
  assert.ok(Number.isSafeInteger(serverPid) && serverPid > 0)
  assert.ok(Array.isArray(records) && records.length > 0, 'missing runtime records')
  for (const record of records) {
    assert.ok(Number.isSafeInteger(record?.pid) && record.pid > 0)
    assert.ok(Array.isArray(record.modules) && record.modules.every(path => typeof path === 'string' && path.length > 0))
    assert.ok(Array.isArray(record.blockedOutbound))
    assert.deepEqual(record.blockedOutbound, [], 'outbound attempts are failures even when blocked')
    assert.deepEqual(forbiddenRuntimeModules(record.modules), [])
  }
  const server = records.find(record => record.pid === serverPid)
  assert.ok(server?.modules.includes('/app/apps/web/server.js'), 'missing main server module record')
  return new Set(records.flatMap(record => record.modules)).size
}

export function effectiveBuildArgs(dockerfile, overrides) {
  const values = new Map()
  for (const line of overrides.split('\n').filter(Boolean)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line)
    assert.ok(match, 'malformed build argument')
    assert.ok(!values.has(match[1]), 'duplicate build argument')
    values.set(match[1], match[2])
  }
  const result = []
  let stage = 'global'
  for (const line of dockerfile.split('\n')) {
    const from = /^FROM\s+\S+\s+AS\s+(\S+)$/i.exec(line)
    if (from) stage = from[1]
    const arg = /^ARG\s+([A-Z_][A-Z0-9_]*)(?:=(.*))?$/.exec(line)
    if (arg) result.push({ stage, name: arg[1], value: values.has(arg[1]) ? values.get(arg[1]) : arg[2] ?? null })
  }
  for (const name of values.keys()) assert.ok(result.some(arg => arg.name === name), 'unknown build argument')
  return result
}

// Derived from the SRI-verified published musl packages, not from the candidate image.
export const nativePins = Object.freeze([
  { path: '/app/node_modules/.pnpm/@img+sharp-linuxmusl-x64@0.35.5/node_modules/@img/sharp-linuxmusl-x64/lib/sharp-linuxmusl-x64-0.35.5.node',
    sha256: '14ce8ddd283c101f225089152da805632568bfa372d336ccbfdd811f4f1dca02' },
  { path: '/app/node_modules/.pnpm/@img+sharp-libvips-linuxmusl-x64@1.3.4/node_modules/@img/sharp-libvips-linuxmusl-x64/lib/libvips-cpp.so.8.18.7',
    sha256: '979b625437190a1970b835164e0e30d47dc60159ce6a394ce78cc40cb9d59ab8' },
])

export function parseNativeMappings(text) {
  return [...new Set(text.split('\n').filter(line => /sharp-.*\.node|libvips-cpp\.so/.test(line))
    .map(line => { const match = /\s(\/.*)$/.exec(line); assert.ok(match, 'malformed native mapping'); return match[1] }))]
}

export function verifyNativeProbe(probe) {
  assert.deepEqual(probe.versions, { next: '15.5.28', react: '19.2.4', 'react-dom': '19.2.4' })
  assert.equal(probe.sentry.declared, '10.75.2')
  assert.ok(probe.sentry.runtimeVersion === null || probe.sentry.runtimeVersion === '10.75.2')
  assert.equal(probe.sharpVersion, '0.35.5')
  assert.match(probe.rsvg, /^\d+\.\d+\.\d+$/)
  const [major, minor, patch] = probe.rsvg.split('.').map(Number)
  assert.ok(major > 2 || (major === 2 && (minor > 63 || (minor === 63 && patch >= 2))), 'librsvg floor')
  assert.deepEqual(probe.svgPixel, [12, 34, 56, 255])
  assert.deepEqual(probe.png, { width: 4, height: 4, format: 'png' })
  assert.equal(probe.mappings.length, nativePins.length)
  for (const pin of nativePins) assert.deepEqual(probe.mappings.find(mapping => mapping.path === pin.path), pin)
  return true
}

// These three PWA outputs also exist at the immutable predecessor. They contain
// generated worker/vendor sources, not application client chunks. Inventory them
// explicitly rather than claiming there are no public maps of any kind.
function knownPwaMap(entry) {
  if (!Array.isArray(entry.sources) || !entry.sources.every(source => typeof source === 'string')) return false
  if (entry.path === '/app/apps/web/public/sw.js.map') {
    return entry.sources.length === 1 && entry.sources[0].endsWith('/sw.js')
  }
  if (entry.path === '/app/apps/web/public/workbox-5194662c.js.map') {
    return entry.sha256 === 'f5ec5e18b3cf8c6fb1a06c97d24e6e933ea387b01a2a227165d0b467106dda10'
  }
  if (entry.path === '/app/apps/web/public/fallback-ce627215c0e4a9af.js.map') {
    const suffixes = ['/node_modules/next/dist/build/polyfills/process.js',
      '/node_modules/next/dist/compiled/process/browser.js', '/webpack/bootstrap', '/webpack/runtime/global',
      '/node_modules/@ducanh2912/next-pwa/dist/fallback.js']
    return entry.sources.length === suffixes.length && suffixes.every((suffix, i) => entry.sources[i].endsWith(suffix))
  }
  return false
}

export function verifyImageEntries(entries) {
  assert.ok(Array.isArray(entries) && entries.length > 0 && entries.length <= maxFiles)
  assert.ok(entries.some(entry => entry.type === 'file' && entry.path === '/app/apps/web/server.js'), 'missing shipped server')
  for (const entry of entries) {
    const mapped = imagePathToStandalone(entry.path)
    assert.ok(!/[\t\r\n]/.test(entry.path))
    assert.ok(!namesConsumer(entry.path), 'shipped tooling consumer')
    if (entry.type === 'link') {
      const target = posix.resolve(posix.dirname(entry.path), entry.target)
      assert.ok(target.startsWith('/app/'), 'link escapes application')
      assert.ok(!namesConsumer(entry.target) && !namesConsumer(target), 'link names tooling consumer')
    } else {
      assert.equal(entry.type, 'file')
      assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= maxScanBytes)
      assert.match(entry.sha256, /^[a-f0-9]{64}$/)
      assert.ok(Array.isArray(entry.signatures))
      assert.deepEqual(unexplainedSignatureHits(entry.signatures.map(signature => ({ file: mapped, sha256: entry.sha256, signature }))), [])
      assert.ok(!/^\/app\/apps\/web\/(?:\.next\/static|public)\/.*\.map$/.test(entry.path)
        || knownPwaMap(entry), 'public client source map')
    }
  }
  return true
}

export const nativeProbeSource = `
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { createHash } = require('node:crypto')
const { existsSync, readFileSync } = require('node:fs')
const { dirname, join } = require('node:path')
${packageRootOf.toString()}
${parseNativeMappings.toString()}
;(async () => {
  const app = createRequire('/app/apps/web/server.js')
  const versions = Object.fromEntries(['next', 'react', 'react-dom'].map(name =>
    [name, JSON.parse(readFileSync(join(packageRootOf(app.resolve(name), name), 'package.json'), 'utf8')).version]))
  const declared = JSON.parse(readFileSync('/app/apps/web/package.json', 'utf8')).dependencies['@sentry/nextjs']
  let runtimeVersion = null
  try { runtimeVersion = JSON.parse(readFileSync(join(packageRootOf(app.resolve('@sentry/nextjs'), '@sentry/nextjs'), 'package.json'), 'utf8')).version }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
  const sharp = createRequire(app.resolve('next'))('sharp')
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 4,
    background: { r: 12, g: 34, b: 56, alpha: 1 } } }).png().toBuffer()
  const pngBytes = await sharp(bytes).resize(4, 4).png().toBuffer()
  const { width, height, format } = await sharp(pngBytes).metadata()
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#0c2238"/></svg>')
  const rendered = await sharp(svg).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.equal(rendered.info.width, 2)
  assert.equal(rendered.info.height, 2)
  assert.equal(rendered.info.channels, 4)
  const mappings = parseNativeMappings(readFileSync('/proc/self/maps', 'utf8')).map(path =>
    ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }))
  console.log(JSON.stringify({ versions, sentry: { declared, runtimeVersion }, sharpVersion: sharp.versions.sharp, rsvg: sharp.versions.rsvg,
    png: { width, height, format }, svgPixel: [...rendered.data.subarray(0, 4)], mappings }))
})().catch(error => { console.error(error.message); process.exitCode = 1 })
`

function imageEntries(appDir) {
  assert.ok(lstatSync(appDir).isDirectory() && !lstatSync(appDir).isSymbolicLink())
  const pending = [appDir], entries = []
  let count = 0
  while (pending.length) {
    const directory = pending.pop()
    for (const name of readdirSync(directory).sort()) {
      assert.ok(++count <= maxFiles, 'image entry limit')
      const file = join(directory, name), stat = lstatSync(file)
      const path = `/app/${relative(appDir, file)}`
      if (stat.isDirectory()) pending.push(file)
      else if (stat.isSymbolicLink()) entries.push({ type: 'link', path, target: readlinkSync(file) })
      else {
        assert.ok(stat.isFile() && stat.size <= maxScanBytes, 'unsupported or oversized image file')
        const bytes = readFileSync(file), text = bytes.toString('latin1')
        entries.push({ type: 'file', path, size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          signatures: ['exceeds max characters (', 'rangeLimit'].filter(signature => text.includes(signature)),
          ...(/^\/app\/apps\/web\/(?:\.next\/static|public)\/.*\.map$/.test(path)
            ? { sources: JSON.parse(bytes.toString('utf8')).sources } : {}) })
      }
    }
  }
  verifyImageEntries(entries)
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'CI-only image execution')
  const imageId = process.env.WEB_IMAGE_ID, testedSha = process.env.TESTED_SHA
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/)
  assert.match(testedSha, /^[a-f0-9]{40}$/)
  const root = resolve(import.meta.dirname, '..')
  const run = (command, args, timeout = 30000) => execFileSync(command, args,
    { cwd: root, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 })
  const docker = (args, timeout) => run('docker', args, timeout).trim()
  const headSha = run('git', ['rev-parse', 'HEAD']).trim()
  assert.equal(headSha, testedSha)
  const commitObject = run('git', ['cat-file', '-p', 'HEAD'])
  const image = JSON.parse(docker(['image', 'inspect', imageId]))[0]
  assert.equal(image.Id, imageId)
  assert.equal(image.Architecture, 'amd64')
  assert.equal(image.Config.User, 'nextjs')
  assert.equal(image.Config.Labels['org.opencontainers.image.revision'], testedSha)
  assert.deepEqual(image.Config.Cmd, ['node', 'apps/web/server.js'])
  assert.ok(!image.Config.Volumes || Object.keys(image.Config.Volumes).length === 0, 'image volumes obscure exported bytes')
  const buildArgs = effectiveBuildArgs(readFileSync(join(root, 'Dockerfile.web'), 'utf8'), process.env.WEB_BUILD_ARGS ?? '')
  assert.equal(buildArgs.find(arg => arg.name === 'VCS_REF')?.value, testedSha)
  const directory = mkdtempSync(join(process.env.RUNNER_TEMP, 'web-image-'))
  const containers = []
  const create = (options, command = []) => {
    const id = docker(['create', '--network', 'none', ...options, imageId, ...command])
    assert.match(id, /^[a-f0-9]{64}$/)
    containers.push(id)
    return id
  }
  let report
  try {
    const nativeContainer = create(['--entrypoint', 'node'], ['-e', nativeProbeSource])
    const archive = join(directory, 'rootfs.tar'), extracted = join(directory, 'rootfs')
    docker(['export', '--output', archive, nativeContainer], 180000)
    const members = run('tar', ['-tf', archive], 60000).split('\n').filter(Boolean)
    assert.ok(members.every(name => !name.startsWith('/') && !name.split('/').includes('..')), 'unsafe archive path')
    mkdirSync(extracted)
    run('tar', ['-xf', archive, '--directory', extracted, '--no-same-owner', '--no-same-permissions', 'app'], 180000)
    const entries = imageEntries(join(extracted, 'app'))
    const appManifest = entries.find(entry => entry.path === '/app/apps/web/package.json' && entry.type === 'file')
    assert.equal(appManifest?.sha256, createHash('sha256').update(readFileSync(join(root, 'apps/web/package.json'))).digest('hex'),
      'shipped application manifest must match the tested source')
    const inventory = entries.map(entry => entry.type === 'file'
      ? `file\t${entry.path}\t${entry.size}\t${entry.sha256}` : `link\t${entry.path}\t${entry.target}`).join('\n') + '\n'
    writeFileSync(join(directory, 'inventory.tsv'), inventory)
    const native = JSON.parse(docker(['start', '--attach', nativeContainer], 60000))
    verifyNativeProbe(native)
    if (native.sentry.runtimeVersion === null) {
      assert.ok(!entries.some(entry => /\/node_modules\/@sentry\/nextjs(?:\/|$)|\/\.pnpm\/@sentry\+nextjs@/.test(entry.path)),
        'a shipped SDK package must resolve rather than being mistaken for build-only output')
    }
    const out = join(directory, 'out'), preload = join(directory, 'preload.cjs')
    mkdirSync(out)
    chmodSync(out, 0o1777)
    writeFileSync(preload, runtimePreload, { mode: 0o644 })
    const server = create(['--volume', `${preload}:/probe/preload.cjs:ro`, '--volume', `${out}:/probe/out:rw`,
      '--env', 'NODE_OPTIONS=--require=/probe/preload.cjs', '--env', 'BRACES_SMOKE_OUT=/probe/out', '--env', 'HOSTNAME=127.0.0.1'])
    docker(['start', server])
    const routeProbe = `const assert = require('node:assert/strict'); const fs = require('node:fs');
      (async () => {
        const deadline = Date.now() + 60000; let ready = false;
        while (Date.now() < deadline) { try { const r = await fetch('http://127.0.0.1:3000/', { signal: AbortSignal.timeout(2000) });
          await r.arrayBuffer(); ready = true; break } catch { await new Promise(resolve => setTimeout(resolve, 250)) } }
        assert.ok(ready, 'server readiness deadline');
        assert.ok(fs.readlinkSync('/proc/1/exe').endsWith('/node'), 'PID1 must be node');
        assert.equal(fs.readlinkSync('/proc/1/cwd'), '/app');
        const serverPid = Number(fs.readFileSync('/proc/1/stat', 'utf8').split(' ')[0]); assert.equal(serverPid, 1);
        const routes = [];
        for (const route of ${JSON.stringify(smokeRoutes)}) {
          const r = await fetch('http://127.0.0.1:3000' + route, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
          const body = route === '/api/deployment-identity' ? await r.json() : (await r.arrayBuffer(), null);
          assert.equal(r.status, route === '/braces-smoke-not-found' ? 404 : 200, route);
          routes.push({ route, status: r.status, body, cacheControl: r.headers.get('cache-control') });
        }
        console.log(JSON.stringify({ serverPid, routes })); process.exit(0);
      })().catch(error => { console.error(error.message); process.exit(1) })`
    const smoke = JSON.parse(docker(['exec', '--env', 'NODE_OPTIONS=', server, 'node', '-e', routeProbe], 150000))
    const relation = verifyIdentity({ testedSha, prHeadSha: process.env.PR_HEAD_SHA ?? '',
      eventName: process.env.EVENT_NAME, refName: process.env.GITHUB_REF, headSha, commitObject, image,
      route: smoke.routes.find(route => route.route === '/api/deployment-identity') })
    docker(['stop', '--time', '15', server], 20000)
    const state = JSON.parse(docker(['inspect', server]))[0].State
    assert.equal(state.Running, false)
    assert.equal(state.ExitCode, 0, 'server must flush records and exit without SIGKILL')
    assert.equal(state.OOMKilled, false)
    const records = readdirSync(out).filter(name => /^runtime-modules-\d+\.json$/.test(name)).map(name => {
      const file = join(out, name)
      assert.ok(lstatSync(file).isFile() && lstatSync(file).size <= 1024 * 1024)
      const record = JSON.parse(readFileSync(file, 'utf8'))
      assert.equal(name, `runtime-modules-${record.pid}.json`)
      return record
    })
    report = { imageId, testedSha, prHeadSha: process.env.PR_HEAD_SHA ?? '', relation,
      buildArgs, runnerImageEnv: image.Config.Env, smokeHostnameOverride: '127.0.0.1',
      inventoryEntries: entries.length, inventorySha256: createHash('sha256').update(inventory).digest('hex'),
      appManifestSha256: appManifest.sha256,
      publicPwaMaps: entries.filter(entry => knownPwaMap(entry)).map(({ path, sha256, sources }) => ({ path, sha256, sources })),
      native, routes: smoke.routes, runtimeProcesses: records.length,
      modulesLoaded: verifyRuntimeRecords(records, smoke.serverPid), blockedOutbound: records.flatMap(record => record.blockedOutbound),
      rawBuildWarningSource: 'This run: Build Web App / Build web Docker image. Raw warnings are not copied or interpreted by this verifier.' }
  } finally {
    for (const id of containers.reverse()) {
      docker(['rm', '--force', id])
      assert.equal(docker(['ps', '--all', '--quiet', '--filter', `id=${id}`]), '', 'container cleanup must be verified')
    }
    rmSync(join(directory, 'rootfs'), { recursive: true, force: true })
    rmSync(join(directory, 'rootfs.tar'), { force: true })
  }
  report.cleanupVerified = true
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(report, null, 2))
  const summary = `## Web image verification\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  console.log(summary)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
