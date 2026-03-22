'use client'

import { useState } from 'react'
import { Check, Calendar, Users, CheckSquare, Shield, Github, CreditCard, RotateCcw, Globe } from 'lucide-react'

type BillingCycle = 'monthly' | 'yearly'

const plans = [
  {
    name: 'Early Adopter',
    monthlyPrice: 3.60,
    yearlyPrice: 3.00,
    description: 'Limited time pricing for early supporters. Locked in for as long as you stay.',
    icons: [Calendar, Users, CheckSquare, Shield],
    features: [
      'Calendar, contacts & tasks sync',
      'End-to-end encryption',
      'Unlimited devices',
      'Web, iOS & Android apps',
      '5 GB encrypted storage',
      'Email support',
      'Price locked forever',
    ],
    cta: 'Get started',
    href: 'https://app.silentsuite.io/signup',
    highlight: true,
    badge: 'Limited time',
  },
  {
    name: 'Standard',
    monthlyPrice: 4.80,
    yearlyPrice: 4.00,
    description: 'Everything you need for private sync across your devices.',
    icons: [Calendar, Users, CheckSquare, Shield],
    features: [
      'Calendar, contacts & tasks sync',
      'End-to-end encryption',
      'Unlimited devices',
      'Web, iOS & Android apps',
      '5 GB encrypted storage',
      'Email support',
    ],
    cta: 'Get started',
    href: 'https://app.silentsuite.io/signup',
    highlight: false,
  },
  {
    name: 'Self-hosted',
    monthlyPrice: 0,
    yearlyPrice: 0,
    description: 'Run the server yourself. Full control, zero cost. Optional €4/mo to support development.',
    icons: [Github, Calendar, Users, CheckSquare],
    features: [
      'Open-source server (AGPL)',
      'Docker one-line deploy',
      'Community support',
      'Full data sovereignty',
      'No usage limits',
    ],
    cta: 'View on GitHub',
    href: 'https://github.com/silent-suite',
    highlight: false,
  },
]

const trustSignals = [
  {
    icon: CreditCard,
    title: 'Safe payment',
    description: 'Secure payment via Stripe. We never see your card details.',
  },
  {
    icon: RotateCcw,
    title: 'Cancel at any time',
    description: 'No lock-in contracts. Cancel your subscription whenever you want.',
  },
  {
    icon: Globe,
    title: 'Your data, your control',
    description: 'Encrypted on your device. Zero-knowledge architecture means only you can access your data.',
  },
  {
    icon: Shield,
    title: 'Free trial included',
    description: 'Try SilentSuite free for up to 30 days. No commitment required.',
  },
]

function BillingToggle({
  billing,
  onChange,
}: {
  billing: BillingCycle
  onChange: (cycle: BillingCycle) => void
}) {
  return (
    <div className="flex items-center justify-center gap-3 mb-12">
      <span
        className={`text-sm font-medium transition-colors ${
          billing === 'monthly' ? 'text-white' : 'text-navy-400'
        }`}
      >
        Monthly
      </span>
      <button
        onClick={() => onChange(billing === 'monthly' ? 'yearly' : 'monthly')}
        className="relative w-14 h-7 rounded-full bg-navy-800 border border-navy-600 transition-colors focus:outline-none focus:ring-2 focus:ring-teal-400/50"
        aria-label={`Switch to ${billing === 'monthly' ? 'yearly' : 'monthly'} billing`}
      >
        <div
          className={`absolute top-0.5 w-6 h-6 rounded-full bg-teal-400 transition-transform ${
            billing === 'yearly' ? 'translate-x-7' : 'translate-x-0.5'
          }`}
        />
      </button>
      <span
        className={`text-sm font-medium transition-colors ${
          billing === 'yearly' ? 'text-white' : 'text-navy-400'
        }`}
      >
        Yearly
      </span>
      {billing === 'yearly' && (
        <span className="ml-1 px-2 py-0.5 bg-teal-400/10 text-teal-400 text-xs font-semibold rounded-full border border-teal-400/20">
          Save ~17%
        </span>
      )}
    </div>
  )
}

export default function Pricing() {
  const [billing, setBilling] = useState<BillingCycle>('yearly')

  return (
    <section id="pricing" className="py-28 bg-navy-950 text-white">
      <div className="max-w-6xl mx-auto px-6">
        <div className="text-center mb-10">
          <h2 className="text-4xl md:text-5xl font-bold mb-6">
            Simple, honest pricing
          </h2>
          <p className="text-xl text-navy-300 max-w-2xl mx-auto">
            No ads. No data harvesting. You pay for the service, and the service works for you.
            Early adopters get discounted pricing locked in for life.
          </p>
        </div>

        <BillingToggle billing={billing} onChange={setBilling} />

        {/* Plan cards — centered */}
        <div className="grid md:grid-cols-3 gap-6 max-w-4xl mx-auto">
          {plans.map((plan) => {
            const isFree = plan.monthlyPrice === 0
            const price = isFree
              ? 'Free'
              : `\u20AC${billing === 'monthly' ? plan.monthlyPrice.toFixed(2) : plan.yearlyPrice.toFixed(2)}`
            const period = isFree
              ? 'forever'
              : billing === 'monthly'
                ? '/month'
                : '/month, billed yearly'

            return (
              <div
                key={plan.name}
                className={`relative p-8 rounded-2xl border flex flex-col transition-all ${
                  plan.highlight
                    ? 'bg-teal-400/10 border-teal-400/40 ring-1 ring-teal-400/20'
                    : 'bg-navy-900 border-navy-700 hover:border-navy-600'
                }`}
              >
                {'badge' in plan && plan.badge && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="px-4 py-1 bg-teal-400 text-navy-950 text-xs font-bold rounded-full uppercase tracking-wide">
                      {plan.badge}
                    </span>
                  </div>
                )}
                {plan.highlight && !('badge' in plan) && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="px-4 py-1 bg-teal-400 text-navy-950 text-xs font-bold rounded-full uppercase tracking-wide">
                      Most popular
                    </span>
                  </div>
                )}

                <div className="mb-6">
                  <h3 className="text-lg font-semibold mb-2">{plan.name}</h3>
                  {/* Product icons */}
                  <div className="flex items-center gap-1.5 mb-4">
                    {plan.icons.map((Icon, i) => (
                      <div key={i} className="w-6 h-6 rounded bg-navy-800 flex items-center justify-center">
                        <Icon className="w-3.5 h-3.5 text-teal-400" />
                      </div>
                    ))}
                  </div>
                  <div className="flex items-end gap-1 mb-1">
                    <span className="text-4xl font-bold">{price}</span>
                  </div>
                  <p className="text-navy-400 text-sm mb-3">{period}</p>
                  {!isFree && billing === 'yearly' && (
                    <p className="text-teal-400 text-xs font-medium">
                      Save &euro;{((plan.monthlyPrice - plan.yearlyPrice) * 12).toFixed(0)}/year vs monthly
                    </p>
                  )}
                  <p className="text-navy-300 text-sm mt-3">{plan.description}</p>
                </div>

                <ul className="space-y-3 mb-8 flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-3 text-sm">
                      <Check className="w-4 h-4 text-teal-400 mt-0.5 shrink-0" />
                      <span className="text-navy-200">{f}</span>
                    </li>
                  ))}
                </ul>

                <a
                  href={plan.href}
                  className={`block text-center py-3 px-6 rounded-lg font-semibold transition-colors ${
                    plan.highlight
                      ? 'bg-teal-400 hover:bg-teal-500 text-navy-950'
                      : 'bg-navy-800 hover:bg-navy-700 text-white'
                  }`}
                >
                  {plan.cta}
                </a>
              </div>
            )
          })}
        </div>

        <p className="text-center text-navy-500 text-sm mt-8">
          Pricing in EUR. All plans include a free trial.{' '}
          {billing === 'yearly'
            ? 'Billed annually. Switch to monthly anytime.'
            : 'Billed monthly. Save ~17% with yearly billing.'}
          {' '}Cancel anytime, no lock-in.
        </p>

        {/* Trust signals — below pricing cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mt-16 max-w-4xl mx-auto">
          {trustSignals.map(({ icon: Icon, title, description }) => (
            <div key={title} className="text-center">
              <div className="w-10 h-10 rounded-lg bg-teal-400/10 flex items-center justify-center mx-auto mb-3">
                <Icon className="w-5 h-5 text-teal-400" />
              </div>
              <p className="text-sm font-semibold text-white mb-1">{title}</p>
              <p className="text-xs text-navy-400 leading-relaxed">{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
