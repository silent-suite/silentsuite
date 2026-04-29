type LogoKey = 'proton' | 'tuta' | 'nextcloud' | 'etesync' | 'silentsuite'

function BrandHeader({ logo, name, label }: { logo: LogoKey; name: string; label: string }) {
  const ext = logo === 'etesync' ? 'png' : 'svg'
  return (
    <div className="flex items-center gap-4 mt-12 mb-4">
      <div className="w-12 h-12 rounded-lg bg-white p-2 flex items-center justify-center flex-shrink-0">
        <img
          src={`/blog/logos/${logo}.${ext}`}
          alt={`${name} logo`}
          className="w-full h-full object-contain"
        />
      </div>
      <h2 className="!mt-0 !mb-0">{label}</h2>
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
  if (
    v === 'partial' ||
    v.startsWith('via ') ||
    v === 'in development' ||
    v === 'planned'
  ) {
    return 'bg-amber-500/15 text-amber-300 font-semibold'
  }
  return 'text-navy-300'
}

export default function EncryptedCalendarSync2026ComparingOptions() {
  return (
    <>
      <p>
        Here&apos;s the good news: in 2026, there are multiple services that
        offer some form of encrypted calendar sync. Five years ago, you could
        count them on one finger. The space has grown.
      </p>

      <p>
        The bad news? Most of these options are incomplete, locked into a
        specific ecosystem, or simply abandoned. If you&apos;ve spent any time
        trying to find a proper encrypted replacement for Google Calendar, you
        know the frustration. Things look promising on the surface, then you
        dig in and find deal-breaking limitations.
      </p>

      <p>
        We wanted to write an honest comparison. Not a marketing piece where
        we trash the competition and declare ourselves the winner. Just a
        clear-eyed look at what exists, what works, and what doesn&apos;t.
      </p>

      <BrandHeader logo="proton" name="Proton" label="Proton Calendar" />

      <p>
        <a
          href="https://proton.me/calendar"
          target="_blank"
          rel="noopener noreferrer"
        >
          Proton Calendar
        </a>{' '}
        is the most well-known option. It&apos;s end-to-end encrypted and comes
        bundled with Proton Mail. If you&apos;re already paying for Proton
        Unlimited, you get it included. The encryption is real. Proton cannot
        read your events. That matters.
      </p>

      <p>
        But Proton Calendar has significant limitations for anyone who wants
        calendar sync as a standalone tool. There&apos;s no CalDAV support,
        which means you can&apos;t use it with third-party calendar apps. You
        are limited to Proton&apos;s own web app and mobile apps. No desktop
        client. No integration with the calendar tools you might already use.
      </p>

      <p>
        Contacts sync? Only within Proton&apos;s own apps. Tasks? Not
        supported. It&apos;s a calendar and only a calendar, tightly bound to
        the Proton ecosystem. If you live entirely inside Proton, this works
        fine. If you don&apos;t, you&apos;ll hit walls quickly.
      </p>

      <BrandHeader logo="tuta" name="Tuta" label="Tuta Calendar" />

      <p>
        <a
          href="https://tuta.com/calendar"
          target="_blank"
          rel="noopener noreferrer"
        >
          Tuta
        </a>{' '}
        (formerly Tutanota) offers encrypted calendar as part of their email
        service. Like Proton, the encryption is genuine. Your events are
        encrypted before they reach Tuta&apos;s servers.
      </p>

      <p>
        The limitations are similar to Proton&apos;s. No CalDAV. No
        third-party app support. Calendar sharing is limited. No contacts or
        tasks sync outside their own app. Tuta has built a solid encrypted
        email product, but their calendar remains a secondary feature with a
        narrow scope.
      </p>

      <p>
        Both Proton and Tuta deserve credit for shipping encrypted calendars at
        all. Most companies never even try. But both treat the calendar as an
        add-on to email rather than a first-class product.
      </p>

      <BrandHeader logo="etesync" name="EteSync" label="EteSync" />

      <p>
        <a
          href="https://www.etesync.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          EteSync
        </a>{' '}
        was the original. It did exactly what many of us wanted: end-to-end
        encrypted sync for calendars, contacts, and tasks using the{' '}
        <a
          href="https://www.etebase.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Etebase protocol
        </a>
        . The protocol is genuinely well-designed. Zero-knowledge
        architecture, proper key management, conflict resolution, offline
        support. The cryptographic foundations are sound.
      </p>

      <p>
        The problem is that EteSync stopped being maintained. The apps
        haven&apos;t been updated. The server codebase stagnated. The Android
        app still works for some users, but it&apos;s not receiving fixes or
        improvements. The web client is outdated. For a tool that handles your
        daily schedule, &ldquo;it still kind of works&rdquo; isn&apos;t good
        enough.
      </p>

      <p>
        This is actually where SilentSuite comes from. We forked EteSync
        because the protocol deserved a maintained product around it. More on
        that below.
      </p>

      <BrandHeader logo="nextcloud" name="Nextcloud" label="Nextcloud with E2EE" />

      <p>
        Nextcloud is the go-to self-hosted solution for a lot of
        privacy-conscious users, and understandably so. It supports CalDAV,
        which means you can use it with almost any calendar app. The ecosystem
        is huge. You own the server.
      </p>

      <p>
        Here&apos;s the nuance people often miss about Nextcloud and
        encryption: Nextcloud does offer end-to-end encryption for{' '}
        <em>files</em>. It does <strong>not</strong> offer E2EE for calendar
        or contacts data. Your events are stored in plaintext in the database
        on whichever server runs Nextcloud.
      </p>

      <p>
        If you self-host Nextcloud yourself, on a box only you can access,
        that&apos;s actually a pretty solid privacy story. Nobody else has the
        keys to the building, so nobody else gets to read the events sitting in
        the database. For a lot of people, that&apos;s good enough.
      </p>

      <p>
        Where it gets shakier is the hosted Nextcloud route, where a third
        party runs the server for you. Now &ldquo;in plaintext on the
        server&rdquo; means in plaintext on{' '}
        <em>their</em> server. A breach, a rogue admin, a misconfigured backup,
        or a legal request, and your calendar is readable. The CalDAV protocol
        and the underlying database simply weren&apos;t designed for E2EE.
      </p>

      <p>
        This isn&apos;t a criticism of Nextcloud. They&apos;re solving a
        different problem and doing it well. But we see people assume that
        &ldquo;Nextcloud + E2EE&rdquo; means everything is encrypted, and
        that&apos;s only true if you also happen to control the server it runs
        on.
      </p>

      <h2>Skiff: a cautionary tale</h2>

      <p>
        Worth mentioning briefly:{' '}
        <a
          href="https://en.wikipedia.org/wiki/Skiff_(company)"
          target="_blank"
          rel="noopener noreferrer"
        >
          Skiff
        </a>{' '}
        offered encrypted calendar (alongside email and documents) and looked
        promising. Then Notion acquired them in early 2024 and shut the whole
        thing down. Users had six months to export their data and move on.
      </p>

      <p>
        This is the risk with VC-funded privacy tools. The incentives
        don&apos;t always align with long-term operation. When the acquirer
        doesn&apos;t care about your encrypted calendar product, it just
        disappears. Something to consider when choosing where to put your
        trust.
      </p>

      <BrandHeader logo="silentsuite" name="SilentSuite" label="SilentSuite" />

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
              <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
            </svg>
          </div>
          <div>
            <div className="text-white font-bold text-xl leading-tight">
              SilentSuite
            </div>
            <div className="text-navy-300 text-sm mt-1">
              End-to-end encrypted calendar, contacts, and tasks. Built on the
              Etebase protocol.
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            'E2EE by default',
            'Open source (AGPL-3.0)',
            'Self-hostable',
            'EU-hosted',
            'No tracking',
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
        This is what we&apos;re building. We should be transparent about our
        bias here: this is our project, and we obviously believe in it. But
        we&apos;ll try to be straightforward about what we offer and where we
        currently stand.
      </p>

      <p>
        SilentSuite is a fork of EteSync, built on the Etebase protocol. Full
        end-to-end encryption for calendars, contacts, and tasks. The server
        never sees your data in plaintext. Our code is open source under
        AGPL-3.0. Servers are hosted on GDPR-compliant EU infrastructure.
      </p>

      <p>
        We offer a paid hosted service (because that&apos;s how you sustain
        a product without selling data) and a self-host option for people who
        want full control. The Etebase protocol means your data isn&apos;t
        locked into our service. You can export it. You can run your own
        server.
      </p>

      <p>
        Honestly, we&apos;re still early. We don&apos;t have feature parity
        with Google Calendar and we&apos;re not pretending to. What we do have
        is a working encrypted sync layer, active development, and a clear
        roadmap. We&apos;re building the client apps now.
      </p>

      <h2>Comparison table</h2>

      <p>
        Here&apos;s how everything stacks up. We&apos;ve tried to be fair.
        If we&apos;ve gotten something wrong, let us know.
      </p>

      <div className="not-prose overflow-x-auto my-6 rounded-xl border border-navy-700/60">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-navy-900/60">
            <tr>
              <th className="text-left p-3 font-semibold text-navy-300 border-b border-navy-700">
                &nbsp;
              </th>
              {[
                { logo: 'proton', label: 'Proton', ext: 'svg' },
                { logo: 'tuta', label: 'Tuta', ext: 'svg' },
                { logo: 'etesync', label: 'EteSync', ext: 'png' },
                { logo: 'nextcloud', label: 'Nextcloud', ext: 'svg' },
                { logo: 'silentsuite', label: 'SilentSuite', ext: 'svg' },
              ].map(({ logo, label, ext }) => (
                <th
                  key={logo}
                  className="text-center p-3 border-b border-navy-700"
                >
                  <div className="flex flex-col items-center gap-1.5">
                    <div className="w-9 h-9 rounded-md bg-white p-1.5 flex items-center justify-center">
                      <img
                        src={`/blog/logos/${logo}.${ext}`}
                        alt={`${label} logo`}
                        className="w-full h-full object-contain"
                      />
                    </div>
                    <span className="text-xs font-semibold text-white">
                      {label}
                    </span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              ['E2EE calendar', 'Yes', 'Yes', 'Yes', 'No', 'Yes'],
              ['E2EE contacts', 'Partial', 'Partial', 'Yes', 'No', 'Yes'],
              ['E2EE tasks', 'No', 'No', 'Yes', 'No', 'Yes'],
              ['CalDAV support', 'No', 'No', 'Via bridge', 'Yes', 'Yes*'],
              ['Mobile apps', 'Yes', 'Yes', 'Outdated', 'Via 3rd party', 'Yes*'],
              ['Web app', 'Yes', 'Yes', 'Outdated', 'Yes', 'Yes'],
              ['Self-hostable', 'No', 'No', 'Yes', 'Yes', 'Yes'],
              ['Open source', 'Partial', 'Yes', 'Yes', 'Yes', 'Yes (AGPL-3.0)'],
              ['Status', 'Active', 'Active', 'Abandoned', 'Active', 'Active'],
              ['Price', 'Free / from \u20ac4/mo', 'Free / from \u20ac3/mo', 'Was \u20ac2/mo', 'Self-host cost', 'From \u20ac3/mo'],
            ].map(([feature, ...values], rowIdx) => (
              <tr
                key={feature}
                className={
                  rowIdx % 2 === 0 ? 'bg-navy-900/20' : 'bg-transparent'
                }
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
          &ldquo;Partial&rdquo; for Proton/Tuta contacts means encrypted
          contacts exist within their own apps, but there&apos;s no sync
          protocol you can use with external clients.
        </em>
      </p>

      <p>
        <em>
          * SilentSuite: Android is native, CalDAV works through our standalone
          bridge for Apple Calendar and Thunderbird, and iOS still works with
          the original EteSync app since we share the Etebase protocol.
        </em>
      </p>

      <h2>The honest take</h2>

      <p>
        If you&apos;re already in the Proton ecosystem, Proton Calendar is a
        reasonable choice. Same goes for Tuta. They&apos;re real companies
        with real encryption, and for many users the walled-garden trade-off is
        acceptable. You get a working encrypted calendar as part of a bundle
        you&apos;re already paying for. That&apos;s not nothing.
      </p>

      <p>
        But if you want encrypted sync for calendars, contacts, <em>and</em>{' '}
        tasks, with open-source code you can audit, a protocol you can
        self-host, and no lock-in to a specific email provider? The options are
        thin. EteSync proved the concept and then went quiet. Nextcloud
        doesn&apos;t encrypt PIM data. Skiff got acquired out of existence.
      </p>

      <p>
        That gap is exactly why SilentSuite exists. We took a proven protocol
        from a project that stalled and are building a maintained, sustainable
        product around it. Not because the other options are bad, but because
        none of them do the specific thing we needed.
      </p>

      <h2>What we&apos;re asking</h2>

      <p>
        If encrypted calendar sync matters to you,{' '}
        <a href="https://app.silentsuite.io/signup">get started with SilentSuite</a>. It helps us understand
        demand, plan capacity, and prioritize features.
      </p>

      <p>
        We&apos;ll send you one email when the beta opens. That&apos;s it. No
        newsletter spam. No growth-hack drip campaigns.
      </p>

      <p>
        Your schedule, your contacts, your tasks. Encrypted. Open source.
        Yours.
      </p>
    </>
  )
}
