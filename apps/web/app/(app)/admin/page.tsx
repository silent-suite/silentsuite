'use client'

import dynamic from 'next/dynamic'

// Lazy-load admin dashboard so admin code is NOT included in the main bundle.
// Server-side authorization is handled by middleware.ts (checks is_admin cookie).
// The AdminDashboard component retains its own client-side isAdmin check as a secondary guard.
const AdminDashboard = dynamic(() => import('./admin-dashboard'), {
  loading: () => (
    <div className="flex items-center justify-center py-20">
      <p className="text-sm text-[rgb(var(--muted))]">Loading admin dashboard...</p>
    </div>
  ),
})

export default function AdminPage() {
  return <AdminDashboard />
}
