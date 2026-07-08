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
import { useAuthStore } from '@/app/stores/use-auth-store'
import { normalizeServerUrl } from '@/app/stores/use-etebase-store'

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
})

type LoginFormData = z.infer<typeof loginSchema>

export default function LoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { login, isLoading, error, clearError, isAuthenticated } = useAuthStore()
  const [serverUrl, setServerUrl] = useState('')
  const [rememberDevice, setRememberDevice] = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema) as any,
    mode: 'onBlur',
  })

  useEffect(() => {
    if (isAuthenticated) {
      const raw = searchParams.get('returnTo') ?? '/calendar'
      // Validate returnTo to prevent open redirect: must be a relative path
      const returnTo = raw.startsWith('/') && !raw.includes('://') && !raw.includes('//') ? raw : '/calendar'
      router.replace(returnTo)
    }
  }, [isAuthenticated, router, searchParams])

  useEffect(() => {
    return () => clearError()
  }, [clearError])

  const onSubmit = async (data: LoginFormData) => {
    const useHostedBilling = !serverUrl.trim()
    const normalizedUrl = useHostedBilling ? undefined : normalizeServerUrl(serverUrl)
    if (normalizedUrl) {
      localStorage.setItem('silentsuite-server-url', normalizedUrl)
    } else {
      localStorage.removeItem('silentsuite-server-url')
    }
    await login(data.email, data.password, normalizedUrl, useHostedBilling && rememberDevice)
  }

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">Welcome back</h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          Log in to your encrypted workspace
        </p>
      </div>

      <form className="space-y-4" onSubmit={handleSubmit(onSubmit)}>
        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
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
              className="mt-0.5 h-4 w-4 rounded border-[rgb(var(--border))] bg-[rgb(var(--surface))] text-[rgb(var(--primary))] focus:ring-[rgb(var(--primary))] focus:ring-offset-0"
            />
            <span>
              <span className="block font-medium">Keep me signed in on this device</span>
              <span className="block text-xs text-[rgb(var(--muted))]">
                Leave unchecked to let your browser forget this session when all windows are closed.
              </span>
            </span>
          </label>
        )}

        <Button type="submit" disabled={isLoading} className="w-full">
          {isLoading ? 'Logging in...' : 'Log in'}
        </Button>

        {/* Advanced Settings */}
        <details className="group">
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
        </details>
      </form>

      <p className="text-center text-sm text-[rgb(var(--muted))]">
        Don&apos;t have an account?{' '}
        <Link href="/signup" className="text-emerald-500 hover:underline">
          Sign up
        </Link>
      </p>
    </div>
  )
}
