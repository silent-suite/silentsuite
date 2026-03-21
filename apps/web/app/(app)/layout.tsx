'use client'

import { ProtectedRoute } from '@/app/components/protected-route'
import { Sidebar } from '@/app/components/sidebar'
import { Header } from '@/app/components/header'
import { BottomNav } from '@/app/components/bottom-nav'
import { ReadOnlyOverlay } from '@/app/components/read-only-overlay'
import { PendingSyncBanner } from '@/app/components/PendingSyncBanner'
import { SyncProvider } from '@/app/providers/sync-provider'
import { NotificationProvider } from '@/app/providers/notification-provider'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { isSelfHosted } from '@/app/lib/self-hosted'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const readOnly = useAuthStore((s) => {
    if (isSelfHosted) return false
    if (s.user?.isAdmin) return false
    const status = s.subscriptionStatus
    return status === 'cancelled' || status === 'expired' || status === 'none'
  })

  return (
    <ProtectedRoute>
      <SyncProvider>
        <NotificationProvider>
          <div className="flex h-screen bg-[rgb(var(--background))]">
            {/* Skip navigation link for keyboard/screen reader users */}
            <a
              href="#main-content"
              className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:rounded-lg focus:bg-[rgb(var(--primary))] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:shadow-lg"
            >
              Skip to content
            </a>
            <Sidebar />
            <div className="flex flex-1 flex-col min-w-0">
              <Header />
              <PendingSyncBanner />
              <main id="main-content" className="relative z-0 flex-1 overflow-auto p-3 pb-20 md:p-4 md:pb-4 page-transition">
                {children}
              </main>
            </div>
            <BottomNav />
            {!isSelfHosted && readOnly && <ReadOnlyOverlay />}
          </div>
        </NotificationProvider>
      </SyncProvider>
    </ProtectedRoute>
  )
}
