import { describe, expect, it } from 'vitest'
import { getPaidBonusAccessDate, type SubscriptionBonusAccessData } from '../bonus-access'

const baseSubscription: SubscriptionBonusAccessData = {
  status: 'active',
  trial: {
    endsAt: null,
  },
  trialPath: null,
}

describe('subscription page paid bonus access date', () => {
  it('shows the stored pay-now bonus date after an immediate payment becomes active', () => {
    const data: SubscriptionBonusAccessData = {
      ...baseSubscription,
      trialPath: 'immediate',
      trial: {
        endsAt: '2026-07-07T18:25:00.000Z',
      },
    }

    expect(getPaidBonusAccessDate(data, new Date('2026-06-30T18:25:00.000Z'))).toBe('2026-07-07T18:25:00.000Z')
  })

  it('does not treat normal active subscriptions as pay-now bonus access', () => {
    const data: SubscriptionBonusAccessData = {
      ...baseSubscription,
      trial: {
        endsAt: null,
      },
    }

    expect(getPaidBonusAccessDate(data)).toBeNull()
  })

  it('hides the pay-now bonus date after the bonus access window has passed', () => {
    const data: SubscriptionBonusAccessData = {
      ...baseSubscription,
      trialPath: 'immediate',
      trial: {
        endsAt: '2026-07-07T18:25:00.000Z',
      },
    }

    expect(getPaidBonusAccessDate(data, new Date('2026-07-08T00:00:00.000Z'))).toBeNull()
  })
})
