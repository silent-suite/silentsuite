'use client'

import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { androidBoundAccount, isAndroidBundle, isLoginAllowedForAndroidAccount } from '@/app/lib/android-bundle'

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuthStore()
  const email = useAuthStore((s) => s.user?.email)
  const logout = useAuthStore((s) => s.logout)
  // Inside the Android app a session is shown only for the account the view was
  // opened for, however it was restored.
  const wrongAndroidAccount = isAndroidBundle && isAuthenticated && !isLoginAllowedForAndroidAccount(email ?? '', androidBoundAccount())

  useEffect(() => {
    if (wrongAndroidAccount) void logout()
  }, [wrongAndroidAccount, logout])
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace(`/login?returnTo=${encodeURIComponent(pathname)}`)
    }
  }, [isAuthenticated, isLoading, router, pathname])

  if (!isAuthenticated || wrongAndroidAccount) return null
  return <>{children}</>
}
