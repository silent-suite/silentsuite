export interface SubscriptionBonusAccessData {
  status: 'none' | 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired'
  trialPath: '7day' | '30day' | 'immediate' | null
  trial: {
    endsAt: string | null
  }
}

export function getPaidBonusAccessDate(data: SubscriptionBonusAccessData, now = new Date()): string | null {
  if (data.status !== 'active') return null
  if (data.trialPath !== 'immediate') return null
  if (!data.trial.endsAt) return null
  if (new Date(data.trial.endsAt) <= now) return null

  return data.trial.endsAt
}
