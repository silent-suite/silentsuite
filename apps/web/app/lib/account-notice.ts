/** Billing's informational account notice on GET /subscription (additive contract). */
export type AccountNotice =
  | { kind: 'trial_days_left'; trialEndsAt: string; daysRemaining: number }
  | { kind: 'trial_ended'; endedAt: string }
  | { kind: 'access_ended'; endedAt: string | null }

/** Billing's authoritative label for the subscription date row. */
export interface BillingDate {
  kind: 'renews' | 'access_until' | 'trial_ends' | 'first_charge' | 'ended'
  at: string | null
}

export const DAY_MS = 86_400_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

/** Billing serializes with toISOString(): UTC, `Z` suffix, optional milliseconds. */
function isIsoDate(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value))
}

/** Closed parser: anything absent, unknown or malformed is null and shows nothing. */
export function parseAccountNotice(value: unknown): AccountNotice | null {
  if (!isRecord(value)) return null
  if (value.kind === 'trial_days_left') {
    return hasExactKeys(value, ['kind', 'trialEndsAt', 'daysRemaining'])
      && isIsoDate(value.trialEndsAt)
      && Number.isInteger(value.daysRemaining) && (value.daysRemaining as number) >= 1
      ? { kind: 'trial_days_left', trialEndsAt: value.trialEndsAt, daysRemaining: value.daysRemaining as number }
      : null
  }
  if (value.kind === 'trial_ended') {
    return hasExactKeys(value, ['kind', 'endedAt']) && isIsoDate(value.endedAt)
      ? { kind: 'trial_ended', endedAt: value.endedAt }
      : null
  }
  if (value.kind === 'access_ended') {
    return hasExactKeys(value, ['kind', 'endedAt']) && (value.endedAt === null || isIsoDate(value.endedAt))
      ? { kind: 'access_ended', endedAt: value.endedAt }
      : null
  }
  return null
}

const BILLING_DATE_KINDS: ReadonlyArray<BillingDate['kind']> = ['renews', 'access_until', 'trial_ends', 'first_charge', 'ended']

/** Closed parser for billingDate; only `ended` may carry a null date. */
export function parseBillingDate(value: unknown): BillingDate | null {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'at'])) return null
  const kind = value.kind as BillingDate['kind']
  if (!BILLING_DATE_KINDS.includes(kind)) return null
  if (isIsoDate(value.at)) return { kind, at: value.at }
  return kind === 'ended' && value.at === null ? { kind, at: null } : null
}

/** Whole days left on the client clock, rounded up like Billing; 0 once the instant has passed. */
export function trialDaysLeft(trialEndsAtMs: number, nowMs: number): number {
  return trialEndsAtMs > nowMs ? Math.ceil((trialEndsAtMs - nowMs) / DAY_MS) : 0
}
