import type { AnnualDisclosure } from '@/app/lib/billing-v2'

const money = (minor: number) => `€${(minor / 100).toFixed(2)}`
/** Server-disclosed instant as a UTC calendar day, DD.MM.YYYY; null when absent or unparsable so no date is invented. */
const chargeDay = (value: string | null): string | null => {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}`
}

/** Label for retrying a payment start that did not complete for the same claim. */
export function annualRetryAction(disclosure: AnnualDisclosure): string {
  return disclosure.kind === 'card_trial' ? 'Retry card setup'
    : disclosure.kind === 'charge_now' ? 'Retry card payment'
      : disclosure.kind === 'prepaid' ? 'Retry cryptocurrency payment' : 'Continue to your workspace'
}

export function annualCardSubmitLabel(disclosure: AnnualDisclosure): string {
  return disclosure.kind === 'card_trial' ? 'Start free trial — no charge today' : `Pay ${money(disclosure.firstChargeAmountMinor)} now`
}

/** One line stating what continuing does on the no-card path; it is the only mutation there. */
export function noCardTrialConsequence(disclosure: AnnualDisclosure): string | null {
  if (disclosure.kind !== 'no_auto_charge') return null
  return 'Continuing creates your account and starts your 7-day free trial. No card required. No automatic charge or renewal.'
}

/**
 * Concise customer terms beside the payable controls. Only the server
 * disclosure kind determines whether, when and how much the next step charges.
 */
export function AnnualTermsSummary({ disclosure }: { disclosure: AnnualDisclosure }) {
  const access = `one year of access${disclosure.bonusDays ? ` plus ${disclosure.bonusDays} bonus days` : ''}`
  if (disclosure.kind === 'no_auto_charge') {
    return <p className="text-sm text-[rgb(var(--muted))]">{noCardTrialConsequence(disclosure)}</p>
  }
  if (disclosure.kind === 'card_trial') {
    return (
      <p className="text-sm text-[rgb(var(--muted))]">
        Add your card information. After that the 30 days free trial starts and you only get billed
        {chargeDay(disclosure.firstChargeAt) ? ` on ${chargeDay(disclosure.firstChargeAt)}` : ' once the trial ends'}, if not cancelled before.
      </p>
    )
  }
  if (disclosure.kind === 'charge_now') {
    return (
      <div className="space-y-1 text-sm text-[rgb(var(--muted))]">
        <p>{money(disclosure.firstChargeAmountMinor)} now by card for {access}.</p>
        <p>
          {disclosure.autoRenew ? `Auto-renews at ${money(disclosure.renewalAmountMinor ?? disclosure.annualAmountMinor)}/year. Cancel anytime. ` : 'No automatic renewal. '}
          {disclosure.refundWindowDays ? `${disclosure.refundWindowDays}-day refund window.` : ''}
        </p>
      </div>
    )
  }
  return (
    <div className="space-y-1 text-sm text-[rgb(var(--muted))]">
      <p>{money(disclosure.firstChargeAmountMinor)} now for {access}. No automatic renewal.</p>
      {disclosure.refundWindowDays === 30 && <p>30-day full refund, no questions asked.</p>}
    </div>
  )
}
