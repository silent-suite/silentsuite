import { relayAnalyticsEvent } from '@/app/lib/analytics-relay'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Same-origin signup analytics relay; see app/lib/analytics-relay.ts. */
export function POST(request: Request) {
  return relayAnalyticsEvent(request)
}
