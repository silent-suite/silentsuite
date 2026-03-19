'use client'

import { Lock } from 'lucide-react'
import { Button } from '@silentsuite/ui'
import Link from 'next/link'
import { useAuthStore } from '@/app/stores/use-auth-store'

export function ReadOnlyOverlay() {
  const subscriptionStatus = useAuthStore((s) => s.subscriptionStatus)

  const title =
    subscriptionStatus === 'trialing' || subscriptionStatus === 'none'
      ? 'Your trial has ended'
      : 'Your subscription has ended'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(var(--background))]/80 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-sm rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-6 text-center space-y-4">
        <div className="flex justify-center">
          <Lock className="h-10 w-10 text-[rgb(var(--foreground))]" />
        </div>
        <h2 className="text-lg font-semibold text-[rgb(var(--foreground))]">{title}</h2>
        <p className="text-sm text-[rgb(var(--muted))]">Your data is safe and encrypted.</p>
        <div className="flex flex-col gap-3 pt-2">
          <Link href="/settings/subscription">
            <Button size="sm" className="w-full">
              Choose a plan
            </Button>
          </Link>
          <Link
            href="/settings/export"
            className="text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--primary))] transition-colors"
          >
            Export my data
          </Link>
        </div>
      </div>
    </div>
  )
}
