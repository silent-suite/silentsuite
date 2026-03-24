import DataFlowDiagram from '../components/DataFlowDiagram'
import EncryptionComparisonDiagram from '../components/EncryptionComparisonDiagram'

export default function SilentSuiteVsGoogleCalendar() {
  return (
    <>
      <p>
        You open Google Calendar and create a new event. &ldquo;Therapy
        session, Thursday 3pm.&rdquo; You add the address. Maybe a note
        to yourself. You hit save and move on with your day.
      </p>

      <p>
        What just happened? That event was sent to Google&apos;s servers in
        plaintext. There it sits alongside every other event you&apos;ve
        created. Your job interviews. Your doctor visits. Your custody lawyer
        meetings. The recurring Saturday slot that says &ldquo;AA meeting.&rdquo;
      </p>

      <h2>What Google actually sees</h2>

      <p>
        Google Calendar processes your events in plaintext. It has to, because
        that&apos;s how features like smart suggestions, travel time estimates,
        and automatic event detection from Gmail work. Google needs to read
        your data to do these things.
      </p>

      <p>
        Event titles and descriptions. Locations. Attendees. Recurring patterns.
        When you&apos;re busy, when you&apos;re free, how your schedule shifts
        over months. All of it readable, all of it building a picture.
      </p>

      <DataFlowDiagram />

      <p>
        None of this is a secret. It&apos;s how the product works. The question
        is whether you&apos;re comfortable with the trade-off.
      </p>

      <h2>What &ldquo;encrypted at rest&rdquo; actually means</h2>

      <p>
        Google will tell you your calendar data is encrypted. And it is. Sort of.
      </p>

      <p>
        They use TLS to protect data in transit and encrypt data at rest on
        their disks. This protects against someone physically stealing a hard
        drive from a Google data centre. It does not protect your data from
        Google.
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
        whenever they need to. Every travel time notification, every suggested
        event, that&apos;s Google reading your plaintext calendar data.
      </p>

      <h2>What SilentSuite does differently</h2>

      <p>
        SilentSuite encrypts your calendar data on your device before it
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

      <EncryptionComparisonDiagram />

      <p>
        Our server stores ciphertext. Encrypted blobs that we cannot decrypt.
        Even if our servers were breached, or if we received a legal order to
        hand over your data, the result would be meaningless encrypted bytes.
      </p>

      <h2>What you give up</h2>

      <p>
        Switching to SilentSuite means losing some of Google&apos;s convenience
        features. Travel time estimates require knowing your location. Automatic
        event creation requires reading your emails. None of that is possible
        with zero-knowledge encryption.
      </p>

      <p>
        You also lose the Google ecosystem integration. No automatic Meet links,
        no pulling events from Gmail, no Assistant voice commands. This is a
        real trade-off. For some people, those features are worth more than the
        privacy cost. SilentSuite is for the people who&apos;ve made the
        opposite calculation.
      </p>

      <h2>Who should switch</h2>

      <p>
        If you already use Signal for messaging, Proton for email, and
        Bitwarden for passwords, you already understand this trade-off.
        SilentSuite fills the gap those tools leave open: your calendar,
        the thing that ties all of it together into a pattern of who you are,
        still sits on Google&apos;s servers in readable form.
      </p>

      <p>
        It&apos;s also for professionals who handle sensitive scheduling:
        lawyers, therapists, journalists, activists. And for organisations
        that need GDPR-compliant sync without trusting a US cloud provider
        with unencrypted data.
      </p>

      <hr />

      <p>
        Your schedule deserves the same protection as your messages. Not more,
        not less. If that sounds right,{' '}
        <a href="https://app.silentsuite.io/signup">get started with SilentSuite</a>. No tracking.
      </p>
    </>
  )
}
