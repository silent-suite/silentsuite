import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AnnualDisclosure } from '@/app/lib/billing-v2'
import { AnnualConfirmationSummary } from '../components/annual-confirmation-summary'

const base: AnnualDisclosure = {
  kind: 'charge_now', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: 3600,
  monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: null, firstChargeAt: null,
  cancelBy: null, cancelByInclusive: false, autoRenew: true, prepaid: false, refundWindowDays: 30,
  bonusDays: 0, periodEndRule: 'confirmation_plus_1_utc_calendar_year', renewalAt: null, entitlementEndsAt: null,
}
describe('server-disclosed confirmation copy', () => {
  it('never promises no charge for immediate Stripe payment', () => {
    render(<AnnualConfirmationSummary disclosure={base} />)
    expect(screen.getByText(/Pay €36.00 now by card/)).toBeInTheDocument()
    expect(screen.queryByText(/No charge today/)).not.toBeInTheDocument()
    expect(screen.queryByText('Not applicable')).not.toBeInTheDocument()
    expect(screen.getByText(/one year after payment confirmation/)).toBeInTheDocument()
  })
  it('describes Bitcoin as prepaid without renewal or fake dates', () => {
    render(<AnnualConfirmationSummary disclosure={{ ...base, kind: 'prepaid', prepaid: true, autoRenew: false, renewalAmountMinor: null, bonusDays: 14 }} />)
    expect(screen.getByText(/Pay €36.00 in Bitcoin/)).toHaveTextContent('No automatic renewal')
    expect(screen.getByText(/plus 14 bonus days/)).toBeInTheDocument()
    expect(screen.queryByText('Cancel before')).not.toBeInTheDocument()
    expect(screen.queryByText('Not applicable')).not.toBeInTheDocument()
  })
  it('shows card-trial amount, exact charge deadline and no charge today', () => {
    render(<AnnualConfirmationSummary disclosure={{ ...base, kind: 'card_trial', firstChargeAt: '2099-09-10T12:00:00Z', cancelBy: '2099-09-10T12:00:00Z' }} />)
    expect(screen.getByText(/No charge today/)).toBeInTheDocument()
    expect(screen.getAllByText('2099-09-10 12:00 UTC')).toHaveLength(2)
    expect(screen.getByText('After your trial')).toBeInTheDocument()
  })
  it('keeps the no-card review limited to free terms', () => {
    render(<AnnualConfirmationSummary disclosure={{ ...base, kind: 'no_auto_charge', firstChargeAmountMinor: 0, renewalAmountMinor: null, autoRenew: false, refundWindowDays: null, entitlementEndsAt: '2099-09-10T12:00:00Z' }} />)
    expect(screen.getByText(/7-day free trial/)).toHaveTextContent('No automatic charge or renewal')
    expect(screen.getByText('Free until')).toBeInTheDocument()
    expect(screen.queryByText('Payment')).not.toBeInTheDocument()
    expect(screen.queryByText('Not applicable')).not.toBeInTheDocument()
  })
})
