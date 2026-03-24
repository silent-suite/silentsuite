import PrivacySpectrumDiagram from '../components/PrivacySpectrumDiagram'
import KeyHolderDiagram from '../components/KeyHolderDiagram'
import ChecklistGraphic from '../components/ChecklistGraphic'

export default function WhoCanReadYourCalendar() {
  return (
    <>
      <p>
        Your calendar is more revealing than your email. Email captures
        conversations, but your calendar captures <em>behaviour</em>. When you
        wake up. When you see your therapist. Who you meet for lunch. The
        flights you book. The recurring calls with your lawyer.
      </p>

      <p>
        A single month of calendar data paints a detailed picture of
        someone&apos;s life: habits, relationships, health signals, work
        patterns. All structured, timestamped, and easy to query.
      </p>

      <p>
        Most people never ask who else can read this data. So we checked. Here&apos;s
        what the major calendar providers actually do with it.
      </p>

      <PrivacySpectrumDiagram />

      <h2>The Big Three: Google, Apple, Microsoft</h2>

      <p>
        Google Calendar, Apple Calendar (iCloud), and Microsoft Outlook all
        follow the same model: TLS encryption in transit, encryption at rest
        on their servers, and <strong>the provider holds the keys</strong>.
        That last part is what matters. It means they can decrypt and read your
        events whenever they need to.
      </p>

      <p>
        And they do need to. Google processes your calendar for smart
        suggestions, travel times, and event parsing from Gmail. Microsoft&apos;s
        Copilot analyses calendar data for scheduling insights. These features
        require server-side access to your plaintext data. Third-party apps
        can request calendar access through their APIs. Workspace and Microsoft 365
        admins have full visibility into employee calendars. And all three
        comply with law enforcement requests.
      </p>

      <p>
        Apple deserves a special mention. In 2022, they introduced Advanced
        Data Protection (ADP) with end-to-end encryption for iCloud backups,
        Notes, and Photos. But calendar and contacts are{' '}
        <a
          href="https://support.apple.com/en-us/102651"
          target="_blank"
          rel="noopener noreferrer"
        >
          explicitly excluded from ADP
        </a>
        . Even with it enabled, Apple holds the keys to your calendar. Probably
        a CalDAV interoperability constraint, but the result is the same.
      </p>

      <h2>The encrypted walled gardens: Proton &amp; Tuta</h2>

      <p>
        Both Proton Calendar and Tuta Calendar offer genuine end-to-end
        encryption. Your events are encrypted on your device before they reach
        the server. The provider cannot read them. This is a real improvement
        over the Big Three.
      </p>

      <p>
        The tradeoff is ecosystem lock-in. Neither works with third-party
        calendar apps. You can&apos;t use them with Apple Calendar, Thunderbird,
        GNOME Calendar, or any other app you might already have. If you&apos;re
        happy using only their own apps, it works. If you want to choose your
        own software, you&apos;re stuck.
      </p>

      <h2>The self-hosted option: Nextcloud</h2>

      <p>
        Nextcloud gives you full control. You run the server, you own the
        hardware, and it supports CalDAV so it works with practically any
        calendar app.
      </p>

      <p>
        But there&apos;s an important caveat: Nextcloud&apos;s calendar data is{' '}
        <strong>not end-to-end encrypted</strong>. Events are stored on the
        server in plaintext. If someone gains access to your instance, they can
        read everything. Self-hosting reduces who <em>could</em> access your
        data, but it shifts the risk rather than eliminating it.
      </p>

      <KeyHolderDiagram />

      <h2>SilentSuite</h2>

      <p>
        SilentSuite uses the{' '}
        <a
          href="https://www.etebase.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Etebase protocol
        </a>{' '}
        for end-to-end encrypted sync of calendars, contacts, and tasks. Your
        data is encrypted on your device before it leaves. Our server only
        stores ciphertext. We cannot read your events. Not if we wanted to.
        Not if someone asked us to.
      </p>

      <p>
        The server is hosted on GDPR-compliant EU infrastructure. The
        code is open source under AGPL-3.0. And because we build on the Etebase
        protocol, we support standard sync through a bridge that lets you use
        any calendar or contacts app you already have. Apple Calendar,
        Thunderbird, GNOME Calendar, the built-in Android calendar &mdash; they
        all work. We don&apos;t think you should have to choose between
        encryption and using the apps you like.
      </p>

      <p>
        We&apos;re honest about the tradeoffs: E2EE means server-side features
        like smart scheduling or AI suggestions aren&apos;t possible. The server
        can&apos;t process what it can&apos;t read. If those features matter
        more to you than encryption, SilentSuite isn&apos;t the right fit.
      </p>

      <h2>As easy as Google, but private</h2>

      <p>
        Privacy tools have a reputation for being hard to use. We want to change
        that. Our goal with SilentSuite is simple:{' '}
        <strong>
          it should be as easy to use as Google Calendar, but with real
          encryption running in the background
        </strong>
        .
      </p>

      <p>
        That means supporting all the standard protocols your devices already
        speak. When you add a SilentSuite account to your phone, it should feel
        exactly like adding a Google or iCloud account. Your existing calendar
        app, your existing contacts app, your existing task manager &mdash; they
        should all just work. No special apps required, no migration headaches,
        no learning curve.
      </p>

      <p>
        The encryption happens silently between your device and our server. You
        don&apos;t need to think about keys, protocols, or ciphertext. You just
        use your calendar like you always have, and everything stays private
        by default. That&apos;s the product we&apos;re building.
      </p>

      <h2>Quick reference</h2>

      <p>
        One thing worth explaining: when we say a provider &ldquo;works with
        desktop apps&rdquo; or &ldquo;works with phone apps&rdquo;, we mean you
        can use <em>any</em> calendar app you already have. Apple Calendar on
        your Mac, the built-in calendar on your Android phone, Thunderbird on
        Linux, and so on. This is possible through a standard called{' '}
        <strong>CalDAV</strong>. It&apos;s the universal language calendar apps
        use to talk to a server. If a service supports CalDAV, you&apos;re free
        to choose your app. If it doesn&apos;t, you&apos;re stuck using only
        the provider&apos;s own apps.
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid rgba(100, 116, 139, 0.3)' }}>
              <th style={{ textAlign: 'left', padding: '0.6rem 0.75rem', color: 'white', fontWeight: 600 }}>Provider</th>
              <th style={{ textAlign: 'center', padding: '0.6rem 0.5rem', color: 'white', fontWeight: 600 }}>E2EE</th>
              <th style={{ textAlign: 'center', padding: '0.6rem 0.5rem', color: 'white', fontWeight: 600 }}>Key holder</th>
              <th style={{ textAlign: 'center', padding: '0.6rem 0.5rem', color: 'white', fontWeight: 600 }}>Open source</th>
              <th style={{ textAlign: 'center', padding: '0.6rem 0.5rem', color: 'white', fontWeight: 600 }}>Desktop apps</th>
              <th style={{ textAlign: 'center', padding: '0.6rem 0.5rem', color: 'white', fontWeight: 600 }}>Phone apps</th>
            </tr>
          </thead>
          <tbody>
            {([
              { provider: 'Google Calendar', cells: [
                { text: 'No', color: '#EF4444' },
                { text: 'Google', color: '#EF4444' },
                { text: 'No', color: '#EF4444' },
                { text: 'Any', color: '#34d399' },
                { text: 'Any', color: '#34d399' },
              ]},
              { provider: 'Apple Calendar', cells: [
                { text: 'No', color: '#EF4444' },
                { text: 'Apple', color: '#EF4444' },
                { text: 'Partial', color: '#FBBF24' },
                { text: 'Any', color: '#34d399' },
                { text: 'Any', color: '#34d399' },
              ]},
              { provider: 'Outlook', cells: [
                { text: 'No', color: '#EF4444' },
                { text: 'Microsoft', color: '#EF4444' },
                { text: 'No', color: '#EF4444' },
                { text: 'Any', color: '#34d399' },
                { text: 'Any', color: '#34d399' },
              ]},
              { provider: 'Proton Calendar', cells: [
                { text: 'Yes', color: '#34d399' },
                { text: 'You', color: '#34d399' },
                { text: 'Yes', color: '#34d399' },
                { text: 'Proton only', color: '#EF4444' },
                { text: 'Proton only', color: '#EF4444' },
              ]},
              { provider: 'Tuta Calendar', cells: [
                { text: 'Yes', color: '#34d399' },
                { text: 'You', color: '#34d399' },
                { text: 'Yes', color: '#34d399' },
                { text: 'Tuta only', color: '#EF4444' },
                { text: 'Tuta only', color: '#EF4444' },
              ]},
              { provider: 'Nextcloud', cells: [
                { text: 'No', color: '#EF4444' },
                { text: 'Server admin', color: '#FBBF24' },
                { text: 'Yes', color: '#34d399' },
                { text: 'Any', color: '#34d399' },
                { text: 'Any', color: '#34d399' },
              ]},
              { provider: 'SilentSuite', cells: [
                { text: 'Yes', color: '#34d399' },
                { text: 'You', color: '#34d399' },
                { text: 'Yes', color: '#34d399' },
                { text: 'Any', color: '#34d399' },
                { text: 'Any', color: '#34d399' },
              ]},
            ] as const).map((row) => (
              <tr
                key={row.provider}
                style={{
                  borderBottom: '1px solid rgba(100, 116, 139, 0.15)',
                  ...(row.provider === 'SilentSuite' ? { background: 'rgba(52, 211, 153, 0.05)' } : {}),
                }}
              >
                <td style={{
                  padding: '0.6rem 0.75rem',
                  fontWeight: row.provider === 'SilentSuite' ? 600 : 500,
                  color: row.provider === 'SilentSuite' ? '#34d399' : 'white',
                }}>
                  {row.provider}
                </td>
                {row.cells.map((cell, i) => (
                  <td
                    key={i}
                    style={{
                      textAlign: 'center',
                      padding: '0.6rem 0.5rem',
                      color: cell.color,
                      fontWeight: 500,
                    }}
                  >
                    {cell.text}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p>
        <em>
          SilentSuite works with any desktop or phone calendar app through a
          CalDAV bridge. This means you get end-to-end encryption <strong>and</strong>{' '}
          the freedom to use Apple Calendar, GNOME Calendar, Thunderbird, or any
          other app that supports calendar sync.
        </em>
      </p>

      <h2>What to look for</h2>

      <ChecklistGraphic />

      <h2>The bottom line</h2>

      <p>
        We encrypt our messages, our passwords, and our files. But most of us
        still sync our calendars through services that can read every entry.
        Not because we don&apos;t care, but because the encrypted options were
        walled gardens, the flexible options weren&apos;t encrypted, and the
        self-hosted options required running your own server.
      </p>

      <p>
        SilentSuite is built to close that gap. End-to-end encrypted, open
        source, with zero-knowledge architecture and standard protocol support
        so you can use the apps you already like.
      </p>

      <hr />

      <p>
        Your calendar deserves the same protection as your messages. If that
        matters to you,{' '}
        <a href="https://app.silentsuite.io/signup">get started with SilentSuite</a>.
      </p>
    </>
  )
}
