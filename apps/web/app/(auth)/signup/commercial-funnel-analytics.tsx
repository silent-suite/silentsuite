'use client'

import { useEffect, useRef } from 'react'
import { buildCheckoutInitiatedPayload, buildCheckoutReturnedPayload, buildPlanSelectedPayload, type CommercialEventPayload } from '@/app/lib/public-analytics'
import type { AnnualOffer } from '@/app/lib/billing-v2'

const PLAUSIBLE_EVENT_ENDPOINT = 'https://plausible.silentsuite.io/api/event'

export function shouldSendCommercialAnalytics(location: URL, payload: CommercialEventPayload, enabled = process.env.NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED): boolean {
  return enabled === 'true'
    && location.protocol === 'https:'
    && location.hostname === 'app.silentsuite.io'
    && `${location.origin}${location.pathname}` === payload.url
}

export function sendCommercialEvent(payload: CommercialEventPayload, beacon = navigator.sendBeacon?.bind(navigator), fetcher: typeof fetch = fetch, location = new URL(window.location.href), enabled = process.env.NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED) {
  if (!shouldSendCommercialAnalytics(location, payload, enabled)) return
  const body = JSON.stringify(payload)
  if (beacon) { beacon(PLAUSIBLE_EVENT_ENDPOINT, new Blob([body], { type: 'application/json' })); return }
  void fetcher(PLAUSIBLE_EVENT_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true })
}

export function CheckoutReturnAnalytics({ outcome, paymentMethod }: { outcome: 'returned' | 'cancelled' | 'failed' | 'pending'; paymentMethod: 'stripe' | 'btcpay' | 'unknown' }) {
  const sent = useRef(false)
  useEffect(() => { if (!sent.current) { sent.current = true; sendCommercialEvent(buildCheckoutReturnedPayload(outcome, paymentMethod)) } }, [outcome, paymentMethod])
  return null
}
export function trackPlanSelected(offer: AnnualOffer) { sendCommercialEvent(buildPlanSelectedPayload(offer)) }
export function trackCheckoutInitiated(offer: AnnualOffer, paymentMethod: 'stripe' | 'btcpay') { sendCommercialEvent(buildCheckoutInitiatedPayload(offer, paymentMethod)) }
