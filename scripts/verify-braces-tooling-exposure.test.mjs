import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { patchDigest } from './braces-byte-preflight.mjs'
import {
  forbiddenRuntimeModules,
  lockedBracesFailure,
  productionInputs,
  runtimePreload,
  toleratedSignatureFiles,
  unexplainedSignatureHits,
} from './verify-braces-tooling-exposure.mjs'

test('accepts only the single braces snapshot bound to the reviewed patch', () => {
  assert.equal(lockedBracesFailure([`braces@3.0.3(patch_hash=${patchDigest})`]), undefined)
  for (const locked of [
    ['braces@3.0.3'],
    [`braces@3.0.3(patch_hash=${'0'.repeat(64)})`],
    [`braces@3.0.3(patch_hash=${patchDigest})`, 'braces@3.0.3'],
    [`braces@3.0.3(patch_hash=${patchDigest})`, 'braces@3.0.2'],
    [],
  ]) {
    assert.match(lockedBracesFailure(locked), /locked braces versions/, locked.join(', '))
  }
})

test('treats the committed patch as a production input', () => {
  assert.ok(productionInputs.includes('patches'))
})

const [nft] = toleratedSignatureFiles
const compiled = nft.file.replace(/compiled\/@vercel\/nft\/index\.js$/, 'compiled/')

test('tolerates braces signatures only in the pinned vendored nft file and content', () => {
  assert.equal(nft.sha256, '19e4e6ea76d56deed0da625b0d9cbe5f5a761cf87a1c502bbb09c9406a70527e')
  assert.deepEqual(unexplainedSignatureHits([
    { file: nft.file, signature: 'exceeds max characters (', sha256: nft.sha256 },
    { file: nft.file, signature: 'rangeLimit', sha256: nft.sha256 },
  ]), [])
})

test('fails a changed nft bundle, another compiled path, or an application chunk', () => {
  for (const hit of [
    { file: nft.file, signature: 'rangeLimit', sha256: '0'.repeat(64) },
    { file: nft.file, signature: 'rangeLimit' },
    { file: `${compiled}micromatch/index.js`, signature: 'rangeLimit', sha256: nft.sha256 },
    { file: `${compiled}@vercel/nft/other.js`, signature: 'rangeLimit', sha256: nft.sha256 },
    { file: nft.file.replace('next@15.5.28_', 'next@15.5.29_'), signature: 'rangeLimit', sha256: nft.sha256 },
    { file: 'apps/web/.next/standalone/apps/web/.next/server/chunks/123.js', signature: 'exceeds max characters (', sha256: nft.sha256 },
    { file: 'apps/web/.next/static/chunks/app/page.js', signature: 'rangeLimit', sha256: nft.sha256 },
  ]) {
    assert.deepEqual(unexplainedSignatureHits([hit]), [hit], hit.file)
  }
})

test('flags build-only Next modules and tooling consumers in a runtime module record', () => {
  const next = '/srv/node_modules/.pnpm/next@15.5.24_x/node_modules/next/dist'
  const allowed = [`${next}/server/lib/start-server.js`, `${next}/server/lib/router-server.js`,
    `${next}/compiled/picomatch/index.js`, `${next}/server/dev/hot-reloader-types.js`]
  const forbidden = [
    `${next}/compiled/@vercel/nft/index.js`,
    `${next}/build/webpack/plugins/next-trace-entrypoints-plugin.js`,
    `${next}/build/webpack-config.js`,
    `${next}/build/create-compiler-aliases.js`,
    `${next}/build/handle-externals.js`,
    `${next}/build/webpack/config/blocks/images/index.js`,
    `${next}/server/lib/router-utils/setup-dev-bundler.js`,
    `${next}/server/dev/hot-reloader-webpack.js`,
    `${next}/server/dev/hot-reloader-turbopack.js`,
    '/srv/node_modules/.pnpm/braces@3.0.3/node_modules/braces/index.js',
    '/srv/node_modules/.pnpm/micromatch@4.0.8/node_modules/micromatch/index.js',
  ]
  assert.deepEqual(forbiddenRuntimeModules([...allowed, ...forbidden]), forbidden)
})

test('preload records non-loopback DNS without forwarding it and permits local lookup', (t) => {
  for (const [host, promise] of ['example.invalid', '127.not-an-address.invalid', 'localhost', '127.0.0.1']
    .flatMap(host => [[host, false], [host, true]])) {
    const dir = mkdtempSync(join(tmpdir(), 'braces-dns-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    // A harmless transport stub prevents even the predecessor from contacting real DNS.
    writeFileSync(join(dir, 'transport.cjs'), `require('node:dns').lookup = (host, callback) => {
      require('node:fs').writeFileSync(require('node:path').join(process.env.BRACES_SMOKE_OUT, 'forwarded'), 'yes')
      callback(null, '127.0.0.1', 4)
    }
    require('node:dns').promises.lookup = async () => {
      require('node:fs').writeFileSync(require('node:path').join(process.env.BRACES_SMOKE_OUT, 'forwarded'), 'yes')
      return { address: '127.0.0.1', family: 4 }
    }`)
    writeFileSync(join(dir, 'preload.cjs'), runtimePreload)
    const child = spawnSync(process.execPath, ['--require', join(dir, 'transport.cjs'), '--require', join(dir, 'preload.cjs'),
      '-e', `setInterval(() => {}, 1000); const end = () => process.kill(process.pid, 'SIGTERM');
        ${promise ? `require('node:dns').promises.lookup(${JSON.stringify(host)}).then(end, end)`
          : `require('node:dns').lookup(${JSON.stringify(host)}, end)`}`],
    { encoding: 'utf8', timeout: 5000, env: { BRACES_SMOKE_OUT: dir } })
    assert.equal(child.status, 0, child.stderr)
    const record = JSON.parse(readFileSync(join(dir, `runtime-modules-${child.pid}.json`), 'utf8'))
    const local = host === 'localhost' || host === '127.0.0.1'
    assert.deepEqual(record.blockedOutbound, local ? [] : [host], host)
    assert.equal(existsSync(join(dir, 'forwarded')), local, host)
    assert.equal(record.pid, child.pid)
    assert.ok(record.modules.includes('node:dns'))
  }
})

test('preload blocks direct DNS resolution and custom resolvers before their transport', (t) => {
  for (const expression of ['dns.resolve4("example.invalid", end)',
    'dns.promises.resolve4("example.invalid").then(end, end)',
    'new dns.Resolver().resolve4("example.invalid", end)',
    'new dns.promises.Resolver().resolve4("example.invalid").then(end, end)']) {
    const dir = mkdtempSync(join(tmpdir(), 'braces-resolver-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(join(dir, 'transport.cjs'), `const dns = require('node:dns');
      const mark = () => require('node:fs').writeFileSync(require('node:path').join(process.env.BRACES_SMOKE_OUT, 'forwarded'), 'yes');
      dns.resolve4 = dns.Resolver.prototype.resolve4 = (host, callback) => { mark(); callback(null, ['127.0.0.1']) };
      dns.promises.resolve4 = dns.promises.Resolver.prototype.resolve4 = async () => { mark(); return ['127.0.0.1'] }`)
    writeFileSync(join(dir, 'preload.cjs'), runtimePreload)
    const child = spawnSync(process.execPath, ['--require', join(dir, 'transport.cjs'), '--require', join(dir, 'preload.cjs'),
      '-e', `setInterval(() => {}, 1000); const dns = require('node:dns'); const end = () => process.kill(process.pid, 'SIGTERM'); ${expression}`],
    { encoding: 'utf8', timeout: 5000, env: { BRACES_SMOKE_OUT: dir } })
    assert.equal(child.status, 0, child.stderr)
    const record = JSON.parse(readFileSync(join(dir, `runtime-modules-${child.pid}.json`), 'utf8'))
    assert.deepEqual(record.blockedOutbound, ['example.invalid'])
    assert.equal(existsSync(join(dir, 'forwarded')), false)
  }
})
