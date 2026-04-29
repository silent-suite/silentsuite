export default function WalledGardensVsSystemIntegrationEncryptedPim() {
  return (
    <>
      <p>
        SilentSuite is an open-source, end-to-end encrypted alternative to
        Google Calendar, Contacts, and Tasks, built on the{' '}
        <a
          href="https://www.etebase.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Etebase protocol
        </a>
        . What sets it apart from Proton and Tuta isn&apos;t the encryption,
        which is real in all three. It&apos;s the integration model. Proton
        and Tuta give you E2EE inside their own apps. SilentSuite gives you
        E2EE that plugs into Apple Calendar, Thunderbird, DAVx5, and the
        rest of the standards-based ecosystem through a CalDAV/CardDAV
        bridge. From &euro;3/mo, AGPL-3.0, EU-hosted.
      </p>

      <p>
        That&apos;s a real architectural trade-off, and we want to walk
        through it honestly. Both models are valid. They suit different
        people for different reasons.
      </p>

      <h2>What is a walled garden in privacy software?</h2>

      <p>
        A walled garden is a service where the apps, the protocol, and the
        servers are all controlled by one provider. Inside the garden,
        things work beautifully and consistently because the provider owns
        every layer. Outside the garden, things either don&apos;t work or
        work poorly, because the provider doesn&apos;t expose standard
        interfaces.
      </p>

      <p>
        Apple&apos;s ecosystem is the canonical walled garden: iMessage
        only works between iPhones, AirDrop only between Apple devices,
        FaceTime only between Apple accounts. Inside the garden, the
        experience is polished. Outside, it&apos;s SMS or nothing.
      </p>

      <p>
        Privacy companies often adopt the walled-garden pattern too. Proton
        and Tuta both encrypt their email, calendar, and contacts well, but
        only inside their own apps. There&apos;s no IMAP for encrypted
        email, no CalDAV for encrypted calendar, no CardDAV for encrypted
        contacts. The encryption is real. The lock-in is also real.
      </p>

      <h2>Is Proton a walled garden?</h2>

      <p>
        For Proton Calendar and Proton Contacts, yes. There&apos;s no CalDAV
        endpoint, no CardDAV endpoint, no way to surface your encrypted
        calendar in Apple Calendar or Thunderbird, no way to export your
        contacts to a third-party address book without losing the
        encryption boundary.
      </p>

      <p>
        For Proton Mail, the answer is more nuanced. Proton offers an{' '}
        <a
          href="https://proton.me/mail/bridge"
          target="_blank"
          rel="noopener noreferrer"
        >
          IMAP bridge
        </a>{' '}
        for paid users. The bridge runs locally, decrypts on your machine,
        and exposes your encrypted mailbox over standard IMAP/SMTP to clients
        like Thunderbird or Apple Mail. That&apos;s the same architectural
        idea SilentSuite uses for CalDAV and CardDAV: a local bridge that
        decrypts on the client and exposes a standards-compliant endpoint to
        the rest of your tools.
      </p>

      <p>
        It&apos;s telling that Proton built a bridge for email but not for
        calendar or contacts. Those products are still walled.
      </p>

      <h2>What is the system-integration model?</h2>

      <p>
        The opposite of a walled garden is a service that works through
        open protocols, so your data shows up in the apps you already use.
        For PIM (personal information management), that means CalDAV for
        calendars and tasks, and CardDAV for contacts.
      </p>

      <p>
        Both protocols were standardized roughly 15 to 20 years ago. They
        run on top of HTTP, they&apos;re supported natively by Apple
        Calendar, iOS Contacts, Thunderbird, and through{' '}
        <a
          href="https://www.davx5.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          DAVx5
        </a>{' '}
        on Android. If you can speak CalDAV, you can show up as a calendar
        in macOS Calendar.app. If you can speak CardDAV, you can show up as
        an address book in iOS Contacts.
      </p>

      <p>
        The catch with the system-integration model is that vanilla CalDAV
        and CardDAV aren&apos;t end-to-end encrypted. The server has to
        parse vCards and iCalendar events to support search, recurrence
        expansion, and the merge logic those protocols expect. Plaintext on
        the server is the default.
      </p>

      <p>
        SilentSuite (and EteSync before it) sidestep this by syncing at a
        different layer: encrypted blobs over the Etebase protocol, with a
        local bridge that decrypts the blobs and re-exposes them as
        standards-compliant CalDAV/CardDAV to Apple Calendar, Thunderbird,
        and DAVx5. You get the integration benefits of an open protocol
        without giving the server any of the data in plaintext.
      </p>

      <h2>When walled gardens win</h2>

      <p>
        Walled gardens are the right choice in several real scenarios:
      </p>

      <ul>
        <li>
          <strong>You want one bill and one app for everything.</strong>{' '}
          Proton Unlimited bundles email, calendar, contacts, drive, VPN, and
          a password manager into one subscription. If you don&apos;t need
          your data in any other app, that&apos;s genuinely simpler.
        </li>
        <li>
          <strong>You don&apos;t want to think about clients.</strong>{' '}
          Proton&apos;s and Tuta&apos;s mobile apps are well-designed,
          install in one tap, and require no configuration. A bridge or
          DAVx5 setup is more steps.
        </li>
        <li>
          <strong>You&apos;re already inside the ecosystem.</strong> If
          you&apos;re a Proton Mail customer, Proton Calendar is the
          path-of-least-resistance choice. Adding a separate calendar service
          when you already have one bundled is a hard sell.
        </li>
        <li>
          <strong>The integrations you&apos;d want don&apos;t exist
          anyway.</strong> If you live entirely on a phone and never use a
          desktop calendar or email client, the integration argument is
          theoretical. You don&apos;t actually have other apps to plug into.
        </li>
      </ul>

      <p>
        We don&apos;t argue against walled gardens in general. They are a
        legitimate trade-off, and for a meaningful share of users they
        produce a better day-to-day experience.
      </p>

      <h2>When system integration wins</h2>

      <p>
        The system-integration model wins when any of the following are true:
      </p>

      <ul>
        <li>
          <strong>You already have a calendar app you like.</strong> Apple
          Calendar on macOS, Thunderbird, Fantastical, Outlook (yes, even
          Outlook). If your encrypted service supports CalDAV, you keep your
          favorite client and gain the encryption.
        </li>
        <li>
          <strong>You use multiple devices from different ecosystems.</strong>{' '}
          A Linux laptop, an iPhone, an Android tablet, a NAS at home.
          Standard protocols mean you don&apos;t have to install a
          provider-specific app on each.
        </li>
        <li>
          <strong>You want your data accessible from automation.</strong>{' '}
          Home Assistant, scripts, calendar widgets, scheduling tools. CalDAV
          is everywhere; proprietary calendar APIs are not.
        </li>
        <li>
          <strong>You&apos;re cautious about lock-in.</strong> If your
          encrypted service shuts down or raises prices, a CalDAV-compatible
          calendar can be re-pointed at a different CalDAV-compatible server
          without exporting and re-importing.
        </li>
        <li>
          <strong>You self-host or want the option.</strong> Open protocols
          are what make it possible to run your own server and still use
          mainstream client apps. Walled gardens make this practically
          impossible.
        </li>
      </ul>

      <h2>How SilentSuite fits both shapes</h2>

      <p>
        SilentSuite is closer to the system-integration end of the spectrum,
        but we ship our own apps as well. The Android app is native. The
        web client is native. Tasks, contacts, and calendar live in one
        product with one account.
      </p>

      <p>
        At the same time, the standalone CalDAV/CardDAV bridge means you
        can put SilentSuite calendars and contacts inside Apple Calendar,
        iOS Contacts, Thunderbird, Outlook, or any DAV-compatible client.
        Your encrypted PIM data appears alongside any other calendars and
        address books you have. The bridge runs locally, decrypts under
        your key, and exposes the standard protocol to the system app.
      </p>

      <div className="not-prose my-10 p-6 sm:p-8 rounded-2xl border border-teal-400/30 bg-gradient-to-br from-teal-400/10 to-navy-900/40">
        <div className="text-white font-bold text-lg mb-1">
          The bridge model: E2EE plus standards
        </div>
        <div className="text-sm text-navy-300 mb-6">
          Sync runs over Etebase ciphertext. The local bridge decrypts on
          your machine and serves CalDAV / CardDAV to whichever client app
          you already use.
        </div>
        <div className="flex items-center justify-between gap-3 sm:gap-6">
          <div className="flex flex-col items-center text-center flex-1 min-w-0">
            <div className="w-14 h-14 rounded-lg bg-teal-400/10 border border-teal-400/30 flex items-center justify-center mb-2">
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
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M3 5v14a9 3 0 0 0 18 0V5" />
                <path d="M3 12a9 3 0 0 0 18 0" />
              </svg>
            </div>
            <div className="text-white text-xs font-semibold">SilentSuite server</div>
            <div className="text-navy-400 text-[11px] mt-0.5">ciphertext only</div>
          </div>

          <div className="flex flex-col items-center gap-1 flex-shrink-0">
            <div className="text-teal-300 text-[11px] font-semibold tracking-wide uppercase">
              Etebase
            </div>
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
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </div>

          <div className="flex flex-col items-center text-center flex-1 min-w-0">
            <div className="w-14 h-14 rounded-lg bg-teal-400/10 border border-teal-400/30 flex items-center justify-center mb-2">
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
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </div>
            <div className="text-white text-xs font-semibold">Local bridge</div>
            <div className="text-navy-400 text-[11px] mt-0.5">decrypts and serves CalDAV/CardDAV</div>
          </div>

          <div className="flex flex-col items-center gap-1 flex-shrink-0">
            <div className="text-teal-300 text-[11px] font-semibold tracking-wide uppercase">
              CalDAV
            </div>
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
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </div>

          <div className="flex flex-col items-center text-center flex-1 min-w-0">
            <div className="w-14 h-14 rounded-lg bg-teal-400/10 border border-teal-400/30 flex items-center justify-center mb-2">
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
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
            </div>
            <div className="text-white text-xs font-semibold">Apple Calendar / Thunderbird / DAVx5</div>
            <div className="text-navy-400 text-[11px] mt-0.5">your existing app</div>
          </div>
        </div>
      </div>

      <p>
        It&apos;s more architectural complexity than a walled garden, but
        it&apos;s also the only architecture that gives you both real E2EE
        and the freedom to keep using the apps you like.
      </p>

      <h2>Doesn&apos;t the bridge break the encryption story?</h2>

      <p>
        No. The bridge runs on your device. It holds your decryption key.
        It never sends plaintext over the network. The connection between
        the bridge and your client app (Apple Calendar, Thunderbird) is
        local, on the same machine. Plaintext exists only on devices you
        already control.
      </p>

      <p>
        The threat model is the same as any other software running on your
        machine: if your machine is compromised, your calendar can be read,
        which would also be true if you used Proton&apos;s desktop app or
        Apple Calendar with iCloud. Encryption protects data at rest on
        servers you don&apos;t control. It cannot protect against an
        attacker on the device that holds the key. That isn&apos;t a unique
        property of the bridge model. It&apos;s true everywhere.
      </p>

      <h2>So which should you pick?</h2>

      <p>
        Walled garden if simplicity beats flexibility for you, and you live
        comfortably inside one provider&apos;s app for everything. Proton
        and Tuta are both reasonable choices and we&apos;d recommend them
        over a plaintext alternative any day.
      </p>

      <p>
        System integration if you want your encrypted PIM data to coexist
        with the rest of your tools, if you might switch ecosystems later,
        if you self-host or want to, or if you simply prefer Apple Calendar
        to a service-specific calendar app. SilentSuite is built for this
        side of the trade-off.
      </p>

      <h2>FAQ</h2>

      <p>
        <strong>What&apos;s the difference between Proton and SilentSuite?</strong>
        <br />
        Proton is a bundled, walled-garden privacy suite (mail, calendar,
        contacts, drive, VPN). SilentSuite is a focused PIM service
        (calendar, contacts, tasks) that works inside the apps you already
        use through CalDAV and CardDAV. Both are end-to-end encrypted.
      </p>

      <p>
        <strong>Can I use SilentSuite in Apple Calendar?</strong>
        <br />
        Yes, through our standalone CalDAV bridge. Same model as Proton
        Mail&apos;s IMAP bridge, applied to calendar and contacts.
      </p>

      <p>
        <strong>
          Is the bridge open source?
        </strong>
        <br />
        Yes. The server, clients, and bridge are all under AGPL-3.0.
      </p>

      <p>
        <strong>If I leave SilentSuite, can I take my data?</strong>
        <br />
        Yes. Standard <code>.ics</code> and <code>.vcf</code> exports work
        from the web client. The Etebase server is open source if you want
        to keep running on the same protocol with someone else, or
        yourself.
      </p>

      <p>
        <strong>Why didn&apos;t Proton build a calendar bridge?</strong>
        <br />
        We don&apos;t know. They built one for email, so the engineering
        capability clearly exists. Calendar and contacts may simply not be
        a priority for them right now. The walled-garden choice is partly a
        product strategy decision, not just a technical limitation.
      </p>

      <hr />

      <p>
        Encryption alone isn&apos;t the differentiator anymore. The shape of
        the integration is. If you want encrypted PIM that lives inside the
        apps you already trust,{' '}
        <a href="https://app.silentsuite.io/signup">try SilentSuite</a>. If
        you want everything bundled inside one provider&apos;s apps, Proton
        and Tuta are reasonable choices. Both options are better than the
        plaintext default that almost everyone is still on.
      </p>
    </>
  )
}
