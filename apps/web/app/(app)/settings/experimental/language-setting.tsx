'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { buildLocaleCookie, resolveLocale, type AppLocale } from '@/i18n/locale'

export function LanguageSetting() {
  const t = useTranslations('SettingsExperimental.Language')
  const current = resolveLocale(useLocale())
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const choose = (next: AppLocale) => {
    if (next === current) return
    document.cookie = buildLocaleCookie(next, window.location.protocol === 'https:')
    // Re-render server components with the new messages; client stores, auth,
    // sync and drafts stay mounted.
    startTransition(() => router.refresh())
  }

  const options: { value: AppLocale; label: string; tag?: string }[] = [
    { value: 'en', label: 'English' },
    { value: 'it', label: 'Italiano', tag: t('partialTag') },
  ]

  return (
    <div className="space-y-3 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4">
      <p id="web-language-title" className="font-medium text-[rgb(var(--foreground))]">{t('title')}</p>
      <div
        role="radiogroup"
        aria-labelledby="web-language-title"
        aria-describedby="web-language-description"
        aria-busy={pending || undefined}
        className="space-y-2"
      >
        {options.map((option) => (
          <label key={option.value} className="flex min-h-11 items-center gap-3 text-sm text-[rgb(var(--foreground))]">
            <input
              type="radio"
              name="web-language"
              value={option.value}
              checked={current === option.value}
              disabled={pending}
              onChange={() => choose(option.value)}
              className="h-4 w-4 shrink-0 accent-emerald-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
            />
            <span>
              <span lang={option.value}>{option.label}</span>
              {option.tag && <> <span className="text-[rgb(var(--muted))]">{option.tag}</span></>}
            </span>
          </label>
        ))}
      </div>
      <p id="web-language-description" className="text-sm text-[rgb(var(--muted))]">{t('description')}</p>
    </div>
  )
}
