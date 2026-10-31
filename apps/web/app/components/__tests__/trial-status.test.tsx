import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../sidebar'
import { SettingsNav } from '@/app/(app)/settings/settings-nav'
import SubscriptionPage from '@/app/(app)/settings/subscription/page'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'

const state = vi.hoisted(() => ({ expanded: true, selfHosted: false }))

vi.mock('next/dynamic', () => ({ default: () => function MockStripePaymentForm() { return null } }))
vi.mock('@/app/lib/date', () => ({ formatDate: (date: Date) => date.toISOString().slice(0, 10) }))

vi.mock('@/app/stores/use-etebase-store', () => {
  const useEtebaseStore = (selector: (value: { accountFingerprint: string }) => unknown) => selector({ accountFingerprint: 'trial-account' })
  return { useEtebaseStore, EtebaseTeardownError: class extends Error {} }
})
vi.mock('next/navigation', () => ({ usePathname: () => '/calendar' }))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/app/stores/use-sidebar-store', () => ({
  useSidebarStore: () => ({ isExpanded: state.expanded, toggle: vi.fn() }),
  initializeSidebar: vi.fn(),
}))
vi.mock('@/app/lib/self-hosted', () => ({
  get isSelfHosted() { return state.selfHosted },
  isCustomServer: (serverUrl?: string) => Boolean(serverUrl && serverUrl !== 'https://server.silentsuite.io'),
}))
vi.mock('@/app/lib/config', () => ({ BILLING_API_URL: 'https://billing.test', ETEBASE_SERVER_URL: 'https://server.example.test' }))
vi.mock('@/app/stores/use-preferences-sync-store', () => ({
  usePreferencesSyncStore: (selector: (value: { status: string }) => unknown) => selector({ status: 'loading' }),
}))
vi.mock('@/app/(app)/calendar/components/MiniCalendar', () => ({ MiniCalendar: () => null }))
vi.mock('@/app/components/CalendarListPanel', () => ({ CalendarListPanel: () => null }))
vi.mock('@/app/components/TaskListPanel', () => ({ TaskListPanel: () => null }))
vi.mock('@/app/components/ContactListPanel', () => ({ ContactListPanel: () => null }))
vi.mock('@/app/components/NotebookListPanel', () => ({ NotebookListPanel: () => null }))
vi.mock('@/app/components/OnboardingChecklist', () => ({ OnboardingChecklist: () => null }))

const NOW = new Date('2026-10-30T12:00:00.000Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const userU = { id: 'trial-u', email: 'u@example.com', planId: 'early_annual', isAdmin: false }
const userV = { id: 'trial-v', email: 'v@example.com', planId: 'early_annual', isAdmin: false }

function daysLeftNotice(endsInMs: number) {
  const trialEndsAt = new Date(NOW.getTime() + endsInMs).toISOString()
  return { kind: 'trial_days_left', trialEndsAt, daysRemaining: Math.ceil(endsInMs / DAY) }
}

function seed(notice: unknown, user: Record<string, unknown> = userU, checkedAt: number | null = NOW.getTime()) {
  useAuthStore.setState({ user, isAuthenticated: true, subscriptionStatus: 'trialing', hostedAccess: 'entitled', accountNotice: notice, accountNoticeCheckedAt: checkedAt } as unknown as Partial<ReturnType<typeof useAuthStore.getState>>)
}

function renderAll() {
  return render(
    <>
      <Sidebar />
      <SettingsNav variant="overview" pathname="/settings" />
      <SettingsNav variant="rail" pathname="/settings/account" />
    </>,
  )
}

const countdownText = /\d+\s+days?\s+left/i
const subscriptionReads = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === 'https://billing.test/subscription').length
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

describe('seven-day trial status near Settings', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(NOW)
    state.expanded = true
    state.selfHosted = false
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: 'trialing', accountNotice: null }) })))
    useAuthStore.setState({ user: null, isAuthenticated: false, subscriptionStatus: null, hostedAccess: null, trialExpiryRefreshClaim: null } as unknown as Partial<ReturnType<typeof useAuthStore.getState>>)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('[RED] shows an accessible, separate days-left link in the expanded sidebar and both Settings nav variants', () => {
    seed(daysLeftNotice(2 * DAY + HOUR))
    renderAll()

    const sidebar = screen.getByRole('navigation', { name: 'mainNavigation' })
    const link = within(sidebar).getByRole('link', { name: 'Free trial, 3 days left. Subscription details' })
    expect(link).toHaveAttribute('href', '/settings/subscription')
    expect(link).toHaveTextContent('Free trial · 3 days left')
    expect(link).toHaveClass('min-h-11')
    expect(within(sidebar).getByRole('link', { name: 'settings' })).not.toContainElement(link)

    const [overview, rail] = screen.getAllByRole('navigation', { name: 'Settings' })
    const overviewRow = within(overview).getByRole('link', { name: /^Subscription/ })
    expect(overviewRow).toHaveTextContent('Free trial · 3 days left')
    expect(overviewRow).not.toHaveTextContent('Plan & billing')
    expect(within(rail).getByRole('link', { name: 'Subscription · 3 days left' })).toHaveAttribute('href', '/settings/subscription')

    expect(document.querySelectorAll('a a, a button, button a, button button')).toHaveLength(0)
  })

  it('[RED] keeps an icon link with an accessible name in the collapsed sidebar', () => {
    state.expanded = false
    seed(daysLeftNotice(DAY - HOUR))
    render(<Sidebar />)
    const link = screen.getByRole('link', { name: 'Free trial, 1 day left. Subscription details' })
    expect(link).toHaveAttribute('href', '/settings/subscription')
    expect(link).toHaveClass('min-h-11')
  })

  it.each([
    ['no notice', () => seed(null)],
    ['an ended trial', () => seed({ kind: 'trial_ended', endedAt: NOW.toISOString() })],
    ['ended access', () => seed({ kind: 'access_ended', endedAt: null })],
    ['an admin', () => seed(daysLeftNotice(3 * DAY), { ...userU, isAdmin: true })],
    ['a self-hosted build', () => { state.selfHosted = true; seed(daysLeftNotice(3 * DAY)) }],
    ['a custom server', async () => {
      localStorage.setItem('silentsuite-server-url', 'https://dav.example.test')
      seed(daysLeftNotice(3 * DAY))
      await useAuthStore.getState().fetchSubscription()
    }],
  ])('[CTRL] shows no countdown for %s', async (_label, arrange) => {
    await arrange()
    renderAll()
    expect(document.body).not.toHaveTextContent(countdownText)
    expect(screen.queryByRole('link', { name: /free trial/i })).not.toBeInTheDocument()
  })

  it('[RED] drops the countdown as soon as the account changes', () => {
    seed(daysLeftNotice(3 * DAY))
    renderAll()
    expect(screen.getByRole('link', { name: /free trial, 3 days left/i })).toBeInTheDocument()
    act(() => { useAuthStore.getState().setUser(userV) })
    expect(document.body).not.toHaveTextContent(countdownText)
  })

  it('[RED] advances at the day boundary without a network read', async () => {
    seed(daysLeftNotice(2 * DAY + HOUR))
    renderAll()
    expect(screen.getByRole('link', { name: /free trial, 3 days left/i })).toBeInTheDocument()
    await act(async () => { vi.advanceTimersByTime(HOUR + 1000) })
    expect(screen.getByRole('link', { name: /free trial, 2 days left/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Subscription · 2 days left' })).toBeInTheDocument()
    expect(subscriptionReads()).toBe(0)
  })

  it('[RED] at the end instant hides every countdown and starts exactly one shared refresh; a replacement account gets its own', async () => {
    const notice = daysLeftNotice(2 * HOUR)
    vi.mocked(fetch).mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ status: 'trialing', hostedAccess: 'trial_ended', accountNotice: { kind: 'trial_ended', endedAt: notice.trialEndsAt } }) }) as Response)
    seed(notice)
    renderAll()
    expect(screen.getAllByText(countdownText).length).toBeGreaterThanOrEqual(3)

    await act(async () => { vi.advanceTimersByTime(2 * HOUR + 1000) })
    await flush()
    expect(document.body).not.toHaveTextContent(countdownText)
    expect(subscriptionReads()).toBe(1)
    await act(async () => { vi.advanceTimersByTime(DAY) })
    expect(subscriptionReads()).toBe(1)

    // Same trial end, different account generation: the old claim is not inherited.
    act(() => {
      bumpAccountEpoch()
      useAuthStore.getState().setUser(userV)
      seed(notice, userV)
    })
    await flush()
    expect(document.body).not.toHaveTextContent(countdownText)
    expect(subscriptionReads()).toBe(2)
  })

  describe('with the subscription page mounted', () => {
    const capabilities = {
      trialActive: false, trialExpired: false, needsPaymentMethod: false, canSetupCard: false,
      canStartPaidSubscription: false, canReactivate: false, canRetryPayment: false, canResumeCancellation: false,
    }
    const trialEndsAt = new Date(NOW.getTime() + 2 * HOUR).toISOString()
    const running = {
      plan: null, planLabel: 'Free trial', billingInterval: 'annual', status: 'trialing', renewalDate: null,
      trial: { active: true, endsAt: trialEndsAt, daysRemaining: 1 }, cancelAtPeriodEnd: false, trialPath: '7day', earlyAdopter: true,
      capabilities: { ...capabilities, trialActive: true, needsPaymentMethod: true, canSetupCard: true },
      hostedAccess: 'entitled',
      accountNotice: { kind: 'trial_days_left', trialEndsAt, daysRemaining: 1 },
      billingDate: { kind: 'trial_ends', at: trialEndsAt },
    }
    const ended = {
      ...running,
      trial: { active: false, endsAt: trialEndsAt, daysRemaining: null },
      capabilities: { ...capabilities, trialExpired: true, canStartPaidSubscription: true },
      hostedAccess: 'trial_ended',
      accountNotice: { kind: 'trial_ended', endedAt: trialEndsAt },
      billingDate: { kind: 'ended', at: trialEndsAt },
    }
    const offerBody = (planId: 'early_annual' | 'standard_annual') => ({
      contractVersion: 2, requestId: 'e91a6d70-0d4e-4352-9bdc-426d1f76d771',
      offer: planId === 'early_annual'
        ? { planId, customerClass: 'early', billingInterval: 'annual', annualAmountMinor: 3600, monthlyEquivalentMinor: 300, currency: 'EUR', providers: ['stripe', 'btcpay'], offerRevision: 1, offerToken: 'signed-offer', expiresAt: '2026-08-10T12:10:00Z' }
        : { planId, customerClass: 'standard', billingInterval: 'annual', annualAmountMinor: 4800, monthlyEquivalentMinor: 400, currency: 'EUR', providers: ['stripe'], offerRevision: 1, offerToken: 'signed-offer', expiresAt: '2026-08-10T12:10:00Z' },
    })
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

    /** Billing GET /subscription answers in order; offer reads use `offers`. */
    function routeBilling(
      subscriptions: Array<() => unknown>,
      offers: Array<() => unknown> = [() => json(offerBody('early_annual'))],
      refresh: () => unknown = () => ({ ok: false, status: 404, json: async () => ({}) }),
    ) {
      let subscriptionIndex = 0
      let offerIndex = 0
      vi.mocked(fetch).mockImplementation((async (url: string) => {
        if (url === 'https://billing.test/subscription') return subscriptions[Math.min(subscriptionIndex++, subscriptions.length - 1)]()
        if (url === 'https://billing.test/subscription/offers/v2?preview=1') return offers[Math.min(offerIndex++, offers.length - 1)]()
        if (url === 'https://billing.test/auth/refresh') return refresh()
        return { ok: false, status: 404, json: async () => ({}) }
      }) as unknown as typeof fetch)
      return { offerReads: () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === 'https://billing.test/subscription/offers/v2?preview=1').length }
    }

    function renderWithPage() {
      return render(
        <>
          <Sidebar />
          <SettingsNav variant="overview" pathname="/settings" />
          <SettingsNav variant="rail" pathname="/settings/subscription" />
          <SubscriptionPage />
        </>,
      )
    }

    function card() {
      return screen.getByRole('heading', { name: 'Subscription' }).closest('section') as HTMLElement
    }

    it('updates every consumer, including the page card, from the one shared expiry read', async () => {
      routeBilling([() => json(running), () => json(ended)])
      seed(running.accountNotice)
      renderWithPage()
      await flush()
      expect(within(card()).getByText('Free trial: 1 day left')).toBeInTheDocument()
      expect(within(card()).getByRole('button', { name: /choose payment/i })).toBeInTheDocument()
      expect(subscriptionReads()).toBe(1)

      await act(async () => { vi.advanceTimersByTime(2 * HOUR + 1000) })
      await flush()
      await flush()

      expect(subscriptionReads()).toBe(2)
      expect(document.body).not.toHaveTextContent(countdownText)
      const section = card()
      expect(within(section).getByText('Your trial has ended.')).toBeInTheDocument()
      expect(within(section).getByText('Ended on')).toBeInTheDocument()
      expect(within(section).getByRole('button', { name: 'Subscribe' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /choose payment/i })).not.toBeInTheDocument()
      expect(useAuthStore.getState().hostedAccess).toBe('trial_ended')

      await act(async () => { vi.advanceTimersByTime(DAY) })
      await flush()
      expect(subscriptionReads()).toBe(2)
    })

    it('ignores a shared expiry read that completes after the account was replaced', async () => {
      let release!: (value: unknown) => void
      const late = new Promise(resolve => { release = resolve })
      routeBilling([() => json(running), () => late])
      seed(running.accountNotice)
      renderWithPage()
      await flush()

      await act(async () => { vi.advanceTimersByTime(2 * HOUR + 1000) })
      await flush()
      await flush()
      expect(subscriptionReads()).toBe(2)

      act(() => {
        bumpAccountEpoch()
        useAuthStore.getState().setUser(userV)
      })
      release(json(ended))
      await flush()
      await flush()

      expect(screen.queryByText('Your trial has ended.')).not.toBeInTheDocument()
      expect(useAuthStore.getState().hostedAccess).toBeNull()
      expect((useAuthStore.getState() as unknown as { accountNotice?: unknown }).accountNotice).toBeNull()
    })

    const endedCard = () => {
      const section = card()
      expect(within(section).getByText('Your trial has ended.')).toBeInTheDocument()
      expect(within(section).getByRole('button', { name: 'Subscribe' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /choose payment/i })).not.toBeInTheDocument()
      expect(document.body).not.toHaveTextContent(countdownText)
    }
    const pastEnd = () => act(async () => { vi.advanceTimersByTime(2 * HOUR + 1000) })

    it('adopts a shared expiry result that completed before an older page read arrived', async () => {
      let releasePage!: (value: unknown) => void
      const pageRead = new Promise(resolve => { releasePage = resolve })
      routeBilling([() => pageRead, () => json(ended)])
      seed(running.accountNotice)
      renderWithPage()
      await flush()
      await pastEnd()
      await flush()
      await flush()
      expect(subscriptionReads()).toBe(2)

      releasePage(json(running))
      await flush()
      await flush()
      endedCard()
      expect(subscriptionReads()).toBe(2)
    })

    it('adopts a shared expiry result for a page mounted after it completed', async () => {
      routeBilling([() => json(ended), () => json(running)])
      seed(running.accountNotice)
      const view = render(<Sidebar />)
      await pastEnd()
      await flush()
      await flush()
      expect(subscriptionReads()).toBe(1)

      view.rerender(<><Sidebar /><SubscriptionPage /></>)
      await flush()
      await flush()
      endedCard()
      expect(subscriptionReads()).toBe(2)
    })

    it('continues the expiry read once when the same account gets a fresh user object mid-read', async () => {
      let releaseClaim!: (value: unknown) => void
      const claimRead = new Promise(resolve => { releaseClaim = resolve })
      routeBilling([() => json(running), () => claimRead, () => json(ended)])
      seed(running.accountNotice)
      renderWithPage()
      await flush()
      await pastEnd()
      await flush()
      expect(subscriptionReads()).toBe(2)

      act(() => { useAuthStore.getState().setUser({ ...userU }) })
      releaseClaim(json(ended))
      await flush()
      await flush()
      await flush()
      expect(subscriptionReads()).toBe(3)
      expect(useAuthStore.getState().hostedAccess).toBe('trial_ended')
      endedCard()

      await act(async () => { vi.advanceTimersByTime(DAY) })
      await flush()
      expect(subscriptionReads()).toBe(3)
    })

    it('updates the page from a billing retry whose newer read supersedes the pending expiry read', async () => {
      let releaseClaim!: (value: unknown) => void
      const claimRead = new Promise(resolve => { releaseClaim = resolve })
      routeBilling(
        [() => json(running), () => claimRead, () => json(ended)],
        undefined,
        () => json({ id: userU.id, email: userU.email, planId: userU.planId, isAdmin: false, rememberDevice: true }),
      )
      seed(running.accountNotice)
      renderWithPage()
      await flush()
      await pastEnd()
      await flush()
      expect(subscriptionReads()).toBe(2)

      let retried: boolean | undefined
      await act(async () => { retried = await useAuthStore.getState().retryBillingConnection() })
      expect(retried).toBe(true)
      expect(subscriptionReads()).toBe(3)
      releaseClaim(json(running))
      await flush()
      await flush()

      endedCard()
      expect(within(card()).getByText('Ended on')).toBeInTheDocument()
      expect(subscriptionReads()).toBe(3)
      await act(async () => { vi.advanceTimersByTime(DAY) })
      await flush()
      expect(subscriptionReads()).toBe(3)
    })

    // The retained page's notice and expiry dispatch belong to the account it was opened for.
    it('drops a retained page notice and makes no expiry read when another account replaces the owner', async () => {
      routeBilling([() => json(running)])
      seed(running.accountNotice)
      render(<SubscriptionPage />)
      await flush()
      expect(within(card()).getByText('Free trial: 1 day left')).toBeInTheDocument()

      act(() => {
        bumpAccountEpoch()
        useAuthStore.getState().setUser(userV)
      })
      expect(document.body).not.toHaveTextContent(countdownText)

      await pastEnd()
      await flush()
      await flush()
      expect(subscriptionReads()).toBe(1)
    })

    // A failed shared expiry read leaves an owned recovery path and no automatic retries.
    it('offers an owned retry after the shared expiry read fails, without retrying on its own', async () => {
      routeBilling([() => json(running), () => ({ ok: false, status: 503, json: async () => ({}) }), () => json(ended)])
      seed(running.accountNotice)
      renderWithPage()
      await flush()
      await pastEnd()
      await flush()
      await flush()
      expect(subscriptionReads()).toBe(2)
      expect(document.body).not.toHaveTextContent(countdownText)
      expect(screen.queryByText('Your trial has ended.')).not.toBeInTheDocument()

      await act(async () => { vi.advanceTimersByTime(DAY) })
      await flush()
      expect(subscriptionReads()).toBe(2)

      fireEvent.click(within(card()).getByRole('button', { name: 'Try again' }))
      await flush()
      await flush()
      expect(subscriptionReads()).toBe(3)
      endedCard()
    })

    it('lets a returning tab claim the expiry read again after it failed', async () => {
      routeBilling([() => json(running), () => ({ ok: false, status: 503, json: async () => ({}) }), () => json(ended)])
      seed(running.accountNotice)
      renderWithPage()
      await flush()
      await pastEnd()
      await flush()
      await flush()
      expect(subscriptionReads()).toBe(2)

      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      await flush()
      await flush()
      expect(subscriptionReads()).toBe(3)
      endedCard()
    })

    it('makes no expiry continuation after sign-out', async () => {
      let releaseClaim!: (value: unknown) => void
      const claimRead = new Promise(resolve => { releaseClaim = resolve })
      routeBilling([() => json(running), () => claimRead, () => json(ended)])
      seed(running.accountNotice)
      renderWithPage()
      await flush()
      await pastEnd()
      await flush()
      act(() => { useAuthStore.getState().setUser(null) })
      releaseClaim(json(ended))
      await flush()
      await flush()
      expect(subscriptionReads()).toBe(2)
      expect(useAuthStore.getState().hostedAccess).toBeNull()
    })

    it('settles the expiry result from a newer owned read without continuing the superseded one', async () => {
      let releaseClaim!: (value: unknown) => void
      const claimRead = new Promise(resolve => { releaseClaim = resolve })
      routeBilling([() => json(running), () => claimRead, () => json(ended)])
      seed(running.accountNotice)
      renderWithPage()
      await flush()
      await pastEnd()
      await flush()
      await act(async () => { await useAuthStore.getState().fetchSubscription() })
      expect(subscriptionReads()).toBe(3)
      releaseClaim(json(running))
      await flush()
      await flush()
      expect(subscriptionReads()).toBe(3)
      endedCard()
    })

    it('makes exactly one expiry read when a stale tab becomes visible after the trial ended', async () => {
      routeBilling([() => json(running), () => json(ended)])
      seed(running.accountNotice, userU, NOW.getTime() - 16 * 60 * 1000)
      renderWithPage()
      await flush()
      expect(subscriptionReads()).toBe(1)

      await act(async () => {
        vi.setSystemTime(new Date(NOW.getTime() + 2 * HOUR + 1000))
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await flush()
      await flush()
      expect(subscriptionReads()).toBe(2)
      endedCard()
    })

    it('drops the page countdown when the same account becomes admin, keeping the status and date', async () => {
      routeBilling([() => json(running)])
      seed(running.accountNotice)
      renderWithPage()
      await flush()
      expect(within(card()).getByText('Free trial: 1 day left')).toBeInTheDocument()

      act(() => { useAuthStore.getState().setUser({ ...userU, isAdmin: true }) })
      expect(document.body).not.toHaveTextContent(countdownText)
      expect(within(card()).getByText('Trialing')).toBeInTheDocument()
      expect(within(card()).getByText('Free trial ends')).toBeInTheDocument()
    })

    it('gives a custom-server account no page notice, price read or expiry read, even when Billing answers', async () => {
      localStorage.setItem('silentsuite-server-url', 'https://dav.example.test')
      const reads = routeBilling([() => json(running), () => json(ended)])
      seed(null)
      render(<><Sidebar /><SubscriptionPage /></>)
      await flush()
      await flush()
      const section = card()
      expect(document.body).not.toHaveTextContent(countdownText)
      expect(within(section).queryByText(/free trial:/i)).not.toBeInTheDocument()
      expect(within(section).getByText('Trialing')).toBeInTheDocument()
      expect(within(section).getByText('Free trial ends')).toBeInTheDocument()
      expect(screen.queryByText(/per year/)).not.toBeInTheDocument()
      expect(screen.queryByText(/keep your calendar, contacts and tasks syncing/i)).not.toBeInTheDocument()
      expect(reads.offerReads()).toBe(0)

      await pastEnd()
      await flush()
      expect(subscriptionReads()).toBe(1)
    })

    it('shows no page countdown on a self-hosted build', async () => {
      state.selfHosted = true
      routeBilling([() => json(running)])
      seed(running.accountNotice)
      render(<SubscriptionPage />)
      await flush()
      expect(document.body).not.toHaveTextContent(countdownText)
      expect(within(card()).getByText('Trialing')).toBeInTheDocument()
    })

    it('hides an already shown price once another account replaces the owner', async () => {
      routeBilling([() => json(ended)], [() => json(offerBody('early_annual'))])
      seed(null)
      render(<SubscriptionPage />)
      await flush()
      await flush()
      expect(within(card()).getByText('€36.00 per year')).toBeInTheDocument()

      act(() => {
        bumpAccountEpoch()
        useAuthStore.getState().setUser(userV)
      })
      expect(screen.queryByText('€36.00 per year')).not.toBeInTheDocument()
    })

    it('hides the old price while a same-account refresh reads the offer again', async () => {
      let releaseNewer!: (value: unknown) => void
      const newerOffer = new Promise(resolve => { releaseNewer = resolve })
      const reads = routeBilling([() => json(ended)], [() => json(offerBody('early_annual')), () => newerOffer])
      seed(null)
      render(<SubscriptionPage />)
      await flush()
      await flush()
      expect(within(card()).getByText('€36.00 per year')).toBeInTheDocument()

      act(() => { useAuthStore.getState().setUser({ ...userU }) })
      await flush()
      expect(reads.offerReads()).toBe(2)
      expect(screen.queryByText('€36.00 per year')).not.toBeInTheDocument()

      releaseNewer(json(offerBody('standard_annual')))
      await flush()
      await flush()
      expect(within(card()).getByText('€48.00 per year')).toBeInTheDocument()
    })

    it('keeps the newer offer price when an older offer read for the same account finishes last', async () => {
      let releaseOlder!: (value: unknown) => void
      const olderOffer = new Promise(resolve => { releaseOlder = resolve })
      const reads = routeBilling(
        [() => json(running), () => json(ended)],
        [() => olderOffer, () => json(offerBody('standard_annual'))],
      )
      seed(running.accountNotice)
      renderWithPage()
      await flush()
      expect(reads.offerReads()).toBe(1)

      // The shared expiry read refreshes the card, whose Subscribe action reads the offer again.
      await act(async () => { vi.advanceTimersByTime(2 * HOUR + 1000) })
      await flush()
      await flush()
      expect(reads.offerReads()).toBe(2)
      expect(within(card()).getByText('€48.00 per year')).toBeInTheDocument()

      releaseOlder(json(offerBody('early_annual')))
      await flush()
      await flush()
      expect(within(card()).getByText('€48.00 per year')).toBeInTheDocument()
      expect(screen.queryByText('€36.00 per year')).not.toBeInTheDocument()
    })
  })

  it('[RED] refreshes a stale countdown once when the tab becomes visible, and not when fresh', async () => {
    seed(daysLeftNotice(3 * DAY), userU, NOW.getTime() - 16 * 60 * 1000)
    renderAll()
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(subscriptionReads()).toBe(1)
    await flush()
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(subscriptionReads()).toBe(1)
  })
})
