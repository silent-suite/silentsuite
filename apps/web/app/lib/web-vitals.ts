/*
 * Page-speed ratings for public pages only (sign-in and sign-up). Logged-in
 * screens are never measured. Each event names one metric, its Google rating
 * band and a fixed page label; the measured value itself is not sent.
 *
 * This route list is deliberately separate from SIGNUP_ANALYTICS_PATHS, which
 * also drives pageviews: adding a page here adds no pageview.
 */

export const WEB_VITALS_PAGES = [
  '/login',
  '/verify-email',
  '/signup',
  '/signup/plan',
  '/signup/verify-email',
  '/signup/pending-payment',
  '/signup/success',
  '/signup/cancel',
] as const
export type WebVitalsPage = typeof WEB_VITALS_PAGES[number]

export const WEB_VITAL_METRICS = ['LCP', 'INP', 'CLS', 'TTFB'] as const
export type WebVitalMetric = typeof WEB_VITAL_METRICS[number]

export const WEB_VITAL_RATINGS = ['good', 'needs-improvement', 'poor'] as const
export type WebVitalRating = typeof WEB_VITAL_RATINGS[number]

// https://web.dev/articles/vitals thresholds: [good upper bound, poor lower bound).
// LCP, INP and TTFB in milliseconds; CLS is unitless.
export const WEB_VITAL_THRESHOLDS: Readonly<Record<WebVitalMetric, readonly [number, number]>> = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  TTFB: [800, 1800],
}

export type WebVitalPayload = {
  domain: 'app.silentsuite.io'
  name: 'Web Vital'
  url: `https://app.silentsuite.io${WebVitalsPage}`
  props: { metric: WebVitalMetric; rating: WebVitalRating; page: WebVitalsPage }
}

export function isWebVitalMetric(name: unknown): name is WebVitalMetric {
  return typeof name === 'string' && (WEB_VITAL_METRICS as readonly string[]).includes(name)
}

export function webVitalsPageFor(pathname: string): WebVitalsPage | undefined {
  return (WEB_VITALS_PAGES as readonly string[]).includes(pathname) ? pathname as WebVitalsPage : undefined
}

export function rateWebVital(metric: WebVitalMetric, value: number): WebVitalRating | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined
  const [good, poor] = WEB_VITAL_THRESHOLDS[metric]
  if (value <= good) return 'good'
  if (value <= poor) return 'needs-improvement'
  return 'poor'
}

export function buildWebVitalPayload(metric: WebVitalMetric, rating: WebVitalRating, page: WebVitalsPage): WebVitalPayload {
  return {
    domain: 'app.silentsuite.io',
    name: 'Web Vital',
    url: `https://app.silentsuite.io${page}`,
    props: { metric, rating, page },
  }
}
