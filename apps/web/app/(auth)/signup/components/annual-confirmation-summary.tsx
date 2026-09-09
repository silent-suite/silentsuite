import type { AnnualDisclosure } from '@/app/lib/billing-v2'

const money = (minor: number) => `€${(minor / 100).toFixed(2)}`
const timestamp = (value: string) => `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`

export function annualConfirmationTitle(disclosure: AnnualDisclosure): string {
  return disclosure.kind === 'no_auto_charge' ? 'Start your free trial'
    : disclosure.kind === 'card_trial' ? 'Review your free trial'
      : disclosure.kind === 'charge_now' ? 'Review your card payment' : 'Review your Bitcoin payment'
}

export function annualConfirmationAction(disclosure: AnnualDisclosure): string {
  return disclosure.kind === 'no_auto_charge' ? 'Create account and start free trial'
    : disclosure.kind === 'card_trial' ? 'Continue to card setup'
      : disclosure.kind === 'charge_now' ? 'Continue to card payment' : 'Continue to Bitcoin payment'
}

export function annualCardSubmitLabel(disclosure: AnnualDisclosure): string {
  return disclosure.kind === 'card_trial' ? 'Start free trial — no charge today' : `Pay ${money(disclosure.firstChargeAmountMinor)} now`
}

/** Only the server disclosure kind determines whether the next step charges. */
export function AnnualConfirmationSummary({ disclosure }: { disclosure: AnnualDisclosure }) {
  const noCard = disclosure.kind === 'no_auto_charge'
  const cardTrial = disclosure.kind === 'card_trial'
  return <>
    <p className="text-sm text-[rgb(var(--muted))]">
      {noCard ? 'Start your 7-day free trial. No card required. No automatic charge or renewal.'
        : cardTrial ? 'Add a card next. No charge today. Cancel before the deadline below to avoid the annual charge.'
          : disclosure.kind === 'charge_now' ? `Pay ${money(disclosure.firstChargeAmountMinor)} now by card. This is an annual purchase, not a free trial.`
            : `Pay ${money(disclosure.firstChargeAmountMinor)} in Bitcoin. This is a prepaid annual purchase, not a free trial. No automatic renewal.`}
    </p>
    {disclosure.kind === 'prepaid' && disclosure.refundWindowDays === 30 && <p className="text-sm">Request a full refund within 30 days of your first payment—no questions asked.</p>}
    <dl className="space-y-2 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 text-sm">
      {!noCard && <>
        <div className="flex justify-between gap-4"><dt>{cardTrial ? 'After your trial' : 'Payment'}</dt><dd>{money(disclosure.firstChargeAmountMinor)}{cardTrial ? '/year' : ''}</dd></div>
        {disclosure.firstChargeAt && <div className="flex justify-between gap-4"><dt>First charge</dt><dd>{timestamp(disclosure.firstChargeAt)}</dd></div>}
        {disclosure.cancelBy && <div className="flex justify-between gap-4"><dt>Cancel before</dt><dd>{timestamp(disclosure.cancelBy)}</dd></div>}
        {disclosure.autoRenew && <div className="flex justify-between gap-4"><dt>Automatic renewal</dt><dd>{disclosure.renewalAmountMinor !== null ? `${money(disclosure.renewalAmountMinor)}/year` : 'Annual'}{disclosure.renewalAt ? ` from ${timestamp(disclosure.renewalAt)}` : ', one year after payment confirmation'}</dd></div>}
        {disclosure.refundWindowDays && <div className="flex justify-between gap-4"><dt>Refund window</dt><dd>{disclosure.refundWindowDays} days</dd></div>}
      </>}
      {disclosure.entitlementEndsAt && <div className="flex justify-between gap-4"><dt>{noCard ? 'Free until' : 'Access through'}</dt><dd>{timestamp(disclosure.entitlementEndsAt)}</dd></div>}
      {!disclosure.entitlementEndsAt && <div className="flex justify-between gap-4"><dt>Access</dt><dd>One year from payment confirmation{disclosure.bonusDays ? `, plus ${disclosure.bonusDays} bonus days` : ''}</dd></div>}
    </dl>
  </>
}
