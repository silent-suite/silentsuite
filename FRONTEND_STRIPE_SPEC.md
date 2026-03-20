# B1: Inline Stripe Elements Payment — Frontend Changes

## Overview
Replace Stripe Checkout redirect with inline Stripe Elements in the signup flow. New plan picker with 3 trial paths.

## Dependencies to Install
```bash
pnpm add @stripe/react-stripe-js @stripe/stripe-js --filter @silentsuite/web
```

## Environment Variable
Add to `apps/web/.env.local` and `apps/web/.env.example`:
```
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_51TAx8aPZr2w1sOdtvpdnjDy7I4P6zKxthjFpbdjwyxQA5HJaOCyIKA6Zg4nGG0ffjqnvtD9MdBut281pIqcyaBtt00WOqXFXWL
```

## Design System
- Dark slate/emerald palette: `slate-950` bg, `emerald-500` accent
- CSS vars: `rgb(var(--foreground))`, `rgb(var(--background))`, `rgb(var(--surface))`, `rgb(var(--border))`, `rgb(var(--muted))`, `rgb(var(--primary))`
- Inter font
- Use existing `Button` and `Input` from `@silentsuite/ui`
- Follow exact same patterns as existing signup page code

## Billing API Endpoints (what the frontend calls)

**Base URL:** `process.env.NEXT_PUBLIC_BILLING_API_URL ?? 'http://localhost:3736'`

### POST /auth/provision (updated)
```typescript
// Request
{
  etebaseSessionToken: string,
  planId: 'early_monthly' | 'early_annual' | 'standard_monthly' | 'standard_annual',
  trialPath: '7day' | '30day' | 'immediate'
}
// Response 201
{
  id: string,
  email: string,
  provisioningStatus: string,
  earlyAdopter: boolean,
  createdAt: string,
  clientSecret: string | null  // null for 7day path
}
```

### POST /subscription/setup-card (new)
```typescript
// Request (JWT auth via cookie)
{ planId: 'early_monthly' | 'early_annual' | 'standard_monthly' | 'standard_annual' }
// Response 200
{ clientSecret: string }
```

### GET /subscription (updated response)
```typescript
{
  plan: 'early_monthly' | 'early_annual' | 'standard_monthly' | 'standard_annual' | 'selfhost_supporter' | null,
  planLabel: string,
  billingInterval: 'monthly' | 'annual',
  status: 'none' | 'trialing' | 'active' | 'past_due' | 'cancelled',
  renewalDate: string | null,
  trial: { active: boolean, endsAt: string | null, daysRemaining: number | null },
  cancelAtPeriodEnd: boolean,
  trialPath: '7day' | '30day' | 'immediate' | null,
  earlyAdopter: boolean
}
```

### POST /subscription/reactivate (updated response)
```typescript
// Request
{ planId: string }
// Response - now returns clientSecret instead of checkoutUrl
{ clientSecret: string, subscriptionId: string }
```

## File Changes

### 1. NEW: `apps/web/app/components/stripe-payment-form.tsx`

Shared Stripe Elements payment component. Used in signup, settings, and add-card flows.

```tsx
'use client'

import { useState } from 'react'
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'
import { loadStripe } from '@stripe/stripe-js'
import { Button } from '@silentsuite/ui'

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!)

// Stripe Elements appearance matching our dark theme
const appearance = {
  theme: 'night' as const,
  variables: {
    colorPrimary: '#10b981', // emerald-500
    colorBackground: 'rgb(15, 23, 42)', // slate-900ish
    colorText: '#e2e8f0',
    colorDanger: '#ef4444',
    fontFamily: 'Inter, system-ui, sans-serif',
    borderRadius: '8px',
  },
}

interface PaymentFormProps {
  clientSecret: string
  onSuccess: () => void
  onError?: (error: string) => void
  submitLabel?: string
  mode?: 'setup' | 'payment' // setup = SetupIntent (trial), payment = PaymentIntent (immediate)
}

function PaymentFormInner({ onSuccess, onError, submitLabel, mode }: Omit<PaymentFormProps, 'clientSecret'>) {
  const stripe = useStripe()
  const elements = useElements()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!stripe || !elements) return

    setLoading(true)
    setError(null)

    let result
    if (mode === 'setup') {
      result = await stripe.confirmSetup({
        elements,
        confirmParams: { return_url: `${window.location.origin}/signup/success` },
        redirect: 'if_required',
      })
    } else {
      result = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: `${window.location.origin}/signup/success` },
        redirect: 'if_required',
      })
    }

    if (result.error) {
      const msg = result.error.message ?? 'Payment failed'
      setError(msg)
      onError?.(msg)
      setLoading(false)
    } else {
      onSuccess()
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <Button type="submit" disabled={!stripe || loading} className="w-full">
        {loading ? 'Processing...' : (submitLabel ?? 'Confirm payment')}
      </Button>
    </form>
  )
}

export default function StripePaymentForm(props: PaymentFormProps) {
  return (
    <Elements stripe={stripePromise} options={{ clientSecret: props.clientSecret, appearance }}>
      <PaymentFormInner
        onSuccess={props.onSuccess}
        onError={props.onError}
        submitLabel={props.submitLabel}
        mode={props.mode}
      />
    </Elements>
  )
}
```

### 2. REWRITE: `apps/web/app/(auth)/signup/page.tsx`

The signup flow needs these steps:

**Step 1: Create Account** (mostly unchanged)
- Email/username, password, confirm password
- Advanced: server URL for self-hosters
- On submit: createEtebaseAccount()

**Step 2: Choose Plan** (NEW — replaces old single founding member card)
Show 2 tiers with monthly/annual toggle:

```
┌─────────────────────────────────┐  ┌─────────────────────────────────┐
│  🌟 Early Adopter               │  │  ⭐ Standard                     │
│  Limited time pricing            │  │                                  │
│                                  │  │                                  │
│  €3.60/mo  or  €36/yr (€3/mo)  │  │  €4.80/mo  or  €48/yr (€4/mo)  │
│                                  │  │                                  │
│  [Select]                        │  │  [Select]                        │
└─────────────────────────────────┘  └─────────────────────────────────┘

Toggle: [Monthly] [Annual]
```

- Each tier shows both monthly and annual prices
- User picks a tier, the billing interval is controlled by the toggle
- This sets planId to one of: early_monthly, early_annual, standard_monthly, standard_annual

**Step 3: Choose Trial Path** (NEW)
Three clear options:

```
┌──────────────────────────────────┐
│  🚀 Pay now, get 30 days free    │
│  First charge today, then in     │
│  30 days. Best value.            │
│  [Pay €X.XX now]                 │
└──────────────────────────────────┘

┌──────────────────────────────────┐
│  💳 30-day free trial             │
│  Add your card now. First        │
│  charge in 30 days.              │
│  [Start trial]                   │
└──────────────────────────────────┘

┌──────────────────────────────────┐
│  ⏰ 7-day free trial              │
│  No card required. Try it out    │
│  risk-free for 7 days.           │
│  [Start free]                    │
└──────────────────────────────────┘
```

On select:
- `immediate` or `30day`: calls provision API → gets clientSecret → go to Step 4 (payment)
- `7day`: calls provision API (clientSecret=null) → skip payment → go to Step 5 (vault)

**Step 4: Payment** (NEW — Stripe Elements inline)
- Shows `<StripePaymentForm>` with the clientSecret from provision
- mode='setup' for 30-day trial (SetupIntent — saving card for later charge)
- mode='payment' for immediate (PaymentIntent — charging now)
- On success → go to Step 5 (vault)
- Submit label: "Start 30-day trial" for 30day, "Pay €X.XX" for immediate

**Step 5: Vault & Recovery Key** (unchanged from current Step 4)

**Self-host flow** (unchanged except remove hardcoded Stripe payment link):
- If self-hosted server detected, show self-host support option
- "Support the project" card should call a new endpoint or use createSupporterSubscription
- For now, keep the self-host flow as-is but replace the buy.stripe.com link with inline Elements

**Progress stepper**: Update to reflect new steps:
- Default: Create Account → Choose Plan → Trial → Payment → Vault
- 7day path: Create Account → Choose Plan → Trial → Vault (skip payment)
- Self-host: Create Account → Self-Hosting → Admin → Vault

### 3. UPDATE: `apps/web/app/stores/use-auth-store.ts`

The `signup` function currently:
1. Calls POST /auth/provision with { etebaseSessionToken, planId }
2. Returns checkoutUrl

Change to:
1. Accept `trialPath` parameter
2. Call POST /auth/provision with { etebaseSessionToken, planId, trialPath }
3. Return `clientSecret` (string | null) instead of `checkoutUrl`

```typescript
signup: async (planId: string, trialPath: string) => {
  // ... existing self-hosted logic ...

  const res = await fetch(`${BILLING_API_URL}/auth/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ etebaseSessionToken: pending.etebaseAuthToken, planId, trialPath }),
    credentials: 'include',
  })
  // ... error handling ...
  const data = await res.json()
  set({
    user: { id: data.id, email: pending.email, planId, isAdmin: data.isAdmin === true },
    isAuthenticated: true,
    isLoading: false,
    pendingSignup: null,
    subscriptionStatus: trialPath === '7day' ? 'trialing' : 'none',
  })
  return (data.clientSecret as string) ?? null
}
```

Also update the `foundingMemberEligible` field in PendingSignup to `earlyAdopter`.

### 4. DELETE: `apps/web/app/(auth)/signup/plan/page.tsx`

This standalone plan page is no longer needed — plan selection is now inline in the signup flow. Delete or leave as redirect to /signup.

### 5. UPDATE: `apps/web/app/(auth)/signup/cancel/page.tsx`

Check if this still makes sense. It was the Stripe Checkout cancel return URL. May need updating or can redirect to signup.

### 6. NEW: `apps/web/app/components/add-card-banner.tsx`

Banner shown to 7-day trial users prompting them to add a card.

```tsx
'use client'

import { useState } from 'react'
import { CreditCard, Clock, X } from 'lucide-react'
import { Button } from '@silentsuite/ui'
import StripePaymentForm from './stripe-payment-form'

const BILLING_API_URL = process.env.NEXT_PUBLIC_BILLING_API_URL ?? 'http://localhost:3736'

interface AddCardBannerProps {
  daysRemaining: number
  planId: string
  onCardAdded: () => void
}

export default function AddCardBanner({ daysRemaining, planId, onCardAdded }: AddCardBannerProps) {
  const [showForm, setShowForm] = useState(false)
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [loading, setLoading] = useState(false)

  if (dismissed) return null

  const handleAddCard = async () => {
    setLoading(true)
    try {
      const res = await fetch(`${BILLING_API_URL}/subscription/setup-card`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ planId }),
      })
      if (res.ok) {
        const data = await res.json()
        setClientSecret(data.clientSecret)
        setShowForm(true)
      }
    } catch {
      // handle error
    } finally {
      setLoading(false)
    }
  }

  if (showForm && clientSecret) {
    return (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-[rgb(var(--foreground))]">
            Add your card — get 23 more free days
          </h3>
          <button onClick={() => { setShowForm(false); setClientSecret(null) }}>
            <X className="h-4 w-4 text-[rgb(var(--muted))]" />
          </button>
        </div>
        <StripePaymentForm
          clientSecret={clientSecret}
          onSuccess={onCardAdded}
          submitLabel="Save card & extend trial"
          mode="setup"
        />
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
      <div className="flex items-center gap-3">
        <Clock className="h-4 w-4 text-amber-400" />
        <div>
          <p className="text-sm text-amber-400">
            {daysRemaining} day{daysRemaining !== 1 ? 's' : ''} left in your trial
          </p>
          <p className="text-xs text-[rgb(var(--muted))]">
            Add a card to extend to 30 days free
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleAddCard} disabled={loading}>
          <CreditCard className="h-3.5 w-3.5 mr-1.5" />
          {loading ? 'Loading...' : 'Add card'}
        </Button>
        <button onClick={() => setDismissed(true)} className="text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
```

### 7. UPDATE: `apps/web/app/(app)/settings/subscription/page.tsx`

- Update plan labels: remove founding_member, personal_monthly, personal_annual
- Use new plan IDs in reactivation dialog
- Reactivation: instead of redirecting to checkoutUrl, get clientSecret and show inline StripePaymentForm
- Show trial path info
- For plan selection (reactivate), show the same plan picker cards as signup

### 8. Where to show AddCardBanner

In the main app layout or dashboard, check subscription status:
- If `status === 'trialing'` and `trialPath === '7day'` and `provisioningStatus === 'trialing_no_card'` → show AddCardBanner
- Fetch from GET /subscription on app load

## Important Notes

- All Stripe Elements must be wrapped in `<Elements>` provider with the `clientSecret`
- The `appearance` object matches the dark theme
- `redirect: 'if_required'` prevents redirect for cards that don't need 3DS
- For 3DS/SCA: Stripe handles this automatically in the PaymentElement, showing a modal
- The `return_url` is a fallback for redirected 3DS — handle success on that page too
- Stripe publishable key is safe to expose (it's meant for client-side)
