export type DocsOutboundEvent =
  | { event: 'Hosted App Click'; props: { surface: 'docs'; route_class: 'app_home' | 'signup' } }
  | {
      event: 'Android Download Click'
      props: { surface: 'docs_android'; channel: 'google_play' | 'zapstore' | 'obtainium' | 'github_release' }
    }
  | { event: 'GitHub Click'; props: { surface: 'docs_android'; channel: 'repository' } }

export const REGISTERED_DOCS_PATHS = new Set([
  '/', '/app-logo-notices', '/bridge', '/contributing', '/contributing/architecture-overview',
  '/contributing/code-conventions', '/contributing/dev-setup', '/contributing/pull-request-guide',
  '/contributing/testing', '/self-hosting', '/self-hosting/admin-dashboard',
  '/self-hosting/architecture', '/self-hosting/backup-and-restore', '/self-hosting/configuration',
  '/self-hosting/manual-setup', '/self-hosting/quick-start', '/self-hosting/requirements',
  '/self-hosting/troubleshooting', '/self-hosting/uninstalling', '/self-hosting/updating',
  '/user-guide', '/user-guide/calendar', '/user-guide/contacts', '/user-guide/encryption-explained',
  '/user-guide/faq', '/user-guide/getting-started', '/user-guide/notes', '/user-guide/tasks', '/user-guide/apps',
  '/user-guide/apps/android', '/user-guide/apps/dav-bridge', '/user-guide/apps/evolution',
  '/user-guide/apps/gnome', '/user-guide/apps/ios', '/user-guide/apps/kde',
  '/user-guide/apps/linux-bridge', '/user-guide/apps/macos', '/user-guide/apps/tasks-org',
  '/user-guide/apps/thunderbird', '/user-guide/apps/windows',
])

export const DOCS_ANALYTICS_DOMAIN = 'docs.silentsuite.io'
export const DOCS_ANALYTICS_ORIGIN = `https://${DOCS_ANALYTICS_DOMAIN}` as const

// Closed referrer vocabulary. Plausible's source list still recognizes twitter.com/t.co
// rather than x.com, so every X-family host collapses onto the twitter.com origin.
export const DOCS_CANONICAL_REFERRERS = [
  'https://www.google.com/',
  'https://www.bing.com/',
  'https://duckduckgo.com/',
  'https://search.brave.com/',
  'https://www.ecosia.org/',
  'https://twitter.com/',
  'https://www.reddit.com/',
  'https://github.com/',
  'https://mastodon.social/',
  'https://bsky.app/',
  'https://alternativeto.net/',
  'https://www.privacyguides.org/',
  'https://news.ycombinator.com/',
] as const

export type DocsCanonicalReferrer = (typeof DOCS_CANONICAL_REFERRERS)[number]

export type DocsPageviewPayload = {
  domain: typeof DOCS_ANALYTICS_DOMAIN
  name: 'pageview'
  url: string
  referrer?: DocsCanonicalReferrer
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

const GOOGLE_SEARCH_DOMAINS = [
  'google.com', 'google.co.uk', 'google.de', 'google.fr', 'google.nl', 'google.be',
  'google.ch', 'google.at', 'google.ca', 'google.com.au', 'google.co.nz', 'google.ie',
  'google.es', 'google.it', 'google.pt', 'google.se', 'google.no', 'google.dk',
  'google.fi', 'google.pl', 'google.cz', 'google.co.jp', 'google.co.kr', 'google.co.in',
  'google.com.br', 'google.com.mx', 'google.co.za',
] as const

function hasNonCanonicalRawSyntax(raw: string): boolean {
  return /[\u0000-\u0020\u007f\\]/.test(raw)
}

function rawHttpAuthority(raw: string): string | undefined {
  return raw.match(/^https?:\/\/([^/?#]+)(?:[/?#]|$)/i)?.[1]
}

function hasExplicitPort(raw: string): boolean {
  const authority = rawHttpAuthority(raw)
  return authority ? /:\d*$/.test(authority) : false
}

function isCanonicalDnsAuthority(authority: string): boolean {
  return authority.length <= 253 && authority.split('.').every(
    (label) => label.length >= 1
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  )
}

function hasNonCanonicalAuthoritySyntax(raw: string): boolean {
  const authority = rawHttpAuthority(raw)
  return !authority || !isCanonicalDnsAuthority(authority)
}

export function canonicalizeDocsReferrer(raw: string): DocsCanonicalReferrer | undefined {
  if (!raw) return undefined
  if (hasNonCanonicalRawSyntax(raw)) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    const host = url.hostname.toLowerCase()
    if (url.username || url.password || hasExplicitPort(raw) || hasNonCanonicalAuthoritySyntax(raw) || host === 'localhost' || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host) || host.includes('xn--')) return undefined
    if (GOOGLE_SEARCH_DOMAINS.some((domain) => hostMatches(host, domain))) return 'https://www.google.com/'
    if (hostMatches(host, 'bing.com')) return 'https://www.bing.com/'
    if (hostMatches(host, 'duckduckgo.com')) return 'https://duckduckgo.com/'
    if (hostMatches(host, 'search.brave.com')) return 'https://search.brave.com/'
    if (hostMatches(host, 'ecosia.org')) return 'https://www.ecosia.org/'
    if (hostMatches(host, 'x.com') || hostMatches(host, 'twitter.com') || host === 't.co') return 'https://twitter.com/'
    if (hostMatches(host, 'reddit.com') || host === 'redd.it') return 'https://www.reddit.com/'
    if (hostMatches(host, 'github.com')) return 'https://github.com/'
    if (host === 'mastodon.social') return 'https://mastodon.social/'
    if (hostMatches(host, 'bsky.app')) return 'https://bsky.app/'
    if (hostMatches(host, 'alternativeto.net')) return 'https://alternativeto.net/'
    if (hostMatches(host, 'privacyguides.org')) return 'https://www.privacyguides.org/'
    if (host === 'news.ycombinator.com') return 'https://news.ycombinator.com/'
    return undefined
  } catch {
    return undefined
  }
}

export function canonicalDocsPath(rawPath: string): string | undefined {
  const path = rawPath.split(/[?#]/, 1)[0].replace(/\/$/, '') || '/'
  return REGISTERED_DOCS_PATHS.has(path) ? path : undefined
}

export function buildDocsPageviewPayload(rawPath: string, rawReferrer: string): DocsPageviewPayload | undefined {
  const path = canonicalDocsPath(rawPath)
  if (!path) return undefined
  const referrer = canonicalizeDocsReferrer(rawReferrer)
  return {
    domain: DOCS_ANALYTICS_DOMAIN,
    name: 'pageview',
    url: `${DOCS_ANALYTICS_ORIGIN}${path}`,
    ...(referrer ? { referrer } : {}),
  }
}

export function createDocsPageviewTracker(deliver: (path: string) => void) {
  let lastPath: string | undefined
  return (rawPath: string) => {
    const path = canonicalDocsPath(rawPath)
    if (!path || path === lastPath) return
    lastPath = path
    deliver(path)
  }
}

const APPROVED_DESTINATIONS: Readonly<Record<string, DocsOutboundEvent>> = {
  'https://app.silentsuite.io': {
    event: 'Hosted App Click',
    props: { surface: 'docs', route_class: 'app_home' },
  },
  'https://app.silentsuite.io/signup': {
    event: 'Hosted App Click',
    props: { surface: 'docs', route_class: 'signup' },
  },
}

const ANDROID_DESTINATIONS: Readonly<Record<string, DocsOutboundEvent>> = {
  'https://play.google.com/store/apps/details?id=io.silentsuite.android': {
    event: 'Android Download Click',
    props: { surface: 'docs_android', channel: 'google_play' },
  },
  'https://zapstore.dev/apps/io.silentsuite.android': {
    event: 'Android Download Click',
    props: { surface: 'docs_android', channel: 'zapstore' },
  },
  'obtainium://add/https://github.com/silent-suite/silentsuite': {
    event: 'Android Download Click',
    props: { surface: 'docs_android', channel: 'obtainium' },
  },
  'https://github.com/silent-suite/silentsuite/releases/latest': {
    event: 'Android Download Click',
    props: { surface: 'docs_android', channel: 'github_release' },
  },
  'https://github.com/silent-suite/silentsuite/tree/main/android': {
    event: 'GitHub Click',
    props: { surface: 'docs_android', channel: 'repository' },
  },
}

// Closed outbound event vocabulary. The relay rebuilds admitted events from these exact
// signatures, so a browser can never widen the event name or property set.
export const DOCS_OUTBOUND_EVENT_SIGNATURES: readonly DocsOutboundEvent[] = [
  ...Object.values(APPROVED_DESTINATIONS),
  ...Object.values(ANDROID_DESTINATIONS),
]

const HOSTED_APP_ROUTES = new Set([
  '/user-guide/getting-started',
  '/user-guide/apps',
  '/self-hosting',
  '/self-hosting/quick-start',
  '/self-hosting/manual-setup',
  '/self-hosting/architecture',
  '/user-guide/faq',
  '/user-guide/calendar',
])

export function classifyDocsOutboundEvent(rawHref: string, docsPath: string): DocsOutboundEvent | undefined {
  try {
    const url = new URL(rawHref)
    if (url.username || url.password || url.hash) return undefined
    const destination = url.toString().replace(/\/$/, '')
    const normalizedPath = docsPath.replace(/\/$/, '') || '/'
    if (normalizedPath === '/user-guide/apps/android') return ANDROID_DESTINATIONS[destination]
    if (url.search) return undefined
    if (HOSTED_APP_ROUTES.has(normalizedPath)) return APPROVED_DESTINATIONS[destination]
    return undefined
  } catch {
    return undefined
  }
}
