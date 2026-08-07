import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const nextConfig = require('./next.config.js')

function sourceMatches(source, pathname) {
  const expression = source.replace('/:path*', '(?:/.*)?').replaceAll('/', '\\/')
  return new RegExp(`^${expression}$`).test(pathname)
}

async function appliedCsp(pathname) {
  const rules = await nextConfig.headers()
  return rules
    .filter((rule) => sourceMatches(rule.source, pathname))
    .flatMap((rule) => rule.headers)
    .filter((header) => header.key === 'Content-Security-Policy')
    .at(-1)?.value
}

test('public analytics CSP uses the final matching route header', async () => {
  assert.match(await appliedCsp('/settings/subscription'), /https:\/\/plausible\.silentsuite\.io/)
  assert.match(await appliedCsp('/signup'), /https:\/\/plausible\.silentsuite\.io/)
  for (const path of ['/settings', '/settings/account', '/calendar', '/contacts', '/tasks']) {
    assert.doesNotMatch(await appliedCsp(path), /https:\/\/plausible\.silentsuite\.io/)
  }
})
