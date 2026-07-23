export type DocsOutboundEvent =
  | { event: 'Hosted App Click'; props: { surface: 'docs'; route_class: 'app_home' | 'signup' } }
  | {
      event: 'Android Download Click'
      props: { surface: 'docs_android'; channel: 'google_play' | 'zapstore' | 'obtainium' | 'github_release' }
    }
  | { event: 'GitHub Click'; props: { surface: 'docs_android'; channel: 'repository' } }

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
  'https://apps.obtainium.imranr.dev/redirect.html?r=obtainium://add/https://github.com/silent-suite/silentsuite': {
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
