export default function SilentSuiteVsGoogleCalendar() {
  return (
    <>
      <p>
        You open Google Calendar and create a new event. &ldquo;Therapy
        session, Thursday 3pm.&rdquo; You add the address. Maybe a note
        to yourself. You hit save and move on with your day.
      </p>

      <p>
        What just happened behind the scenes? That event, its title, location,
        time, and any notes you added, was sent over TLS to Google&apos;s
        servers. There it sits, in plaintext as far as Google is concerned,
        alongside every other event you&apos;ve created. Your job interviews.
        Your doctor visits. Your custody lawyer meetings. The recurring
        Saturday slot that says &ldquo;AA meeting.&rdquo;
      </p>

      <p>
        Google doesn&apos;t need to spy on you in some dramatic way. You hand
        them this data voluntarily, event by event, year after year.
      </p>

      <h2>What Google actually sees</h2>

      <p>
        Google Calendar processes your events in plaintext. It has to. That&apos;s
        how the product works. To give you features like smart suggestions,
        travel time estimates, and automatic event detection from Gmail, Google
        needs to read your data.
      </p>

      <p>Here&apos;s what their servers can access:</p>

      <ul>
        <li>
          <strong>Event titles and descriptions:</strong> including anything
          sensitive you type into them
        </li>
        <li>
          <strong>Locations:</strong> where you&apos;re going, how often, and
          when
        </li>
        <li>
          <strong>Attendees:</strong> who you meet with, and how frequently
        </li>
        <li>
          <strong>Recurring patterns:</strong> your weekly routines, habits,
          and commitments
        </li>
        <li>
          <strong>Time-based metadata:</strong> when you&apos;re busy, when
          you&apos;re free, how your schedule shifts over months
        </li>
      </ul>

      <p>
        None of this is a secret. It&apos;s how Google Calendar delivers its
        features. The question is whether you&apos;re comfortable with the
        trade-off.
      </p>

      <h2>What &ldquo;encrypted at rest&rdquo; actually means</h2>

      <p>
        Google will tell you your calendar data is encrypted. And it is. Sort of.
      </p>

      <p>
        Google uses TLS to protect data in transit (between your device and their
        servers) and encrypts data at rest on their disks. This protects against
        someone physically stealing a hard drive from a Google data centre. It
        does not protect your data from Google.
      </p>

      <blockquote>
        <p>
          &ldquo;Encrypted at rest&rdquo; with the provider holding the keys is
          like a hotel safe where the front desk keeps a master key. It stops
          the cleaning staff, not the hotel.
        </p>
      </blockquote>

      <p>
        Google holds the encryption keys. Their systems decrypt your data
        whenever they need to process it. Every time you get a travel time
        notification or a suggested event, that&apos;s Google reading your
        plaintext calendar data and acting on it.
      </p>

      <h2>What Google does with calendar data</h2>

      <p>
        Google{' '}
        <a
          href="https://policies.google.com/privacy"
          target="_blank"
          rel="noopener noreferrer"
        >
          states in their privacy policy
        </a>{' '}
        that they use your data to &ldquo;provide, maintain, and improve&rdquo;
        their services, and to &ldquo;develop new ones.&rdquo; Calendar data
        feeds into your Google profile alongside your search history, email,
        location data, and everything else.
      </p>

      <p>
        In 2017, Google announced they would stop scanning Gmail content for ad
        targeting. But your broader Google profile, which calendar data
        contributes to, still informs ad personalisation. If you have a recurring
        event called &ldquo;Wedding Planning&rdquo; every Saturday, Google
        knows you&apos;re planning a wedding. They don&apos;t need to scan
        that specific event to serve you wedding ads. Your profile already
        reflects the pattern.
      </p>

      <p>
        Calendar data is also available to Google Workspace administrators in
        enterprise environments, and can be produced in response to legal
        requests. Google publishes{' '}
        <a
          href="https://transparencyreport.google.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          transparency reports
        </a>{' '}
        showing they receive and comply with tens of thousands of government
        data requests each year.
      </p>

      <h2>What SilentSuite does differently</h2>

      <p>
        SilentSuite encrypts your calendar data on your device before it ever
        reaches our server. We use XChaCha20-Poly1305 authenticated encryption
        through the{' '}
        <a
          href="https://www.etebase.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Etebase protocol
        </a>
        . Your encryption keys are derived from your password on your device.
        They never leave it.
      </p>

      <p>
        Our server stores ciphertext. Encrypted blobs that we cannot decrypt.
        We don&apos;t know what your events are called, when they are, or who
        they&apos;re with. We can&apos;t build a profile from your data because
        we can&apos;t read your data.
      </p>

      <p>
        This is sometimes called &ldquo;zero-knowledge architecture.&rdquo;
        It means even if our servers were breached, or if we received a
        legal order to hand over your data, the result would be meaningless
        encrypted bytes. No event titles, no locations, no attendees. Nothing
        usable.
      </p>

      <h2>Feature comparison</h2>

      <p>
        Here&apos;s an honest side-by-side. We&apos;re not going to pretend
        we match Google on every front.
      </p>

      <ul>
        <li>
          <strong>Cross-device sync:</strong> Google Calendar: yes.
          SilentSuite: yes, end-to-end encrypted.
        </li>
        <li>
          <strong>Calendar sharing:</strong> Google Calendar: yes, with
          granular permissions. SilentSuite: yes, via encrypted shared
          collections.
        </li>
        <li>
          <strong>Offline access:</strong> Google Calendar: limited.
          SilentSuite: yes, offline-first architecture.
        </li>
        <li>
          <strong>Mobile apps:</strong> Google Calendar: Android and iOS.
          SilentSuite: Android (iOS coming).
        </li>
        <li>
          <strong>Web app:</strong> Google Calendar: yes. SilentSuite: in
          development.
        </li>
        <li>
          <strong>CalDAV support:</strong> Google Calendar: yes. SilentSuite:
          planned via encrypted bridge.
        </li>
        <li>
          <strong>Price:</strong> Google Calendar: free (you pay with data).
          SilentSuite: paid subscription.
        </li>
        <li>
          <strong>End-to-end encryption:</strong> Google Calendar: no.
          SilentSuite: yes, XChaCha20-Poly1305.
        </li>
        <li>
          <strong>Open source:</strong> Google Calendar: no. SilentSuite:
          yes, AGPL-3.0.
        </li>
        <li>
          <strong>Data location:</strong> Google Calendar: global (primarily
          US). SilentSuite: EU.
        </li>
        <li>
          <strong>Data export:</strong> Google Calendar: yes, via Google
          Takeout. SilentSuite: yes, standard formats.
        </li>
        <li>
          <strong>Smart features:</strong> Google Calendar: yes (travel time,
          suggested events, room booking). SilentSuite: no.
        </li>
      </ul>

      <h2>What you give up</h2>

      <p>
        We&apos;re not going to sugarcoat this. Switching to SilentSuite means
        losing some features that make Google Calendar convenient.
      </p>

      <p>
        Google&apos;s smart features exist because Google reads your data.
        Travel time estimates require knowing your location and destination.
        Automatic event creation from emails requires reading your emails.
        Room booking suggestions require access to your organisation&apos;s
        directory. None of these are possible with zero-knowledge encryption.
      </p>

      <p>
        You also give up the deep integration with the Google ecosystem. No
        automatic links to Google Meet. No pulling events from Gmail. No Google
        Assistant voice commands to check your schedule.
      </p>

      <p>
        This is a real trade-off. For some people, those features are worth
        more than the privacy cost. We respect that. SilentSuite is for the
        people who&apos;ve made the opposite calculation.
      </p>

      <h2>Who should switch</h2>

      <p>
        If you already use Signal for messaging, Proton for email, and
        Bitwarden for passwords, you already understand the trade-off between
        convenience and privacy. You&apos;ve made that choice before.
        SilentSuite fills the gap those tools leave open.
      </p>

      <p>
        You have end-to-end encrypted messages. Encrypted email. Encrypted
        passwords. But your calendar, the thing that ties all of it together
        into a pattern of who you are, still sits on Google&apos;s servers in
        readable form. That&apos;s the piece we&apos;re fixing.
      </p>

      <p>
        SilentSuite is also for professionals who handle sensitive scheduling.
        Lawyers, therapists, journalists, activists, anyone whose calendar
        could be used against them or their clients. And it&apos;s for
        organisations in the EU that need GDPR-compliant sync without
        trusting a US cloud provider with unencrypted data.
      </p>

      <hr />

      <p>
        We&apos;re building SilentSuite because we think your schedule
        deserves the same protection as your messages. Not more, not less.
        Just the same standard that Signal set for chat, applied to your
        calendar, contacts, and tasks.
      </p>

      <p>
        If that sounds right to you,{' '}
        <a href="/#waitlist">join the waitlist</a>. We&apos;ll let you know
        when the beta is ready. One email, no tracking, no data harvesting.
      </p>

      <p>
        Your schedule is nobody&apos;s business but yours.
      </p>
    </>
  )
}
