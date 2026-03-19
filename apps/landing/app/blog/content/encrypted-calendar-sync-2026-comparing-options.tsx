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

      <h2>Proton Calendar</h2>

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

      <h2>Tuta Calendar</h2>

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

      <h2>EteSync</h2>

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

      <h2>Nextcloud with E2EE</h2>

      <p>
        Nextcloud is the go-to self-hosted solution for a lot of
        privacy-conscious users, and understandably so. It supports CalDAV,
        which means you can use it with almost any calendar app. The ecosystem
        is huge. You own the server.
      </p>

      <p>
        But here&apos;s the thing people get wrong about Nextcloud and
        encryption: Nextcloud does offer end-to-end encryption for{' '}
        <em>files</em>. It does <strong>not</strong> offer E2EE for calendar
        or contacts data. Your events are stored in plaintext on your
        Nextcloud server. If someone compromises that server, they read your
        calendar. Full stop.
      </p>

      <p>
        This is not a criticism of Nextcloud. They&apos;re solving a different
        problem and doing it well. But we see people assume that
        &ldquo;Nextcloud + E2EE&rdquo; means everything is encrypted, and
        that&apos;s simply not the case for PIM data.
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

      <h2>SilentSuite</h2>

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

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9em' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid rgba(255,255,255,0.2)' }}>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>&nbsp;</th>
              <th style={{ textAlign: 'center', padding: '8px 12px' }}>Proton Calendar</th>
              <th style={{ textAlign: 'center', padding: '8px 12px' }}>Tuta Calendar</th>
              <th style={{ textAlign: 'center', padding: '8px 12px' }}>EteSync</th>
              <th style={{ textAlign: 'center', padding: '8px 12px' }}>Nextcloud</th>
              <th style={{ textAlign: 'center', padding: '8px 12px' }}>SilentSuite</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['E2EE calendar', 'Yes', 'Yes', 'Yes', 'No', 'Yes'],
              ['E2EE contacts', 'Partial', 'Partial', 'Yes', 'No', 'Yes'],
              ['E2EE tasks', 'No', 'No', 'Yes', 'No', 'Yes'],
              ['CalDAV support', 'No', 'No', 'Via bridge', 'Yes', 'Planned'],
              ['Mobile apps', 'Yes', 'Yes', 'Outdated', 'Via 3rd party', 'In development'],
              ['Web app', 'Yes', 'Yes', 'Outdated', 'Yes', 'In development'],
              ['Self-hostable', 'No', 'No', 'Yes', 'Yes', 'Yes'],
              ['Open source', 'Partial', 'Yes', 'Yes', 'Yes', 'Yes (AGPL-3.0)'],
              ['Status', 'Active', 'Active', 'Abandoned', 'Active', 'Active'],
              ['Price', 'Free / from \u20ac4/mo', 'Free / from \u20ac3/mo', 'Was \u20ac2/mo', 'Self-host cost', 'TBD'],
            ].map(([feature, proton, tuta, etesync, nextcloud, silent]) => (
              <tr
                key={feature}
                style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}
              >
                <td style={{ padding: '8px 12px', fontWeight: 600 }}>{feature}</td>
                <td style={{ textAlign: 'center', padding: '8px 12px' }}>{proton}</td>
                <td style={{ textAlign: 'center', padding: '8px 12px' }}>{tuta}</td>
                <td style={{ textAlign: 'center', padding: '8px 12px' }}>{etesync}</td>
                <td style={{ textAlign: 'center', padding: '8px 12px' }}>{nextcloud}</td>
                <td style={{ textAlign: 'center', padding: '8px 12px' }}>{silent}</td>
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
        We&apos;re not asking you to switch today. We&apos;re still building.
        What we are asking is this: if encrypted calendar sync matters to you,{' '}
        <a href="/#waitlist">join our waitlist</a>. It helps us understand
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
