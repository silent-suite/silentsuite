import ComparisonDiagram from '../components/ComparisonDiagram'
import ArchitectureDiagram from '../components/ArchitectureDiagram'

export default function WhyWeAreBuildingSilentSuite() {
  return (
    <>
      <p>
        Open your calendar right now. Look at the last month. Doctor
        appointments. Job interviews. Therapy sessions. Date nights. Meetings
        with your lawyer. Every recurring commitment. Every cancelled plan. Your
        calendar doesn&apos;t just track your schedule. It tells the
        complete story of your life.
      </p>

      <p>
        Now look at your contacts. Your family. Your therapist. Your ex. Your
        doctor. The relationships between them. Phone numbers, birthdays, home
        addresses. It&apos;s a map of every person who matters to you.
      </p>

      <p>
        This data is <strong>deeply personal</strong>. And for most people,
        every bit of it sits on servers owned by Google, Apple, or Microsoft.
        Fully readable, fully analysable, and fully available to anyone
        with the right court order, the right exploit, or the right employee
        badge.
      </p>

      <h2>The problem nobody talks about</h2>

      <p>
        We have encrypted messaging now. Signal proved you could have a great
        user experience <em>and</em> end-to-end encryption. WhatsApp adopted
        the same protocol for billions. Proton built encrypted email. Bitwarden
        and 1Password encrypt your passwords.
      </p>

      <p>
        But calendars? Contacts? Tasks? The data that structures your entire
        life is still sitting unencrypted on someone else&apos;s server.
      </p>

      <ComparisonDiagram />

      <p>
        Google Calendar uses TLS in transit and encrypts data &ldquo;at
        rest&rdquo;, which means Google holds the keys. They can read every
        event. Their systems process your calendar to show you smart
        suggestions, travel times, and reminders. That processing requires
        access to unencrypted data. Apple is better: iCloud offers
        Advanced Data Protection for some categories. But calendar and
        contacts are{' '}
        <a
          href="https://support.apple.com/en-us/102651"
          target="_blank"
          rel="noopener noreferrer"
        >
          explicitly excluded from E2E encryption
        </a>{' '}
        even with ADP enabled.
      </p>

      <p>
        This isn&apos;t a theoretical risk. In 2024, a breach at a major
        calendar SaaS provider exposed scheduling data for thousands of
        organisations. Government surveillance programs have routinely targeted
        calendar and contact metadata. And data brokers don&apos;t even need a
        breach. They can infer relationships and patterns from metadata
        alone.
      </p>

      <h2>Why we started SilentSuite</h2>

      <p>
        SilentSuite exists because we believe your schedule and relationships
        deserve the same level of protection as your messages. The technology
        for this has existed for years. The{' '}
        <a
          href="https://www.etebase.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Etebase protocol
        </a>
        , created by the EteSync project, solved the hard
        cryptographic problems: zero-knowledge sync, end-to-end encrypted
        collections, conflict resolution, and offline-first architecture.
      </p>

      <p>
        But EteSync became inactive. Development stopped. The apps weren&apos;t
        updated. The server codebase stagnated. The protocol was sound, but the
        product was abandoned.
      </p>

      <p>
        So we decided to pick it up. Take the proven Etebase protocol
        and build a modern, maintained product around it. Not a weekend project
        or a hobby. A real service, with a real business model, that people can
        actually depend on.
      </p>

      <h2>What SilentSuite is</h2>

      <p>SilentSuite is encrypted sync for the rest of your digital life:</p>

      <ul>
        <li>
          <strong>Calendar:</strong> your events, encrypted before they
          leave your device
        </li>
        <li>
          <strong>Contacts:</strong> your relationships, visible only to
          you
        </li>
        <li>
          <strong>Tasks:</strong> your to-dos, your plans, nobody
          else&apos;s business
        </li>
      </ul>

      <ArchitectureDiagram />

      <p>Here&apos;s what we care about:</p>

      <h3>1. Encryption is not a feature. It&apos;s the architecture.</h3>

      <p>
        Every piece of data is encrypted on your device before it ever
        touches our server. We don&apos;t offer a toggle to &ldquo;enable
        encryption&rdquo; because there&apos;s nothing to toggle. The server
        only ever sees ciphertext. We couldn&apos;t read your data even if we
        wanted to. Or were compelled to.
      </p>

      <h3>2. Open source by default</h3>

      <p>
        Our apps and server are open source. You can read the code, audit the
        encryption, and verify our claims. Privacy promises without
        transparency are just marketing. We back ours with code.
      </p>

      <h3>3. No lock-in, ever</h3>

      <p>
        Your data is yours. Export it anytime. Self-host the server if you
        want. We use the standard Etebase protocol, not a proprietary
        format designed to keep you trapped. The way to keep
        customers is to build a great product, not to make leaving impossible.
      </p>

      <h3>4. Your Data, Your Control</h3>

      <p>
        With end-to-end encryption and zero-knowledge architecture, your data
        is protected regardless of where the server is located. We comply with
        GDPR and privacy best practices, and because the server is open source,
        you can self-host for complete data sovereignty. No third party
        &mdash; including us &mdash; can access your unencrypted data.
      </p>

      <h3>5. Sustainable business, not a hobby project</h3>

      <p>
        Too many privacy tools are side projects that disappear when the
        maintainer gets busy. SilentSuite has a real business model: a paid
        hosted service, priced fairly, that funds continued development. We
        charge enough to sustain the project, and we don&apos;t supplement
        revenue by monetising your data. We can&apos;t. It&apos;s
        encrypted.
      </p>

      <h2>Who this is for</h2>

      <p>
        SilentSuite is for people who care about privacy but don&apos;t want to
        run their own server. The &ldquo;privacy middle class&rdquo;:
        people who use Signal, who chose Proton Mail, who switched to Bitwarden,
        but who still sync their calendar through Google because there
        wasn&apos;t a good alternative.
      </p>

      <p>
        You shouldn&apos;t need a homelab and a computer science degree to keep
        your calendar private. It should be as easy as signing up and installing
        an app.
      </p>

      <h2>What happens next</h2>

      <p>
        We&apos;re in the early stages. The Etebase server is
        deployed and working. Real end-to-end encrypted sync has been tested
        successfully between devices. We&apos;re now building the client
        applications and preparing for a public beta.
      </p>

      <p>Our roadmap, roughly:</p>

      <ol>
        <li>
          <strong>Now:</strong> Server live, waitlist open, core protocol
          verified
        </li>
        <li>
          <strong>Soon:</strong> Beta client apps (starting with Android and
          web)
        </li>
        <li>
          <strong>Later:</strong> iOS app, CalDAV bridge for existing calendar
          apps, family plans
        </li>
        <li>
          <strong>Future:</strong> B2B offering for organisations that need
          compliant, encrypted PIM
        </li>
      </ol>

      <p>
        We&apos;re building this in public. We&apos;ll share progress,
        decisions, and the occasional hard lesson on this blog.
      </p>

      <hr />

      <p>
        If this sounds like something you&apos;ve been waiting for,{' '}
        <a href="/#waitlist">join the waitlist</a>. We&apos;ll notify you when
        the beta is ready. No spam. No data harvesting. Just one email when
        it&apos;s time.
      </p>

      <p>Your calendar is your life. It should be yours alone.</p>
    </>
  )
}
