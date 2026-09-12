import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AnnualDisclosure } from '@/app/lib/billing-v2'
import { AnnualTermsSummary, annualCardSubmitLabel, annualRetryAction, noCardTrialConsequence } from '../components/annual-confirmation-summary'

const base: AnnualDisclosure = {
  kind: 'charge_now', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: 3600,
  monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: null, firstChargeAt: null,
  cancelBy: null, cancelByInclusive: false, autoRenew: true, prepaid: false, refundWindowDays: 30,
  bonusDays: 0, periodEndRule: 'confirmation_plus_1_utc_calendar_year', renewalAt: null, entitlementEndsAt: null,
}
describe('server-disclosed concise terms', () => {
  it('never promises no charge or a trial for immediate Stripe payment', () => {
    render(<AnnualTermsSummary disclosure={base} />)
    expect(screen.getByText(/€36.00 now by card/)).toHaveTextContent('one year of access')
    expect(screen.queryByText(/No charge today|30-day trial|Start.*free trial/)).not.toBeInTheDocument()
    expect(screen.queryByText('Not applicable')).not.toBeInTheDocument()
    expect(screen.getByText(/Auto-renews at €36.00\/year/)).toHaveTextContent('30-day refund window')
    expect(annualCardSubmitLabel(base)).toBe('Pay €36.00 now')
    expect(annualRetryAction(base)).toBe('Retry card payment')
  })
  it('describes Bitcoin as prepaid without renewal or fake dates', () => {
    render(<AnnualTermsSummary disclosure={{ ...base, kind: 'prepaid', prepaid: true, autoRenew: false, renewalAmountMinor: null, bonusDays: 14 }} />)
    expect(screen.getByText(/€36.00 now/)).toHaveTextContent('No automatic renewal')
    expect(screen.getByText(/plus 14 bonus days/)).toBeInTheDocument()
    expect(screen.getByText(/30-day full refund, no questions asked/)).toBeInTheDocument()
    expect(screen.queryByText(/Cancel before|Not applicable|UTC/)).not.toBeInTheDocument()
    expect(annualRetryAction({ ...base, kind: 'prepaid' })).toBe('Retry cryptocurrency payment')
  })
  it('shows card-trial amount, exact charge date and no charge today', () => {
    const cardTrial: AnnualDisclosure = { ...base, kind: 'card_trial', firstChargeAt: '2099-09-10T12:00:00Z', cancelBy: '2099-09-10T12:00:00Z' }
    render(<AnnualTermsSummary disclosure={cardTrial} />)
    expect(screen.getByText(/€0 today/)).toHaveTextContent('€36.00 on 2099-09-10 12:00 UTC')
    expect(screen.getByText(/Auto-renews at €36.00\/year/)).toHaveTextContent('Cancel anytime')
    expect(annualCardSubmitLabel(cardTrial)).toBe('Start free trial — no charge today')
    expect(annualRetryAction(cardTrial)).toBe('Retry card setup')
  })
  it('keeps a different renewal price visible in compact card terms', () => {
    render(<AnnualTermsSummary disclosure={{ ...base, kind: 'card_trial', firstChargeAt: '2099-09-10T12:00:00Z', renewalAmountMinor: 4800 }} />)
    expect(screen.getByText(/€0 today/)).toHaveTextContent('€36.00 on 2099-09-10 12:00 UTC')
    expect(screen.getByText(/Auto-renews at €48.00\/year/)).toBeInTheDocument()
    expect(screen.getByText(/Cancel before then to avoid a charge/)).toBeInTheDocument()
  })
  it('keeps the no-card line limited to free terms and states that continuing creates the account', () => {
    const noCard: AnnualDisclosure = { ...base, kind: 'no_auto_charge', firstChargeAmountMinor: 0, renewalAmountMinor: null, autoRenew: false, refundWindowDays: null, entitlementEndsAt: '2099-09-10T12:00:00Z' }
    render(<AnnualTermsSummary disclosure={noCard} />)
    expect(screen.getByText(/7-day free trial/)).toHaveTextContent('No card required. No automatic charge or renewal.')
    expect(screen.getByText(/creates your account/)).toBeInTheDocument()
    expect(screen.queryByText(/Payment|Free until|UTC|Not applicable/)).not.toBeInTheDocument()
    expect(noCardTrialConsequence(noCard)).toMatch(/creates your account and starts your 7-day free trial/)
    expect(noCardTrialConsequence(base)).toBeNull()
  })
})
