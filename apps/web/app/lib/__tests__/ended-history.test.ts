import { describe, expect, it } from 'vitest'
import { classifyEndedHistory } from '../account-notice'

const DAY = 86_400_000
const past = (days: number) => new Date(Date.now() - days * DAY).toISOString()

const body = (fields: Record<string, unknown>) => ({
  status: 'expired', trialPath: null, renewalDate: null,
  trial: { active: false, endsAt: null, daysRemaining: null },
  hostedAccess: 'unknown', accountNotice: null, ...fields,
})

// SIGNUP-04: wording only; these bodies mirror the scanned fixtures and Billing's write paths.
describe('classifyEndedHistory', () => {
  it.each([
    ['a seven-day trial that ran out', body({ trialPath: '7day', trial: { endsAt: past(140) } }), 'trial'],
    ['a card trial cancelled at its trial end', body({ status: 'cancelled', trialPath: '30day', renewalDate: past(120), trial: { endsAt: past(120) } }), 'trial'],
    ['a paid year after a trial', body({ trialPath: '30day', renewalDate: past(3), trial: { endsAt: past(400) } }), 'subscription'],
    ['a trial path without a stored trial end', body({ trialPath: '30day', renewalDate: past(120) }), 'subscription'],
    ['a pay-now subscription', body({ status: 'cancelled', trialPath: 'immediate', renewalDate: past(3) }), 'subscription'],
    ['a pay-now signup that never paid', body({ status: 'none', trialPath: 'immediate' }), 'unpaid'],
    ['a crypto signup that never paid', body({ status: 'none', trialPath: 'crypto_annual' }), 'unpaid'],
    ['an unsubscribed trial account', body({ status: 'none', trialPath: '30day' }), 'trial'],
    ['a proven ended trial', body({ status: 'trialing', hostedAccess: 'trial_ended' }), 'trial'],
    ['Billing\'s trial_ended notice', body({ accountNotice: { kind: 'trial_ended', endedAt: past(2) } }), 'trial'],
  ])('reads %s', (_label, input, expected) => {
    expect(classifyEndedHistory(input)).toBe(expected)
  })

  it.each([
    ['an active subscription', body({ status: 'active' })],
    ['a running trial', body({ status: 'trialing' })],
    ['a past-due subscription', body({ status: 'past_due' })],
    ['no body', null],
  ])('names nothing for %s', (_label, input) => {
    expect(classifyEndedHistory(input)).toBeNull()
  })
})
