'use client'

import { useState, useEffect } from 'react'
import { Shield } from 'lucide-react'
import { useAuthStore } from '@/app/stores/use-auth-store'

function LoadingSpinner() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[rgb(var(--background))]">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[rgb(var(--primary))]/10 border border-[rgb(var(--primary))]/20">
        <Shield className="h-6 w-6 text-[rgb(var(--primary))]" />
      </div>
      <div className="flex flex-col items-center gap-2">
        <span className="text-sm font-semibold text-[rgb(var(--foreground))]">SilentSuite</span>
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-[rgb(var(--primary))]" />
          <span className="text-xs text-[rgb(var(--muted))]">Decrypting your workspace...</span>
        </div>
      </div>
    </div>
  )
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const restoreSession = useAuthStore((s) => s.restoreSession)
  const fetchSubscription = useAuthStore((s) => s.fetchSubscription)
  const [isInitialized, setIsInitialized] = useState(false)

  useEffect(() => {
    restoreSession()
      .then(() => fetchSubscription())
      .finally(() => setIsInitialized(true))
  }, [restoreSession, fetchSubscription])

  if (!isInitialized) {
    return <LoadingSpinner />
  }

  return <>{children}</>
}
