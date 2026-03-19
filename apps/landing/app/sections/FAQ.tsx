'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

const faqs = [
  {
    q: 'Is SilentSuite really end-to-end encrypted?',
    a: 'Yes. Your calendar, contact, and task data is encrypted on your device before it ever leaves it. The server only stores encrypted blobs \u2014 it has no way to read the contents. This is enforced by design, not policy.',
  },
  {
    q: 'How is this different from iCloud or Google?',
    a: "iCloud and Google sync have access to your data in plaintext \u2014 they can read, analyze, and use it. SilentSuite is different: zero-knowledge encryption means even we can\u2019t read your data. And because it\u2019s open source, you don\u2019t have to take our word for it.",
  },
  {
    q: 'What apps can I use?',
    a: "SilentSuite provides its own web, iOS, and Android apps built for encrypted sync. We\u2019re also building bridge support so you can use your existing calendar and contacts apps with SilentSuite as the encrypted backend.",
  },
  {
    q: 'What happens to my data if I cancel?',
    a: 'Your data is yours. You can export everything in standard formats (ICS, VCF) at any time. We will never hold your data hostage.',
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
    q: 'When will it launch?',
    a: "We\u2019re in the early development phase. Waitlist members will get early access first. Sign up and you\u2019ll be among the first to know.",
  },
  {
    q: 'What if I want to self-host?',
    a: 'Self-hosting is a first-class scenario. The server is open source and deployable with a single Docker command. Documentation will be available alongside the first public release.',
  },
]

function FAQItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-4 py-5 text-left"
      >
        <span className="font-medium text-white">{q}</span>
        <ChevronDown
          className={`w-5 h-5 text-navy-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <p className="pb-5 text-navy-300 text-sm leading-relaxed">{a}</p>
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
          {faqs.map((item) => (
            <FAQItem key={item.q} {...item} />
          ))}
        </div>
      </div>
    </section>
  )
}
