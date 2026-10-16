import { useAuthStore } from '@/app/stores/use-auth-store'
import { getAccountEpoch } from './account-epoch'
import type { BillingV2Fetch } from './billing-v2'

export class PaymentSessionRecoveryError extends Error {
  constructor(readonly signInRequired: boolean) {
    super(signInRequired ? 'Billing could not confirm your sign-in. Sign in again to continue this payment.'
      : 'Billing could not refresh your session. Retry to continue the same payment.')
  }
}

let refreshing: { account: string | null; epoch: number; promise: Promise<boolean> } | null = null

/** One bounded recovery of a middleware authentication rejection. Transport
 * ambiguity never reaches refresh or request replay. Each panel captures its
 * original identity; even a completed refresh cannot replay across accounts.
 */
export function createAuthenticatedPaymentFetch(account: string | null, epoch: number): BillingV2Fetch {
  const current = () => getAccountEpoch() === epoch && (useAuthStore.getState().user?.id ?? null) === account
  return async (input, init) => {
    if (!current()) throw new Error('Payment account changed. Reopen payment settings.')
    const response = await fetch(input, init)
    if (!current()) throw new Error('Payment account changed. Reopen payment settings.')
    if (response.status !== 401) return response
    // With no signed-in identity there is no account-bound request to replay.
    if (account === null) return response
    if (!refreshing || refreshing.account !== account || refreshing.epoch !== epoch) {
      const promise = Promise.resolve().then(() => useAuthStore.getState().refreshSession()).catch(() => false)
      const active = { account, epoch, promise }
      refreshing = active
      void promise.finally(() => { if (refreshing === active) refreshing = null })
    }
    const refreshed = await refreshing.promise
    if (!current()) {
      if (!useAuthStore.getState().isAuthenticated && getAccountEpoch() === epoch) throw new PaymentSessionRecoveryError(true)
      throw new Error('Payment account changed. Reopen payment settings.')
    }
    if (!refreshed) throw new PaymentSessionRecoveryError(!useAuthStore.getState().isAuthenticated)
    // A refresh boolean is not protected-session identity proof. Reuse the
    // same protected identity read as signup completion before replaying.
    const session = await fetch(new URL('/auth/session', input instanceof Request ? input.url : String(input)).toString(), { method: 'GET', credentials: 'include', cache: 'no-store' })
    if (!current()) throw new Error('Payment account changed. Reopen payment settings.')
    if (session.status === 401 || session.status === 403) throw new PaymentSessionRecoveryError(true)
    if (!session.ok) throw new PaymentSessionRecoveryError(false)
    const identity: unknown = await session.json()
    if (!current()) throw new Error('Payment account changed. Reopen payment settings.')
    const expected = useAuthStore.getState().user
    if (!identity || typeof identity !== 'object' || !('id' in identity) || identity.id !== account
      || !('email' in identity) || typeof identity.email !== 'string'
      || identity.email.trim().toLowerCase() !== expected?.email.trim().toLowerCase()) throw new PaymentSessionRecoveryError(true)
    const retried = await fetch(input, init)
    if (!current()) throw new Error('Payment account changed. Reopen payment settings.')
    if (retried.status === 401) throw new PaymentSessionRecoveryError(true)
    return retried
  }
}
