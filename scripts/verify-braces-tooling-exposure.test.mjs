import assert from 'node:assert/strict'
import test from 'node:test'
import {
  forbiddenRuntimeModules,
  toleratedSignatureFiles,
  unexplainedSignatureHits,
} from './verify-braces-tooling-exposure.mjs'

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
    { file: nft.file.replace('next@15.5.24_', 'next@15.5.25_'), signature: 'rangeLimit', sha256: nft.sha256 },
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
