'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ChevronRight } from 'lucide-react'
import { Button } from '@silentsuite/ui'
import { Input } from '@silentsuite/ui'
import { AUTH_REFRESH_RETRY_MESSAGE, useAuthStore } from '@/app/stores/use-auth-store'
import { normalizeServerUrl } from '@/app/lib/server-url'
import { safeReturnTo } from '@/app/lib/login-return'
import { androidBoundAccount, isAndroidBundle, isLoginAllowedForAndroidAccount } from '@/app/lib/android-bundle'

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
})

type LoginFormData = z.infer<typeof loginSchema>

export default function LoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { login, unlockEtebaseSession, restoreSession, fetchSubscription, isLoading, error, clearError, isAuthenticated } = useAuthStore()
  const [serverUrl, setServerUrl] = useState('')
  const [isRetryingRestore, setIsRetryingRestore] = useState(false)
  const [rememberDevice, setRememberDevice] = useState(false)
  const isUnlock = searchParams.get('reason') === 'unlock'
  const isBillingReauth = searchParams.get('reason') === 'billing'

  const {
    register,
    handleSubmit,
    setError,
    setValue,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema) as any,
    mode: 'onBlur',
  })

  useEffect(() => {
    if (!isAuthenticated) return
    // On the unlock route, stay put until the user re-enters credentials --
    // an already-authenticated-but-restore-blocked user must not be bounced
    // straight back into the broken empty state (redirect loop).
    if (isUnlock || isBillingReauth) return
    const returnTo = safeReturnTo(searchParams.get('returnTo'))
    router.replace(returnTo)
  }, [isAuthenticated, isUnlock, isBillingReauth, router, searchParams])

  useEffect(() => {
    return () => clearError()
  }, [clearError])

  // Inside the Android app this view belongs to one Android account.
  const [androidAccount, setAndroidAccount] = useState<string | null>(null)
  useEffect(() => {
    const bound = androidBoundAccount()
    setAndroidAccount(bound)
    if (bound) setValue('email', bound)
  }, [setValue])

  // The automatic restore gave up on a transient refresh problem: offer the
  // same restore again, as the app runs it at startup. The form stays usable.
  const showRestoreRetry = !isAuthenticated && (isRetryingRestore || error === AUTH_REFRESH_RETRY_MESSAGE)
  const retryRestore = async () => {
    if (isRetryingRestore) return
    setIsRetryingRestore(true)
    try {
      await restoreSession()
      await fetchSubscription()
    } finally {
      setIsRetryingRestore(false)
    }
  }

  const onSubmit = async (data: LoginFormData) => {
    if (!isLoginAllowedForAndroidAccount(data.email, androidAccount)) {
      setError('email', {
        message: androidAccount
          ? `Sign in as ${androidAccount}, the account selected in the app.`
          : 'Open this screen from the SilentSuite app.',
      })
      return
    }
    const useHostedBilling = !serverUrl.trim()
    const normalizedUrl = useHostedBilling ? undefined : normalizeServerUrl(serverUrl)
    // The store saves this server selection only after the credentials are
    // verified, so a failed attempt keeps the previous setting.
    if (isUnlock && isAuthenticated) {
      await unlockEtebaseSession(data.email, data.password, normalizedUrl)
    } else {
      await login(data.email, data.password, normalizedUrl, useHostedBilling && rememberDevice)
    }
    // Read the store directly to avoid a stale closure over `error`.
    if ((isUnlock || (isBillingReauth && useAuthStore.getState().isAuthenticated)) && !useAuthStore.getState().error) {
      const returnTo = safeReturnTo(searchParams.get('returnTo'))
      router.replace(returnTo)
    }
  }

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">
          {isUnlock ? 'Unlock this browser' : 'Welcome back'}
        </h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          {isUnlock
            ? 'Your encrypted data is safe. Sign in again to unlock it on this browser.'
            : 'Log in to your encrypted workspace'}
        </p>
      </div>

      <form className="space-y-4" onSubmit={handleSubmit(onSubmit)}>
        {error && (
          <div role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {showRestoreRetry && (
          <Button
            type="button"
            variant="outline"
            onClick={() => { void retryRestore() }}
            disabled={isRetryingRestore || isLoading}
            className="w-full"
          >
            {isRetryingRestore ? 'Retrying...' : 'Retry'}
          </Button>
        )}

        <div className="space-y-2">
          <label
            htmlFor="email"
            className="block text-sm font-medium text-[rgb(var(--foreground))]/80"
          >
            Email address
          </label>
          <Input
            id="email"
            type="email"
            autoFocus
            readOnly={isAndroidBundle && androidAccount !== null}
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? 'email-error' : undefined}
            {...register('email')}
            className="bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] border-[rgb(var(--border))]"
          />
          {errors.email && (
            <p id="email-error" role="alert" className="text-xs text-red-400">{errors.email.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <label
            htmlFor="password"
            className="block text-sm font-medium text-[rgb(var(--foreground))]/80"
          >
            Password
          </label>
          <Input
            id="password"
            type="password"
            aria-invalid={!!errors.password}
            aria-describedby={errors.password ? 'password-error' : undefined}
            {...register('password')}
            className="bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] border-[rgb(var(--border))]"
          />
          {errors.password && (
            <p id="password-error" role="alert" className="text-xs text-red-400">{errors.password.message}</p>
          )}
        </div>

        {!serverUrl.trim() && (
          <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))]/40 p-3 text-sm text-[rgb(var(--foreground))]/80">
            <input
              type="checkbox"
              checked={rememberDevice}
              onChange={(e) => setRememberDevice(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-[rgb(var(--border))] bg-[rgb(var(--surface))] text-[rgb(var(--primary-text))] focus:ring-[rgb(var(--focus-ring))] focus:ring-offset-0"
            />
            <span className="text-sm font-medium text-[rgb(var(--foreground))]/80">Keep me signed in on this device</span>
          </label>
        )}

        <Button type="submit" disabled={isLoading} className="w-full">
          {isLoading ? 'Logging in...' : 'Log in'}
        </Button>

        {/* Advanced Settings */}
        {!isAndroidBundle && <details className="group">
          <summary className="flex cursor-pointer items-center gap-2 text-xs text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors">
            <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
            Advanced Settings
          </summary>
          <div className="mt-3 space-y-2">
            <label className="block text-xs text-[rgb(var(--muted))]">
              Server URL
            </label>
            <Input
              type="url"
              placeholder="https://sync.example.com"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              className="bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] border-[rgb(var(--border))] text-xs"
            />
            <p className="text-[10px] text-[rgb(var(--muted))]">
              Leave empty to use the default silentsuite.io server. Self-hosters: enter your own server URL.
            </p>
          </div>
        </details>}
      </form>

      {!isAndroidBundle && <p className="text-center text-sm text-[rgb(var(--muted))]">
        Don&apos;t have an account?{' '}
        <Link href="/signup" className="text-emerald-500 hover:underline">
          Sign up
        </Link>
      </p>}
    </div>
  )
}
