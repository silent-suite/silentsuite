'use client'

import { useState } from 'react'
import { Crown, ShieldCheck } from 'lucide-react'
import { Button } from '@silentsuite/ui'
import { useAuthStore } from '@/app/stores/use-auth-store'

export default function PlanSelectionPage() {
  const signup = useAuthStore((s: any) => s.signup)
  const pendingSignup = useAuthStore((s: any) => s.pendingSignup)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSelect = async (planId: string) => {
    if (!pendingSignup) {
      setError('Signup session expired. Please start again.')
      return
    }

    setLoading(planId)
    setError(null)

    try {
      const checkoutUrl = await signup(planId)

      if (checkoutUrl) {
        window.location.href = checkoutUrl
      } else {
        window.location.href = '/signup/success'
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Something went wrong'
      setError(message)
      setLoading(null)
    }
  }

  return (
    <div className="space-y-8">
      <div className="space-y-3 text-center">
        <h2 className="text-2xl font-bold text-[rgb(var(--foreground))]">Choose your plan</h2>
        <p className="text-base text-[rgb(var(--muted))]">
          Start with a 30-day free trial
        </p>
      </div>

      <div className="max-w-sm mx-auto">
        {/* Founding Member */}
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-5 ring-1 ring-amber-500/20 flex flex-col relative overflow-hidden">
          <div className="absolute top-3 right-3">
            <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-[11px] font-medium text-amber-400">
              Early supporter
            </span>
          </div>
          <div className="flex items-center gap-3 mb-3">
            <div className="rounded-lg bg-amber-500/10 p-2.5">
              <Crown className="h-5 w-5 text-amber-400" />
            </div>
            <h3 className="text-lg font-semibold text-[rgb(var(--foreground))]">Founding Member</h3>
          </div>
          <p className="text-sm leading-relaxed text-[rgb(var(--muted))]">
            30 days free, then &euro;3/mo. Price locked forever as a thank you for your early support.
          </p>
          <div className="mt-5 pt-4 border-t border-amber-500/10">
            <div className="mb-4 flex items-baseline gap-1.5">
              <span className="text-3xl font-bold text-[rgb(var(--foreground))]">&euro;3</span>
              <span className="text-sm text-[rgb(var(--muted))]">/month after trial</span>
            </div>
            <Button
              onClick={() => handleSelect('founding_member')}
              disabled={loading !== null}
              className="w-full py-2.5 text-sm bg-amber-600 hover:bg-amber-700"
            >
              {loading === 'founding_member' ? 'Setting up...' : 'Become a founding member'}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center gap-1.5 text-xs text-[rgb(var(--muted))]">
        <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
        <span>30-day money-back guarantee. Cancel anytime.</span>
      </div>

      {error && (
        <p className="text-center text-sm text-red-400">{error}</p>
      )}
    </div>
  )
}
