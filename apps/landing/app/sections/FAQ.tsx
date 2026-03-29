'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

const faqs = [
  {
    q: 'Is SilentSuite really end-to-end encrypted?',
    a: 'Yes. Your calendar, contact, and task data is encrypted on your device before it ever leaves it. The server only stores encrypted blobs and has no way to read the contents. This is enforced by design, not policy.',
  },
  {
    q: 'How is this different from iCloud or Google?',
    a: "iCloud and Google sync have access to your data in plaintext. They can read, analyze, and use it. SilentSuite is different: zero-knowledge encryption means even we can\u2019t read your data. And because it\u2019s open source, you don\u2019t have to take our word for it.",
  },
  {
    q: 'What apps can I use?',
    a: "SilentSuite provides web, iOS, and Android apps built for encrypted sync. The web app is also installable as a PWA for a native app experience on any device.",
  },
  {
    q: 'What happens to my data if I cancel?',
    a: 'Your data is yours. You can export calendars (ICS), contacts (VCF), or everything as a ZIP at any time. We will never hold your data hostage.',
  },
  {
    q: 'Is it open source?',
    a: 'Yes. The SilentSuite server and sync engine are open source under the AGPL license. You can inspect the source, audit the encryption, and if you want, self-host it entirely on your own infrastructure.',
  },
  {
    q: 'Where is data hosted?',
    a: 'Your data is end-to-end encrypted on your device before it reaches our servers. We comply with GDPR and maintain zero-knowledge architecture, meaning we cannot access your data regardless of server location. You can also self-host for complete control.',
  },
  {
    q: 'Is there a free trial?',
    a: "Yes. You can try SilentSuite free for up to 30 days with no commitment. No credit card required to start.",
  },
  {
    q: 'What encryption does SilentSuite use?',
    a: 'SilentSuite uses the Etebase protocol with XChaCha20-Poly1305 for data encryption and Argon2id for key derivation. Your encryption keys never leave your device.',
  },
  {
    q: 'What if I want to self-host?',
    a: 'Self-hosting is a first-class option. Run the SilentSuite server and PostgreSQL on your own infrastructure, then connect using app.silentsuite.io or the mobile apps. The server is open source (AGPL) and deployable with a single Docker command.',
  },
]

function FAQItem({ q, a, id }: { q: string; a: string; id: string }) {
  const [open, setOpen] = useState(false)
  const buttonId = `faq-q-${id}`
  const panelId = `faq-a-${id}`

  return (
    <div className="">
      <button
        id={buttonId}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={panelId}
        className="w-full flex items-center justify-between gap-4 py-5 text-left"
      >
        <h3 className="font-medium text-white text-base">{q}</h3>
        <ChevronDown
          className={`w-5 h-5 text-navy-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div id={panelId} role="region" aria-labelledby={buttonId}>
          <p className="pb-5 text-navy-300 text-sm leading-relaxed">{a}</p>
        </div>
      )}
    </div>
  )
}

export default function FAQ() {
  return (
    <section id="faq" className="py-28 bg-navy-950 text-white">
      <div className="max-w-3xl mx-auto px-6">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-6">
            Common questions
          </h2>
          <p className="text-xl text-navy-300">
            Still have questions? Reach us at{' '}
            <a href="mailto:info@silentsuite.io" className="text-teal-400 hover:underline">
              info@silentsuite.io
            </a>
          </p>
        </div>

        <div className="bg-navy-900 rounded-2xl border border-navy-700 px-6">
          {faqs.map((item, i) => (
            <FAQItem key={item.q} {...item} id={String(i)} />
          ))}
        </div>
      </div>
    </section>
  )
}
