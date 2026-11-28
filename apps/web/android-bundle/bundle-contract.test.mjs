import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { contentSecurityPolicy, inlineScriptHashes, isBundledPath, urlPathFor } from './bundle-contract.mjs'

test('only the login and calendar pages are bundled', () => {
  for (const kept of ['index.html', 'index.txt', '404.html', '404/index.html', 'login/index.html', 'login/index.txt', 'calendar/index.html', 'favicon.ico', 'logo-shield.svg', 'manifest.json']) {
    assert.equal(isBundledPath(kept), true, kept)
  }
  for (const left of [
    'signup/index.html', 'signup/plan/index.html', 'verify-email/index.html', 'confirm-login-email/index.html',
    'admin/index.html', 'settings/index.html', 'settings/subscription/index.html', 'tasks/index.html',
    'contacts/index.html', 'notes/index.html', 'offline/index.html', 'offline.html', 'oauth/callback/index.html',
    'channel-icons/x.png',
  ]) {
    assert.equal(isBundledPath(left), false, left)
  }
})

test('route code of left-out pages stays out, shared code stays in', () => {
  const chunk = (route) => `_next/static/chunks/app/${route}`
  for (const kept of ['layout-1.js', 'error-1.js', '(app)/layout-1.js', '(app)/calendar/page-1.js', '(auth)/login/page-1.js', '_not-found/page-1.js']) {
    assert.equal(isBundledPath(chunk(kept)), true, kept)
  }
  for (const left of ['(app)/settings/subscription/page-1.js', '(app)/tasks/page-1.js', '(auth)/signup/page-1.js', '(app)/admin/page-1.js', 'offline/page-1.js']) {
    assert.equal(isBundledPath(chunk(left)), false, left)
  }
  assert.equal(isBundledPath('_next/static/chunks/123-abc.js'), true)
  assert.equal(isBundledPath('_next/static/css/a.css'), true)
  assert.equal(isBundledPath('_next/static/chunks/123-abc.js.map'), false)
})

test('no service worker file is bundled', () => {
  for (const worker of ['sw.js', 'sw-cache-cleanup.js', 'workbox-1a2b.js', 'fallback-xyz.js', 'swe-worker-1.js', 'notification-worker.js']) {
    assert.equal(isBundledPath(worker), false, worker)
  }
})

test('files answer the URL a static host would give them', () => {
  assert.equal(urlPathFor('index.html'), '/')
  assert.equal(urlPathFor('calendar/index.html'), '/calendar/')
  assert.equal(urlPathFor('calendar/index.txt'), '/calendar/index.txt')
  assert.equal(urlPathFor('404.html'), '/404.html')
  assert.equal(urlPathFor('_next/static/css/a.css'), '/_next/static/css/a.css')
})

test('inline scripts are hashed; external and empty ones are not', () => {
  const html = '<script src="/a.js"></script><script>one()</script><script id="x">two()</script><script>one()</script><script async src="/b.js"></script><script></script>'
  const hash = (body) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`
  assert.deepEqual(inlineScriptHashes(html), [hash('one()'), hash('two()')])
})

test('the page policy runs bundled scripts only and reaches the named servers only', () => {
  const policy = contentSecurityPolicy({ scriptHashes: ["'sha256-abc='"], connectSources: ['https://server.example', 'wss://server.example'] })
  const directives = Object.fromEntries(policy.split('; ').map((directive) => [directive.split(' ')[0], directive.split(' ').slice(1)]))
  assert.deepEqual(directives['default-src'], ["'none'"])
  assert.deepEqual(directives['script-src'], ["'self'", "'wasm-unsafe-eval'", "'sha256-abc='"])
  assert.deepEqual(directives['connect-src'], ["'self'", 'data:', 'https://server.example', 'wss://server.example'])
  assert.deepEqual(directives['frame-src'], ["'none'"])
  assert.deepEqual(directives['frame-ancestors'], ["'none'"])
  assert.deepEqual(directives['object-src'], ["'none'"])
  assert.deepEqual(directives['base-uri'], ["'none'"])
  assert.equal(policy.includes("'unsafe-eval'"), false)
})
