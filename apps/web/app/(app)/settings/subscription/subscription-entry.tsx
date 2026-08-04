'use client'

import { useEffect, useRef } from 'react'
import { sendCommercialEvent } from '@/app/(auth)/signup/commercial-funnel-analytics'
import { buildSubscriptionManagementEntryPayload } from '@/app/lib/public-analytics'

export function SubscriptionEntry() {
  const sent = useRef(false)
  useEffect(() => { if (!sent.current) { sent.current = true; sendCommercialEvent(buildSubscriptionManagementEntryPayload()) } }, [])
  return null
}
