'use client'

import { useEffect, useRef } from 'react'
import { buildCheckoutInitiatedPayload, buildCheckoutReturnedPayload, buildPlanSelectedPayload, buildSignupStepPayload, type CommercialEventPayload, type SignupStep } from '@/app/lib/public-analytics'
import type { AnnualOffer } from '@/app/lib/billing-v2'

// Same-origin relay (app/api/event/route.ts); the browser never contacts the analytics host.
const ANALYTICS_RELAY_ENDPOINT = '/api/event'

export function shouldSendCommercialAnalytics(location: URL, payload: CommercialEventPayload, enabled = process.env.NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED): boolean {
  return enabled === 'true'
    && location.protocol === 'https:'
    && location.hostname === 'app.silentsuite.io'
    && `${location.origin}${location.pathname}` === payload.url
}

export function sendCommercialEvent(payload: CommercialEventPayload, beacon = navigator.sendBeacon?.bind(navigator), fetcher: typeof fetch = fetch, location = new URL(window.location.href), enabled = process.env.NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED) {
  if (!shouldSendCommercialAnalytics(location, payload, enabled)) return
  const body = JSON.stringify(payload)
  if (beacon && beacon(ANALYTICS_RELAY_ENDPOINT, new Blob([body], { type: 'application/json' }))) return
  void fetcher(ANALYTICS_RELAY_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true })
}

export function CheckoutReturnAnalytics({ outcome, paymentMethod }: { outcome: 'returned' | 'cancelled' | 'failed' | 'pending'; paymentMethod: 'stripe' | 'btcpay' | 'unknown' }) {
  const sent = useRef(false)
  useEffect(() => { if (!sent.current) { sent.current = true; sendCommercialEvent(buildCheckoutReturnedPayload(outcome, paymentMethod)) } }, [outcome, paymentMethod])
  return null
}
export function trackPlanSelected(offer: AnnualOffer) { sendCommercialEvent(buildPlanSelectedPayload(offer)) }
export function trackCheckoutInitiated(offer: AnnualOffer, paymentMethod: 'stripe' | 'btcpay') { sendCommercialEvent(buildCheckoutInitiatedPayload(offer, paymentMethod)) }
export function trackSignupStep(step: SignupStep) { sendCommercialEvent(buildSignupStepPayload(step)) }

/** Maps the hosted signup state to its funnel milestone; self-hosted server signups are not counted. */
export function signupStepFor(view: { step: string; awaitingEmailProof: boolean; usingSelfHostedServer: boolean }): SignupStep | null {
  if (view.usingSelfHostedServer) return null
  if (view.step === 'account') return view.awaitingEmailProof ? 'verification_requested' : null
  if (view.step === 'verifiedAccount') return 'email_verified'
  if (view.step === 'plan') return 'plan_shown'
  if (view.step === 'vault') return 'account_created'
  return null
}

/** Sends each milestone at most once per page load. */
export function createSignupStepRecorder(send: (step: SignupStep) => void = trackSignupStep) {
  const sent = new Set<SignupStep>()
  return (step: SignupStep | null) => {
    if (!step || sent.has(step)) return
    sent.add(step)
    send(step)
  }
}
