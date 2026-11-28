// What the Android bundle may contain and how its pages are locked down.
// Pure functions, so the rules are unit-tested without a build.
import { createHash } from 'node:crypto'

/** Pages the bundle carries. Everything else the web app has stays out. */
export const ALLOWED_PAGE_PREFIXES = ['/login/', '/calendar/']

const ALLOWED_ROUTE_SEGMENTS = new Set(['login', 'calendar', '_not-found'])

export const CONTENT_TYPES = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
}

// Service-worker files: the bundle registers no worker, and the app refuses them.
const SERVICE_WORKER_FILE = /^(sw|sw-[^/]*|workbox-[^/]*|fallback-[^/]*|swe-worker-[^/]*|notification-worker)\.js$/

/** Whether a file of the static export (path relative to `out/`) goes into the bundle. */
export function isBundledPath(relative) {
  if (relative.endsWith('.map')) return false
  const segments = relative.split('/')

  if (segments[0] === '_next') {
    // Route code lives under chunks/app/<route>/; keep the allowed routes and the shared layouts.
    if (segments[1] === 'static' && segments[2] === 'chunks' && segments[3] === 'app') {
      const route = segments.slice(4, -1).filter((segment) => !/^\(.*\)$/.test(segment))
      return route.length === 0 || ALLOWED_ROUTE_SEGMENTS.has(route[0])
    }
    return true
  }

  if (segments.length === 1) {
    if (SERVICE_WORKER_FILE.test(relative)) return false
    return relative !== 'offline.html'
  }
  // Pages: the two allowed ones and the not-found page.
  if (segments[0] === '404') return true
  return ALLOWED_PAGE_PREFIXES.includes(`/${segments[0]}/`)
}

/** The URL path a file of the export answers. */
export function urlPathFor(relative) {
  if (relative === 'index.html') return '/'
  if (relative.endsWith('/index.html')) return `/${relative.slice(0, -'index.html'.length)}`
  return `/${relative}`
}

/** CSP hash sources for every inline script of a page, in document order, without repeats. */
export function inlineScriptHashes(html) {
  const hashes = []
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const [, attributes, body] = match
    if (/\ssrc\s*=/.test(attributes) || body === '') continue
    const hash = `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`
    if (!hashes.includes(hash)) hashes.push(hash)
  }
  return hashes
}

/**
 * The policy the Android app sends with a bundled page. Scripts run only from
 * the bundle (or match a hash of the page's own inline scripts), and the page
 * can reach only the sync server and the billing API.
 */
export function contentSecurityPolicy({ scriptHashes, connectSources }) {
  return [
    "default-src 'none'",
    // 'wasm-unsafe-eval' lets libsodium compile its WebAssembly; it does not allow eval().
    ["script-src 'self' 'wasm-unsafe-eval'", ...scriptHashes].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // data: covers libsodium fetching its embedded base64 WebAssembly.
    ["connect-src 'self' data:", ...connectSources].join(' '),
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ')
}
