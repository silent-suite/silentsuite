import { dedupeIntegration, globalHandlersIntegration, init } from '@sentry/nextjs'
import {
  browserReportContext,
  createErrorReportTransport,
  errorReportingEnabled,
} from '@/app/lib/error-report-client'

/*
 * Browser error reports only. Dormant unless a hosted production build is
 * given NEXT_PUBLIC_SENTRY_DSN and runs on https://app.silentsuite.io. The DSN
 * only switches the SDK on: the transport below posts rebuilt reports to the
 * same-origin relay (/api/error) and never contacts the DSN host. No tracing,
 * replay, sessions, breadcrumbs, client reports or default integrations.
 */
export function errorReportInitOptions(dsn: string) {
  return {
    dsn,
    environment: 'production',
    defaultIntegrations: false as const,
    integrations: [globalHandlersIntegration(), dedupeIntegration()],
    sendDefaultPii: false,
    maxBreadcrumbs: 0,
    sendClientReports: false,
    attachStacktrace: false,
    beforeBreadcrumb: () => null,
    beforeSendTransaction: () => null,
    transport: () => createErrorReportTransport({
      context: browserReportContext,
      beacon: navigator.sendBeacon?.bind(navigator),
    }),
  }
}

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

if (dsn && typeof window !== 'undefined' && errorReportingEnabled(window.location, dsn, process.env.NEXT_PUBLIC_SELF_HOSTED)) {
  init(errorReportInitOptions(dsn))
}
