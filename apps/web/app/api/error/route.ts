import { relayErrorReport } from '@/app/lib/error-relay'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Same-origin browser error report relay; see app/lib/error-relay.ts. */
export function POST(request: Request) {
  return relayErrorReport(request)
}
