'use client'

import { useAuthStore } from '@/app/stores/use-auth-store'

/** Independent of transient request errors and guarded Back/navigation notices. */
export function SignupRecoveryWarning() {
  const durability = useAuthStore((state) => state.signupRecoveryDurability)
  if (durability !== 'memory-only') return null
  return <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-[rgb(var(--foreground))]">
    Stay in this tab. This browser could not retain your signup recovery details. Refreshing, closing, or leaving this tab can lose this continuation. Continue the existing setup here; do not start another signup or payment.
  </p>
}
