import type { AnnualDisclosure, AnnualOffer, AnnualProvider } from './billing-v2'

/**
 * Presentation-only helpers for the signed annual offer.  The public client
 * never substitutes a customer class, price, interval, or provider list.
 */
function formatMinorAmount(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(amountMinor / 100)
}

export function annualOfferClassLabel(offer: AnnualOffer): string {
  return offer.customerClass === 'early' ? 'Early Adopter' : 'Standard'
}

export function annualOfferPlanLabel(offer: AnnualOffer): string {
  return `${annualOfferClassLabel(offer)} Plan`
}

export function formatAnnualOfferAmount(offer: AnnualOffer): string {
  return formatMinorAmount(offer.annualAmountMinor, offer.currency)
}

export function formatAnnualOfferMonthlyEquivalent(offer: AnnualOffer): string {
  return formatMinorAmount(offer.monthlyEquivalentMinor, offer.currency)
}

export function annualOfferAnnualLabel(offer: AnnualOffer): string {
  return `${formatAnnualOfferAmount(offer)}/year`
}

export function annualOfferMonthlyLabel(offer: AnnualOffer): string {
  return `${formatAnnualOfferMonthlyEquivalent(offer)}/month`
}

export function annualOfferRenewalCopy(offer: AnnualOffer): string {
  return `${annualOfferAnnualLabel(offer)}, billed annually (${annualOfferMonthlyLabel(offer)})`
}

/** Amount charged now under a signed disclosure; never today's offer. */
export function formatDisclosureAmount(disclosure: AnnualDisclosure): string {
  return formatMinorAmount(disclosure.firstChargeAmountMinor, disclosure.currency)
}

/**
 * Customer-facing terms rendered only from a signed disclosure. Amounts are
 * the signed ones; benefit wording follows the signed rule and never promises
 * an unconditional bonus for the account profile. The prepaid account wording
 * mirrors Billing settlement: a running subscription period is extended from
 * its end without a bonus; otherwise 7-day-trial accounts keep the remaining
 * trial plus 14 days before the year.
 */
export function annualTermsCopy(disclosure: AnnualDisclosure): string {
  const amount = (minor: number) => formatMinorAmount(minor, disclosure.currency)
  const terms = disclosure.prepaid
    ? `${amount(disclosure.annualAmountMinor)} prepaid for one year, no automatic renewal.`
    : disclosure.renewalAmountMinor === null
      ? `${amount(disclosure.firstChargeAmountMinor)} now.`
      : `${amount(disclosure.firstChargeAmountMinor)} now, then ${amount(disclosure.renewalAmountMinor)} every year until you cancel.`
  const refund = disclosure.refundWindowDays === null ? '' : ` ${disclosure.refundWindowDays}-day refund window.`
  if (disclosure.periodEndRule === 'account_confirmation_rules_v1') {
    return disclosure.prepaid
      ? `${terms} If a current subscription period is still running when payment is confirmed, your year starts when it ends, without a bonus. Otherwise your year starts at confirmation; accounts from the 7‑day trial first keep any remaining trial days plus a 14‑day bonus.${refund}`
      : `${terms} If your account still qualifies when Stripe confirms payment, the 14‑day conversion bonus is applied to your Stripe subscription.${refund}`
  }
  return `${disclosure.bonusDays === 14 ? `${terms} 14 bonus days after payment confirms.` : terms}${refund}`
}

/** Compact existing-account payment summary; never changes the signed terms. */
export function compactAnnualPaymentCopy(disclosure: AnnualDisclosure): string {
  if (disclosure.kind === 'prepaid') {
    return `${formatMinorAmount(disclosure.annualAmountMinor, disclosure.currency)} for one year · no automatic renewal.`
  }
  if (disclosure.kind === 'charge_now') {
    const charge = formatDisclosureAmount(disclosure)
    return disclosure.autoRenew && disclosure.renewalAmountMinor !== null
      ? `${charge} now · renews at ${formatMinorAmount(disclosure.renewalAmountMinor, disclosure.currency)}/year until cancelled.`
      : `${charge} now · no automatic renewal.`
  }
  return annualTermsCopy(disclosure)
}

export function isAnnualOfferProviderAvailable(
  offer: AnnualOffer,
  provider: AnnualProvider,
  globallyEnabled = true,
): boolean {
  return globallyEnabled && offer.providers.includes(provider)
}

export type AnnualOfferAnalyticsDimensions = {
  plan_id: AnnualOffer['planId']
  customer_class: AnnualOffer['customerClass']
  billing_interval: AnnualOffer['billingInterval']
  annual_amount_minor: AnnualOffer['annualAmountMinor']
  monthly_equivalent_minor: AnnualOffer['monthlyEquivalentMinor']
  currency: AnnualOffer['currency']
}

/** Deliberately excludes offerToken, requestId, and other linkable authority. */
export function annualOfferAnalyticsDimensions(offer: AnnualOffer): AnnualOfferAnalyticsDimensions {
  return {
    plan_id: offer.planId,
    customer_class: offer.customerClass,
    billing_interval: offer.billingInterval,
    annual_amount_minor: offer.annualAmountMinor,
    monthly_equivalent_minor: offer.monthlyEquivalentMinor,
    currency: offer.currency,
  }
}
