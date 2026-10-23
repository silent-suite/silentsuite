'use client'

import dynamic from 'next/dynamic'
import { ProtectedRoute } from '@/app/components/protected-route'

const AuthenticatedShell = dynamic(() => import('./authenticated-shell'), { ssr: false })

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <ProtectedRoute>
      <AuthenticatedShell>{children}</AuthenticatedShell>
    </ProtectedRoute>
  )
}
