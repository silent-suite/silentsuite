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
        <p className="text-navy-400 mb-12">Last updated: March 23, 2026</p>

        <div className="prose prose-invert max-w-none space-y-8 text-navy-200">

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              The short version
            </h2>
            <p>
              SilentSuite is an end-to-end encrypted sync service for calendars,
              contacts, and tasks. Your data is encrypted on your device before
              it reaches our servers. We cannot read, analyze, or share your
              encrypted data. This is by design, not just by policy.
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
              process your IP address to deliver the website. We use
              Plausible Analytics (self-hosted), a privacy-friendly analytics
              tool that does not use cookies, does not track individual users,
              and does not collect personal data. Fonts are self-hosted. No
              requests are made to Google or other third-party font services.
            </p>

            <h3 className="text-lg font-medium text-white mt-4 mb-2">
              2.2 Newsletter subscription
            </h3>
            <p>
              When you subscribe to our newsletter, we collect:
            </p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Email address (required)</li>
              <li>Name (optional)</li>
              <li>Intended use case (optional)</li>
              <li>Consent confirmation</li>
            </ul>
            <p className="mt-2">
              We use Resend to send transactional and newsletter emails. Your
              email address is used solely to send you product updates and
              announcements about SilentSuite.
              Legal basis: Art. 6(1)(a) GDPR (consent). You can withdraw
              consent at any time by replying with &quot;unsubscribe&quot; or
              emailing us at{' '}
              <a href="mailto:info@silentsuite.io" className="text-teal-400 hover:underline">
                info@silentsuite.io
              </a>.
            </p>

            <h3 className="text-lg font-medium text-white mt-4 mb-2">
              2.3 SilentSuite service (app.silentsuite.io)
            </h3>
            <p>
              SilentSuite is available as a web app, an Android mobile app,
              and a CalDAV bridge for use with existing calendar and contacts
              clients. When you use the service, we process:
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

            <h3 className="text-lg font-medium text-white mt-4 mb-2">
              2.4 Payment processing
            </h3>
            <p>
              Payments are processed by Stripe. Your card details are handled
              entirely by Stripe and are never stored on or transmitted to our
              servers. We receive only a transaction reference, plan type, and
              billing status from Stripe.
              Legal basis: Art. 6(1)(b) GDPR (contract performance).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              3. Where data is stored
            </h2>
            <p>
              The SilentSuite sync server is hosted on secure, GDPR-compliant
              infrastructure. Your encrypted data never leaves the EU. The
              landing page is served via Cloudflare&apos;s global CDN. You may
              also choose to self-host the SilentSuite server for complete
              data sovereignty.
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
                <strong>Resend</strong>: transactional and newsletter email
                delivery
              </li>
              <li>
                <strong>Stripe</strong>: payment processing
              </li>
              <li>
                <strong>Plausible Analytics</strong> (self-hosted):
                privacy-friendly, cookieless website analytics
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
              <li>Data portability (export in ICS, VCF, or ZIP formats)</li>
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
              Newsletter subscriber data is retained until you unsubscribe or
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
              This website does not use cookies. Plausible Analytics is
              cookieless. The SilentSuite service uses authentication tokens
              stored in your application. These are not browser cookies.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              8. Self-hosting
            </h2>
            <p>
              SilentSuite offers a self-hosted option. When you run your own
              server, your data never touches our infrastructure. This privacy
              policy applies only to services operated by SilentSuite (the
              hosted service and this website). Self-hosted instances are under
              your own control and responsibility.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">
              9. Changes to this policy
            </h2>
            <p>
              We may update this privacy policy from time to time. Changes
              will be posted on this page with an updated date. For
              significant changes, we will notify subscribers and registered
              users via email.
            </p>
          </section>

        </div>
      </div>
    </main>
  )
}
