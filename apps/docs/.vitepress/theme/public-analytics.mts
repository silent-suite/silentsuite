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
  '/user-guide/faq', '/user-guide/getting-started', '/user-guide/tasks', '/user-guide/apps',
  '/user-guide/apps/android', '/user-guide/apps/dav-bridge', '/user-guide/apps/evolution',
  '/user-guide/apps/gnome', '/user-guide/apps/ios', '/user-guide/apps/kde',
  '/user-guide/apps/linux-bridge', '/user-guide/apps/macos', '/user-guide/apps/tasks-org',
  '/user-guide/apps/thunderbird', '/user-guide/apps/windows',
])

export function canonicalDocsPath(rawPath: string): string | undefined {
  const path = rawPath.split(/[?#]/, 1)[0].replace(/\/$/, '') || '/'
  return REGISTERED_DOCS_PATHS.has(path) ? path : undefined
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
