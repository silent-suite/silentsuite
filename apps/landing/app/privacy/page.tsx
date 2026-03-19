import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Privacy Policy | SilentSuite',
  description: 'How SilentSuite handles your data. Short version: we can\'t read it.',
}

export default function Privacy() {
  return (
    <main className="min-h-screen bg-navy-950 text-white pt-16">
      {/* Header */}
      <div className="border-b border-navy-700">
        <div className="max-w-3xl mx-auto px-6 py-6">
          <Link href="/" className="text-teal-400 hover:underline text-sm">
            &larr; Back to SilentSuite
          </Link>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-4xl font-bold mb-4">Privacy Policy</h1>
        <p className="text-navy-400 mb-12">Last updated: March 12, 2026</p>

        <div className="prose prose-invert max-w-none space-y-8 text-navy-200">

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              The short version
            </h2>
            <p>
              SilentSuite is an end-to-end encrypted sync service. Your
              calendar, contacts, and task data is encrypted on your device
              before it reaches our servers. We cannot read, analyze, or share
              your encrypted data. This is by design, not just by policy.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              1. Controller
            </h2>
            <p>
              The controller responsible for data processing on this website
              is:
            </p>
            <p>
              SilentSuite<br />
              E-Mail:{' '}
              <a href="mailto:info@silentsuite.io" className="text-teal-400 hover:underline">
                info@silentsuite.io
              </a>
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              2. What data we collect
            </h2>

            <h3 className="text-lg font-medium text-white mt-4 mb-2">
              2.1 Website visits (silentsuite.io)
            </h3>
            <p>
              This website is hosted on Cloudflare Pages. Cloudflare may
              process your IP address to deliver the website. We do not use
              any analytics, tracking scripts, or cookies on this website.
              Fonts are self-hosted. No requests are made to Google or
              other third-party font services.
            </p>

            <h3 className="text-lg font-medium text-white mt-4 mb-2">
              2.2 Waitlist signup
            </h3>
            <p>
              When you join our waitlist, we collect:
            </p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Email address (required)</li>
              <li>Name (optional)</li>
              <li>Intended use case (optional)</li>
              <li>Consent confirmation and timestamp</li>
            </ul>
            <p className="mt-2">
              We use a double opt-in process: after submitting the form,
              you will receive a confirmation email. Your email address is
              only stored and used after you click the confirmation link.
              Until confirmation, your data is held in a pending state and
              automatically deleted if not confirmed within 48 hours.
            </p>
            <p className="mt-2">
              This data is stored via Formbricks (self-hostable survey tool)
              and used solely to contact you about SilentSuite availability.
              Legal basis: Art. 6(1)(a) GDPR (consent). You can withdraw
              consent at any time by emailing us at{' '}
              <a href="mailto:info@silentsuite.io" className="text-teal-400 hover:underline">
                info@silentsuite.io
              </a>.
            </p>

            <h3 className="text-lg font-medium text-white mt-4 mb-2">
              2.3 SilentSuite sync service (server.silentsuite.io)
            </h3>
            <p>
              When you use the SilentSuite sync service, we process:
            </p>
            <ul className="list-disc pl-6 space-y-1">
              <li>
                <strong>Account data:</strong> Username, hashed authentication
                public key, account creation timestamp. This is necessary for
                account operation.
              </li>
              <li>
                <strong>Encrypted data:</strong> Your calendar events,
                contacts, and tasks are stored as encrypted blobs. We have no
                technical ability to decrypt this data. The encryption keys
                never leave your device.
              </li>
              <li>
                <strong>Metadata:</strong> Sync timestamps, collection
                membership, and sync tokens. This metadata is necessary for
                the sync protocol to function.
              </li>
              <li>
                <strong>Server logs:</strong> IP address and request
                timestamps may be logged temporarily for security and abuse
                prevention. Logs are rotated automatically.
              </li>
            </ul>
            <p className="mt-2">
              Legal basis: Art. 6(1)(b) GDPR (contract performance) for
              account and encrypted data. Art. 6(1)(f) GDPR (legitimate
              interest) for security logs.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              3. Where data is stored
            </h2>
            <p>
              The SilentSuite sync server is hosted on secure, GDPR-compliant
              infrastructure. Your encrypted data never leaves the EU. The landing
              page is served via Cloudflare&apos;s global CDN.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              4. Data sharing
            </h2>
            <p>
              We do not sell, trade, or share your personal data with third
              parties. We use the following processors:
            </p>
            <ul className="list-disc pl-6 space-y-1">
              <li>
                <strong>Cloud hosting provider</strong> (EU): server hosting
              </li>
              <li>
                <strong>Cloudflare, Inc.</strong> (US, with EU data processing):
                website hosting and CDN
              </li>
              <li>
                <strong>Formbricks</strong>: waitlist form processing
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              5. Your rights
            </h2>
            <p>Under GDPR, you have the right to:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Access the personal data we hold about you</li>
              <li>Rectify inaccurate data</li>
              <li>Request deletion of your data</li>
              <li>Restrict or object to processing</li>
              <li>Data portability</li>
              <li>Withdraw consent at any time</li>
              <li>
                Lodge a complaint with a supervisory authority
              </li>
            </ul>
            <p className="mt-2">
              To exercise any of these rights, email us at{' '}
              <a href="mailto:info@silentsuite.io" className="text-teal-400 hover:underline">
                info@silentsuite.io
              </a>.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              6. Data retention
            </h2>
            <p>
              Waitlist data is retained until the waitlist is closed or you
              request removal. Account data and encrypted sync data are
              retained for the duration of your account. Server logs are
              retained for a maximum of 30 days. When you delete your account,
              all associated data is permanently removed.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              7. Cookies
            </h2>
            <p>
              This website does not use cookies. The SilentSuite sync service
              uses authentication tokens stored in your application. These
              are not browser cookies.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              8. Changes to this policy
            </h2>
            <p>
              We may update this privacy policy from time to time. Changes
              will be posted on this page with an updated date. For
              significant changes, we will notify waitlist members and
              registered users via email.
            </p>
          </section>

        </div>
      </div>
    </main>
  )
}
