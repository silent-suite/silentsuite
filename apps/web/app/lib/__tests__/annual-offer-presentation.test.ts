import { describe, expect, it } from 'vitest'
import { annualTermsCopy, compactAnnualPaymentCopy } from '../annual-offer-presentation'
import type { AnnualDisclosure } from '../billing-v2'

const accountCard: AnnualDisclosure = {
  kind: 'charge_now', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: 3600, monthlyEquivalentMinor: 300,
  currency: 'EUR', trialEndsAt: null, firstChargeAt: null, cancelBy: null, cancelByInclusive: false, autoRenew: true, prepaid: false,
  refundWindowDays: 30, bonusDays: 0, periodEndRule: 'account_confirmation_rules_v1', renewalAt: null, entitlementEndsAt: null,
}
const accountBitcoin: AnnualDisclosure = { ...accountCard, kind: 'prepaid', renewalAmountMinor: null, autoRenew: false, prepaid: true }

describe('compactAnnualPaymentCopy', () => {
  it('keeps the immediate charge and renewal without the rejected bonus/refund paragraph', () => {
    expect(compactAnnualPaymentCopy(accountCard)).toBe('€36.00 now · renews at €36.00/year until cancelled.')
  })

  it('distinguishes prepaid crypto without inventing when an existing account period begins', () => {
    expect(compactAnnualPaymentCopy(accountBitcoin)).toBe('€36.00 for one year · no automatic renewal.')
  })

  it('uses frozen historical charges and renewals, not current prices', () => {
    expect(compactAnnualPaymentCopy({ ...accountCard, annualAmountMinor: 4800, monthlyEquivalentMinor: 400, firstChargeAmountMinor: 4800, renewalAmountMinor: 4800 }))
      .toBe('€48.00 now · renews at €48.00/year until cancelled.')
  })

  it('does not describe a non-renewing immediate charge as a subscription', () => {
    expect(compactAnnualPaymentCopy({ ...accountCard, autoRenew: false, renewalAmountMinor: null })).toBe('€36.00 now · no automatic renewal.')
  })

  it('leaves other disclosure kinds on the existing presentation path', () => {
    const trial: AnnualDisclosure = { ...accountCard, kind: 'card_trial', firstChargeAmountMinor: 0, periodEndRule: 'first_charge_plus_1_utc_calendar_year' }
    expect(compactAnnualPaymentCopy(trial)).toBe(annualTermsCopy(trial))
  })
})

describe('annualTermsCopy', () => {
  // Frozen against unchanged Billing fulfillment (btcpay-invoice-persistence.ts,
  // payment-options.ts calculateBtcpayAnnualPeriodEnd/getBonusBase):
  // a future currentPeriodEnd extends from its end with no bonus; otherwise a
  // 7-day-trial account gets remaining trial + 14 days + one calendar year.
  it('states the prepaid account rules without calling all trial access bonusless', () => {
    expect(annualTermsCopy(accountBitcoin)).toBe(
      '€36.00 prepaid for one year, no automatic renewal. '
      + 'If a current subscription period is still running when payment is confirmed, your year starts when it ends, without a bonus. '
      + 'Otherwise your year starts at confirmation; accounts from the 7‑day trial first keep any remaining trial days plus a 14‑day bonus. '
      + '30-day refund window.',
    )
  })

  it('keeps the conditional Stripe bonus wording and adds the signed refund window', () => {
    expect(annualTermsCopy(accountCard)).toBe(
      '€36.00 now, then €36.00 every year until you cancel. '
      + 'If your account still qualifies when Stripe confirms payment, the 14‑day conversion bonus is applied to your Stripe subscription. '
      + '30-day refund window.',
    )
  })

  it('renders historical signed amounts and bonus with the refund window', () => {
    expect(annualTermsCopy({ ...accountCard, annualAmountMinor: 4800, firstChargeAmountMinor: 4800, renewalAmountMinor: 4800, monthlyEquivalentMinor: 400, bonusDays: 14, periodEndRule: 'confirmation_bonus_then_1_utc_calendar_year' }))
      .toBe('€48.00 now, then €48.00 every year until you cancel. 14 bonus days after payment confirms. 30-day refund window.')
  })

  it('never invents a refund term when the disclosure carries none', () => {
    const noCard: AnnualDisclosure = { ...accountCard, kind: 'no_auto_charge', firstChargeAmountMinor: 0, renewalAmountMinor: null, autoRenew: false, refundWindowDays: null, periodEndRule: 'activation_plus_trial' }
    expect(annualTermsCopy(noCard)).not.toMatch(/refund/i)
  })
})
