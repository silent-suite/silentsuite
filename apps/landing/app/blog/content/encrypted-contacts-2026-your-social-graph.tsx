type Brand = 'google' | 'apple' | 'proton' | 'tuta' | 'nextcloud' | 'etesync' | 'silentsuite'

const brandColor: Record<Brand, string> = {
  google: '#4285F4',
  apple: '#A1A1A6',
  proton: '#6D28D9',
  tuta: '#DC2626',
  nextcloud: '#0284C7',
  etesync: '#64748B',
  silentsuite: '#34d399',
}

function BrandHeader({ brand, label, sub }: { brand: Brand; label: string; sub?: string }) {
  const color = brandColor[brand]
  return (
    <div className="flex items-center gap-4 mt-12 mb-4">
      <div
        className="w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0 border"
        style={{ backgroundColor: `${color}1A`, borderColor: `${color}66` }}
      >
        <span style={{ color }} className="text-lg font-bold">
          {label[0]}
        </span>
      </div>
      <div>
        <h2 className="!mt-0 !mb-0">{label}</h2>
        {sub ? <div className="text-sm text-navy-400 mt-1">{sub}</div> : null}
      </div>
    </div>
  )
}

function cellClass(value: string): string {
  const v = value.trim().toLowerCase()
  if (v === 'yes' || v === 'yes*' || v.startsWith('yes ') || v === 'active') {
    return 'bg-teal-400/15 text-teal-300 font-semibold'
  }
  if (v === 'no' || v === 'abandoned' || v === 'outdated') {
    return 'bg-red-500/15 text-red-300 font-semibold'
  }
  if (v === 'partial' || v.startsWith('via ') || v === 'limited' || v === 'planned') {
    return 'bg-amber-500/15 text-amber-300 font-semibold'
  }
  return 'text-navy-300'
}

export default function EncryptedContacts2026YourSocialGraph() {
  return (
    <>
      <p>
        SilentSuite is an open-source, end-to-end encrypted contacts sync,
        built on the same{' '}
        <a
          href="https://www.etebase.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Etebase protocol
        </a>{' '}
        as our calendar and tasks. Names, numbers, addresses, and birthdays
        are encrypted on your device before they reach our server.
        Hosted from &euro;3/mo, AGPL-3.0 self-hostable, EU infrastructure,
        CardDAV available through our standalone bridge.
      </p>

      <p>
        Most people don&apos;t think of their contacts list as sensitive data.
        It&apos;s &ldquo;just names and phone numbers.&rdquo; That framing is
        a mistake we want to spend the next few minutes unpicking, alongside
        an honest look at what the major contacts services actually do with
        your data.
      </p>

      <h2>Why your contacts list is a graph of your life</h2>

      <p>
        Your address book is the most concentrated piece of social
        intelligence you carry around. It&apos;s not just names. For each
        person it usually has: phone numbers, email addresses, home address,
        sometimes a photo, sometimes a birthday, often the company they work
        for, often a relationship label (&ldquo;Mom,&rdquo;
        &ldquo;Therapist,&rdquo; &ldquo;Lawyer&rdquo;), and a date when you
        first added them.
      </p>

      <p>
        Aggregate that across a few hundred entries and you have a portrait
        of someone&apos;s life that&apos;s harder to assemble from any other
        single dataset. Who they trust enough to label as family. Who their
        doctor is. Whether they have a divorce lawyer. The clinics they
        visit. The names of every ex-colleague they didn&apos;t cut ties
        with. The phone number patterns of every country they&apos;ve lived
        in.
      </p>

      <p>
        This is why contact-list access is the most-requested permission in
        every advertising SDK. It&apos;s why nation-state intelligence
        agencies have prioritized phone-book metadata for two decades. It is,
        functionally, a map of who you are.
      </p>

      <p>
        And almost nobody encrypts it.
      </p>

      <BrandHeader brand="google" label="Google Contacts" sub="Google, USA" />

      <p>
        <a
          href="https://contacts.google.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Google Contacts
        </a>{' '}
        is the default for anyone with an Android phone or Gmail account. It
        is <strong>not end-to-end encrypted</strong>. Google can read every
        contact on your list and uses that data for service features like
        smart compose, automatic relationship inference, and ad targeting on
        the rest of Google&apos;s surface.
      </p>

      <p>
        Google Contacts also pulls metadata about who you communicate with,
        when, and how often. It is one of the most data-rich services Google
        runs, and it sits in plaintext on infrastructure designed for
        machine-readable processing.
      </p>

      <BrandHeader brand="apple" label="iCloud Contacts" sub="Apple, USA" />

      <p>
        <a
          href="https://www.apple.com/icloud/"
          target="_blank"
          rel="noopener noreferrer"
        >
          iCloud Contacts
        </a>{' '}
        is closer to encrypted, but with caveats. By default, Apple holds
        the encryption keys to your contacts. With{' '}
        <a
          href="https://support.apple.com/en-us/HT212520"
          target="_blank"
          rel="noopener noreferrer"
        >
          Advanced Data Protection for iCloud
        </a>{' '}
        enabled, contacts become end-to-end encrypted with keys you control.
      </p>

      <p>
        Advanced Data Protection is opt-in, off by default, requires you to
        set up a recovery contact or printed recovery key, and is not
        available in some jurisdictions. It also doesn&apos;t apply if you
        sync contacts to non-Apple clients via the limited iCloud CardDAV
        endpoint, because Apple has to decrypt to serve those clients.
      </p>

      <BrandHeader brand="proton" label="Proton Contacts" sub="Proton, Switzerland" />

      <p>
        <a
          href="https://proton.me/mail/contacts"
          target="_blank"
          rel="noopener noreferrer"
        >
          Proton
        </a>{' '}
        encrypts contact data, but only the so-called &ldquo;sensitive&rdquo;
        fields (notes, birthdays, custom fields). Names, email addresses, and
        phone numbers, the fields most people would consider the actual
        identity of a contact, are stored unencrypted so that Proton Mail can
        autocomplete recipients, route messages, and search.
      </p>

      <p>
        This is a reasonable engineering trade-off, but it&apos;s worth being
        honest that Proton Contacts is partial encryption, not full E2EE.
        Proton can see who is in your address book. They just can&apos;t see
        the notes you wrote about them.
      </p>

      <BrandHeader brand="tuta" label="Tuta Contacts" sub="Tuta, Germany" />

      <p>
        <a
          href="https://tuta.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Tuta
        </a>{' '}
        encrypts more contact fields than Proton, including names. Their
        encryption applies inside Tuta&apos;s own apps. There&apos;s no
        CardDAV, no third-party sync, no integration with the contacts app
        on your phone or laptop. If you live in Tuta&apos;s ecosystem this
        is fine. If you don&apos;t, the data is functionally trapped.
      </p>

      <BrandHeader brand="nextcloud" label="Nextcloud Contacts" sub="Self-hosted CardDAV" />

      <p>
        <a
          href="https://nextcloud.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Nextcloud
        </a>{' '}
        is the most popular self-hosted CardDAV server. It works with every
        standard contacts app: macOS, iOS, Android (via DAVx5), Thunderbird,
        Outlook. The catch: contacts are stored in plaintext in the
        Nextcloud database.
      </p>

      <p>
        If you self-host on a box only you can access, that&apos;s a perfectly
        defensible privacy posture. Nobody else has the keys to your house, so
        nobody else gets to read your address book. If you use a hosted
        Nextcloud provider, your contacts are sitting in plaintext on someone
        else&apos;s server, which is a different threat model entirely.
      </p>

      <BrandHeader brand="etesync" label="EteSync" sub="The encrypted option that stalled" />

      <p>
        EteSync was, until recently, the only mainstream service offering
        true end-to-end encrypted contacts that worked across platforms. The{' '}
        <a
          href="https://www.etebase.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Etebase protocol
        </a>{' '}
        encrypts the entire vCard payload before it leaves your device. The
        server stores ciphertext only.
      </p>

      <p>
        It still does, technically. But the apps and server haven&apos;t
        seen meaningful updates in some time. We covered the situation in
        more detail in our post on{' '}
        <a href="/blog/looking-for-an-etesync-alternative">
          why we picked the project up as SilentSuite
        </a>
        .
      </p>

      <BrandHeader brand="silentsuite" label="SilentSuite Contacts" sub="Maintained Etebase, EU-hosted" />

      <div className="my-8 p-6 sm:p-8 rounded-2xl border border-teal-400/30 bg-gradient-to-br from-teal-400/10 to-navy-900/40 not-prose">
        <div className="flex items-start gap-4 mb-4">
          <div className="w-14 h-14 rounded-xl bg-teal-400/10 border border-teal-400/30 flex items-center justify-center flex-shrink-0">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="#34d399"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-7 h-7"
              aria-hidden="true"
            >
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 11l-3 3-2-2" />
            </svg>
          </div>
          <div>
            <div className="text-white font-bold text-xl leading-tight">
              SilentSuite Contacts
            </div>
            <div className="text-navy-300 text-sm mt-1">
              All fields encrypted. Names, numbers, notes, photos. Server
              cannot read any of it. CardDAV-compatible via the standalone
              bridge.
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            'Full vCard E2EE',
            'Open source (AGPL-3.0)',
            'CardDAV via bridge',
            'EU-hosted',
            'From €3/mo',
          ].map((tag) => (
            <span
              key={tag}
              className="text-xs px-3 py-1 rounded-full bg-teal-400/10 text-teal-300 border border-teal-400/30"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>

      <p>
        SilentSuite encrypts the entire vCard, not just the &ldquo;sensitive
        fields.&rdquo; Names, numbers, addresses, photos, custom fields, the
        relationships you draw between people, all of it ciphertext on our
        server. We don&apos;t need to read your address book to deliver the
        sync, so we don&apos;t.
      </p>

      <p>
        Because we share the Etebase protocol with EteSync, contact lists
        migrate from EteSync to SilentSuite without rebuilding from scratch.
        And because we ship a standalone CalDAV/CardDAV bridge, your
        encrypted contacts also appear in the system contacts app on macOS,
        iOS (via Apple Contacts), Thunderbird, and any DAV-compatible client.
      </p>

      <h2>Comparison table</h2>

      <p>
        Here&apos;s how the major contacts services compare on encryption,
        openness, and integration. As always, if we&apos;ve gotten something
        wrong, tell us.
      </p>

      <div className="not-prose overflow-x-auto my-6 rounded-xl border border-navy-700/60">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-navy-900/60">
            <tr>
              <th className="text-left p-3 font-semibold text-navy-300 border-b border-navy-700">
                &nbsp;
              </th>
              {[
                { key: 'google', label: 'Google' },
                { key: 'apple', label: 'iCloud' },
                { key: 'proton', label: 'Proton' },
                { key: 'tuta', label: 'Tuta' },
                { key: 'nextcloud', label: 'Nextcloud' },
                { key: 'etesync', label: 'EteSync' },
                { key: 'silentsuite', label: 'SilentSuite' },
              ].map(({ key, label }) => (
                <th
                  key={key}
                  className="text-center p-3 border-b border-navy-700"
                >
                  <div className="flex flex-col items-center gap-1.5">
                    <div
                      className="w-9 h-9 rounded-md flex items-center justify-center text-base font-bold border"
                      style={{
                        backgroundColor: `${brandColor[key as Brand]}1A`,
                        borderColor: `${brandColor[key as Brand]}66`,
                        color: brandColor[key as Brand],
                      }}
                    >
                      {label[0]}
                    </div>
                    <span className="text-xs font-semibold text-white whitespace-nowrap">
                      {label}
                    </span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              ['E2EE all fields', 'No', 'Partial', 'Partial', 'Yes', 'No', 'Yes', 'Yes'],
              ['Names readable to server', 'Yes', 'Partial', 'Yes', 'No', 'Yes', 'No', 'No'],
              ['CardDAV support', 'No', 'Partial', 'No', 'No', 'Yes', 'Via bridge', 'Yes*'],
              ['Cross-platform', 'Yes', 'Limited', 'Limited', 'Limited', 'Yes', 'Yes', 'Yes'],
              ['Open source', 'No', 'No', 'Partial', 'Yes', 'Yes', 'Yes', 'Yes'],
              ['Self-hostable', 'No', 'No', 'No', 'No', 'Yes', 'Yes', 'Yes'],
              ['Status', 'Active', 'Active', 'Active', 'Active', 'Active', 'Abandoned', 'Active'],
              ['Price', 'Free', 'Bundled with iCloud', 'Free / from €4/mo', 'Free / from €3/mo', 'Self-host cost', 'Was €2/mo', 'From €3/mo'],
            ].map(([feature, ...values], rowIdx) => (
              <tr
                key={feature}
                className={rowIdx % 2 === 0 ? 'bg-navy-900/20' : 'bg-transparent'}
              >
                <td className="p-3 font-semibold text-white border-t border-navy-700/50">
                  {feature}
                </td>
                {values.map((val, i) => (
                  <td
                    key={i}
                    className={`text-center p-3 border-t border-navy-700/50 ${cellClass(val)}`}
                  >
                    {val}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p>
        <em>
          &ldquo;Partial&rdquo; for iCloud means E2EE only with Advanced Data
          Protection enabled. &ldquo;Partial&rdquo; for Proton means
          encryption applied to notes/custom fields but not to names/numbers.
        </em>
      </p>

      <p>
        <em>
          * SilentSuite contacts sync over Etebase natively. CardDAV for
          third-party clients (Apple Contacts, Thunderbird, DAVx5) goes
          through our standalone bridge.
        </em>
      </p>

      <h2>Why is CardDAV hard to encrypt end-to-end?</h2>

      <p>
        CardDAV was designed in the early 2000s by Apple and the IETF as a
        standard way to read and write vCards over HTTP. It assumes the
        server can parse, search, and merge contact entries. To do those
        things, the server needs the data in plaintext. End-to-end encryption
        is fundamentally incompatible with that design, which is why
        Nextcloud (and every other vanilla CardDAV server) stores contacts
        unencrypted.
      </p>

      <p>
        The way around this is to do the sync at a different layer. The
        Etebase protocol that SilentSuite and EteSync use treats each
        collection as opaque encrypted blobs. The server doesn&apos;t parse
        vCards. It just stores and serves ciphertext. CardDAV compatibility
        is provided by a local bridge running on the client, which decrypts
        the blobs and exposes a CardDAV endpoint that standard contacts apps
        can talk to.
      </p>

      <p>
        It&apos;s a more complex architecture, but it&apos;s the only one
        that gives you both real E2EE and compatibility with the system
        contacts app on macOS, iOS, and Thunderbird.
      </p>

      <h2>How do I migrate from Google Contacts?</h2>

      <ol>
        <li>
          <strong>Export from Google.</strong> Go to{' '}
          <a
            href="https://contacts.google.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            contacts.google.com
          </a>
          , select the contacts you want to take, and export as vCard
          (<code>.vcf</code>).
        </li>
        <li>
          <strong>Sign up for SilentSuite</strong> at{' '}
          <a href="https://app.silentsuite.io/signup">app.silentsuite.io/signup</a>
          .
        </li>
        <li>
          <strong>Import the .vcf file</strong> from the SilentSuite web
          client. The file is decrypted client-side and re-encrypted under
          your SilentSuite key before the server sees it.
        </li>
        <li>
          <strong>Connect your devices.</strong> On Android, install the
          SilentSuite app. On Apple devices and Thunderbird, install the
          standalone bridge and connect with your account.
        </li>
        <li>
          <strong>Remove Google Contacts as the source of truth</strong> on
          your phone (Android: Settings &rarr; Accounts &rarr; Google &rarr;
          uncheck Contacts sync).
        </li>
      </ol>

      <h2>FAQ</h2>

      <p>
        <strong>Is Google Contacts end-to-end encrypted?</strong>
        <br />
        No. Google holds the keys and processes contacts in plaintext.
      </p>

      <p>
        <strong>Is iCloud Contacts end-to-end encrypted?</strong>
        <br />
        Only with Advanced Data Protection enabled, which is opt-in and
        unavailable in some regions.
      </p>

      <p>
        <strong>Is Proton Contacts end-to-end encrypted?</strong>
        <br />
        Partially. Proton encrypts notes and custom fields. Names, email
        addresses, and phone numbers are stored unencrypted so Proton Mail
        can use them.
      </p>

      <p>
        <strong>Can I use SilentSuite contacts in Apple Contacts or Thunderbird?</strong>
        <br />
        Yes, through our standalone CardDAV bridge. The bridge decrypts
        locally and exposes your contacts to standard apps.
      </p>

      <p>
        <strong>Does SilentSuite support vCard import and export?</strong>
        <br />
        Yes. Standard <code>.vcf</code> files in and out, no lock-in. Useful
        for migrating in from Google or out to wherever you want to go next.
      </p>

      <hr />

      <p>
        Your address book deserves the same level of protection as your
        messages. It usually doesn&apos;t get it.{' '}
        <a href="https://app.silentsuite.io/signup">
          Sign up for SilentSuite
        </a>{' '}
        if you want contacts your provider literally cannot read.
      </p>
    </>
  )
}
