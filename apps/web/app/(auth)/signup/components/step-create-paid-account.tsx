'use client'

import { useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Check } from 'lucide-react'
import { Button, Input } from '@silentsuite/ui'

const paidAccountSchema = z
  .object({
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/[A-Z]/, 'Must contain an uppercase letter')
      .regex(/[a-z]/, 'Must contain a lowercase letter')
      .regex(/[0-9]/, 'Must contain a number'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })

export type PaidAccountFormData = z.infer<typeof paidAccountSchema>

function PasswordStrength({ password }: { password: string }) {
  const checks = [
    { label: 'At least 8 characters', met: password.length >= 8 },
    { label: 'Uppercase letter', met: /[A-Z]/.test(password) },
    { label: 'Lowercase letter', met: /[a-z]/.test(password) },
    { label: 'Number', met: /[0-9]/.test(password) },
  ]
  const metCount = checks.filter((c) => c.met).length

  if (!password) return null

  return (
    <div className="mt-2 space-y-2">
      <div className="flex gap-1">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i <= metCount
                ? metCount <= 2
                  ? 'bg-red-500'
                  : metCount === 3
                    ? 'bg-yellow-500'
                    : 'bg-[rgb(var(--primary))]'
                : 'bg-[rgb(var(--border))]'
            }`}
          />
        ))}
      </div>
      <ul className="space-y-1">
        {checks.map((check) => (
          <li
            key={check.label}
            className={`flex items-center gap-1.5 text-xs ${check.met ? 'text-[rgb(var(--primary))]' : 'text-[rgb(var(--muted))]'}`}
          >
            {check.met ? <Check className="h-3 w-3" /> : <div className="h-3 w-3 rounded-full border border-[rgb(var(--border))]" />}
            {check.label}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function StepCreatePaidAccount({
  email,
  onNext,
  initialError,
  continuation = 'payment-confirmed',
  initialData,
}: {
  email: string
  onNext: (data: PaidAccountFormData) => Promise<void>
  initialError?: string | null
  initialData?: PaidAccountFormData
  /** Verified signup chooses a password once; the parent retains it only in memory. */
  continuation?: 'payment-confirmed' | 'payment-return' | 'verified-no-card'
}) {
  const [submitError, setSubmitError] = useState<string | null>(initialError ?? null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const [showPassword, setShowPassword] = useState(false)
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isValid },
  } = useForm<PaidAccountFormData>({
    resolver: zodResolver(continuation === 'verified-no-card'
      ? z.object({ password: paidAccountSchema.shape.password })
      : paidAccountSchema) as any,
    defaultValues: initialData,
    mode: 'onChange',
  })
  const password = watch('password', '')

  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300 motion-reduce:animate-none">
      <div className="space-y-2 text-center">
        <h2 className="text-lg sm:text-xl font-semibold text-[rgb(var(--foreground))]">
          {continuation === 'verified-no-card' ? 'Choose your password' : 'Create your account'}
        </h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          {continuation === 'verified-no-card'
            ? <>Your email is verified. Choose a password, then select a trial or payment option for <span className="font-medium text-[rgb(var(--foreground))]">{email}</span>.</>
            : continuation === 'payment-return'
            ? <>Choose the password for <span className="font-medium text-[rgb(var(--foreground))]">{email}</span>. Billing must confirm the original payment before access is activated.</>
            : <>Payment is confirmed. Choose the password for <span className="font-medium text-[rgb(var(--foreground))]">{email}</span>.</>}
        </p>
      </div>

      <form onSubmit={handleSubmit(async (data) => {
        if (submittingRef.current) return
        submittingRef.current = true
        setSubmitError(null)
        setIsSubmitting(true)
        try {
          await onNext(continuation === 'verified-no-card' ? { ...data, confirmPassword: data.password } : data)
        } catch (err) {
          setSubmitError(err instanceof Error ? err.message : 'Could not create account. Please try again.')
        } finally {
          submittingRef.current = false
          setIsSubmitting(false)
        }
      })} className="space-y-4">
        <div className="space-y-2 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-3 text-sm">
          <p className="text-[rgb(var(--muted))]">Account email</p>
          <p className="font-medium text-[rgb(var(--foreground))]">{email}</p>
        </div>

        <div className="space-y-2">
          <label htmlFor="paid-signup-password" className="block text-sm font-medium text-[rgb(var(--foreground))]/80">
            Password
          </label>
          <Input
            id="paid-signup-password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            aria-invalid={!!errors.password}
            aria-describedby={errors.password ? 'paid-signup-password-error' : undefined}
            {...register('password')}
            className="bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] border-[rgb(var(--border))]"
          />
          {errors.password && <p id="paid-signup-password-error" role="alert" className="text-xs text-red-400">{errors.password.message}</p>}
          <PasswordStrength password={password} />
        </div>

        <button type="button" aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)} className="text-sm underline">{showPassword ? 'Hide password' : 'Show password'}</button>

        {continuation !== 'verified-no-card' && <div className="space-y-2">
          <label htmlFor="paid-signup-confirm-password" className="block text-sm font-medium text-[rgb(var(--foreground))]/80">
            Confirm password
          </label>
          <Input
            id="paid-signup-confirm-password"
            type="password"
            aria-invalid={!!errors.confirmPassword}
            aria-describedby={errors.confirmPassword ? 'paid-signup-confirm-password-error' : undefined}
            {...register('confirmPassword')}
            className="bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] border-[rgb(var(--border))]"
          />
          {errors.confirmPassword && <p id="paid-signup-confirm-password-error" role="alert" className="text-xs text-red-400">{errors.confirmPassword.message}</p>}
        </div>}

        {submitError && (
          <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
            <p className="text-sm text-red-400">{submitError}</p>
          </div>
        )}

        <Button type="submit" disabled={!isValid || isSubmitting} className="w-full">
          {isSubmitting ? 'Creating account...' : continuation === 'verified-no-card' ? 'Continue to trial options' : 'Create account and continue'}
        </Button>
      </form>
    </div>
  )
}
