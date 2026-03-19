'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@silentsuite/ui'
import { Input } from '@silentsuite/ui'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { isSelfHosted } from '@/app/lib/self-hosted'

// ---------------------------------------------------------------------------
// Validation (same rules as signup)
// ---------------------------------------------------------------------------

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/[A-Z]/, 'Must contain an uppercase letter')
      .regex(/[a-z]/, 'Must contain a lowercase letter')
      .regex(/[0-9]/, 'Must contain a number'),
    confirmNewPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: 'Passwords do not match',
    path: ['confirmNewPassword'],
  })

type PasswordFormData = z.infer<typeof passwordSchema>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BILLING_API_URL =
  process.env.NEXT_PUBLIC_BILLING_API_URL ?? 'http://localhost:3736'

// ---------------------------------------------------------------------------
// Change Password Section
// ---------------------------------------------------------------------------

function ChangePasswordSection() {
  const [success, setSuccess] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<PasswordFormData>({
    resolver: zodResolver(passwordSchema),
    mode: 'onBlur',
  })

  const onSubmit = async (_data: PasswordFormData) => {
    setSuccess(false)
    setApiError(null)

    try {
      // TODO: Call Etebase.Account.changePassword() client-side once SDK is integrated
      // For now this is mocked — the actual password change happens in Etebase

      // Notify billing API to invalidate other sessions
      if (!isSelfHosted) {
        const res = await fetch(`${BILLING_API_URL}/account/password`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
          credentials: 'include',
        })

        if (!res.ok) {
          const body = await res.json().catch(() => null)
          throw new Error(body?.detail ?? 'Failed to update password')
        }
      }

      setSuccess(true)
      reset()
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Something went wrong')
    }
  }

  return (
    <section className="rounded-lg border border-[rgb(var(--border))] p-4 space-y-4">
      <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">Change Password</h2>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
        <div className="space-y-1">
          <label htmlFor="currentPassword" className="block text-xs text-[rgb(var(--muted))]">
            Current password
          </label>
          <Input id="currentPassword" type="password" {...register('currentPassword')} />
          {errors.currentPassword && (
            <p className="text-xs text-red-400">{errors.currentPassword.message}</p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="newPassword" className="block text-xs text-[rgb(var(--muted))]">
            New password
          </label>
          <Input id="newPassword" type="password" {...register('newPassword')} />
          {errors.newPassword && (
            <p className="text-xs text-red-400">{errors.newPassword.message}</p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="confirmNewPassword" className="block text-xs text-[rgb(var(--muted))]">
            Confirm new password
          </label>
          <Input id="confirmNewPassword" type="password" {...register('confirmNewPassword')} />
          {errors.confirmNewPassword && (
            <p className="text-xs text-red-400">{errors.confirmNewPassword.message}</p>
          )}
        </div>

        {apiError && <p className="text-xs text-red-400">{apiError}</p>}
        {success && <p className="text-xs text-[rgb(var(--primary))]">Password updated successfully. Other sessions have been signed out.</p>}

        <Button type="submit" disabled={isSubmitting} size="sm">
          {isSubmitting ? 'Updating...' : 'Update password'}
        </Button>
      </form>
    </section>
  )
}

// TODO: Implement actual account recovery mechanism

// ---------------------------------------------------------------------------
// Delete Account Section
// ---------------------------------------------------------------------------

function DeleteAccountSection() {
  const router = useRouter()
  const { logout } = useAuthStore()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleDelete = async () => {
    setDeleting(true)
    setError(null)

    try {
      if (isSelfHosted) {
        await logout()
        router.push('/')
        return
      }

      const res = await fetch(`${BILLING_API_URL}/account`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: confirmText }),
        credentials: 'include',
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.detail ?? 'Failed to delete account')
      }

      // Clear local auth state
      await logout()
      router.push('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setDeleting(false)
    }
  }

  return (
    <>
      <section className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-red-400">Danger Zone</h2>
        <p className="text-xs text-[rgb(var(--muted))]">
          This action is permanent. All your data will be deleted and cannot be recovered.
        </p>
        <Button variant="destructive" size="sm" onClick={() => setDialogOpen(true)}>
          Delete my account
        </Button>
      </section>

      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-sm rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] p-6 shadow-xl space-y-4">
            <h3 className="text-sm font-semibold text-[rgb(var(--foreground))]">Confirm Account Deletion</h3>
            <p className="text-xs text-[rgb(var(--muted))]">
              Type <span className="font-mono font-semibold text-red-400">DELETE</span> to confirm.
            </p>

            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="Type DELETE"
              autoFocus
            />

            {error && <p className="text-xs text-red-400">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDialogOpen(false)
                  setConfirmText('')
                  setError(null)
                }}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={confirmText !== 'DELETE' || deleting}
                onClick={handleDelete}
              >
                {deleting ? 'Deleting...' : 'Confirm Delete'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Security Page
// ---------------------------------------------------------------------------

export default function SecurityPage() {
  return (
    <div className="space-y-6">
      <ChangePasswordSection />
      <DeleteAccountSection />
    </div>
  )
}
