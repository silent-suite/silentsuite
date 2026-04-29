export default function WalledGardensVsSystemIntegrationEncryptedPim() {
  return (
    <>
      <p>
        The honest summary first: Proton&apos;s walled garden is a deliberate
        privacy choice, not a missing feature. By refusing to expose
        CalDAV/CardDAV, Proton makes sure no other app on your phone or
        laptop can read your encrypted calendar or contacts. SilentSuite
        gives you both shapes. The webapp is a walled garden in exactly the
        same sense. The standalone bridge opens the door to Apple Calendar,
        Thunderbird, and DAVx5 if you decide your operating system and the
        apps on it are trusted enough to see the plaintext. From &euro;3/mo,
        AGPL-3.0, EU-hosted.
      </p>

      <p>
        This post walks through the trade-off the way we actually think
        about it. There is no universally correct answer. There is an answer
        that fits your device, your threat model, and the apps you live in.
      </p>

      <h2>What does &ldquo;walled garden&rdquo; actually buy you?</h2>

      <p>
        In privacy software, a walled garden is a service whose data only
        ever appears inside the provider&apos;s own apps. There is no
        CalDAV, no CardDAV, no IMAP, no API for third-party clients. You
        read your calendar in Proton Calendar. You read your contacts in
        Proton Mail. Nothing else on your machine can.
      </p>

      <p>
        That sounds like lock-in. It is also a real privacy property.
        On a typical phone, your address book is the most-requested
        permission on the whole device. Every messaging app, every social
        app, every &ldquo;sign up with phone number&rdquo; flow asks for it.
        Every advertising SDK that ships inside an app you barely think
        about asks for it. The moment your contacts live in the system
        contacts provider, those apps can read them.
      </p>

      <p>
        Proton looked at that picture and decided not to plug into it. Their
        encrypted contacts only ever appear inside Proton&apos;s own apps,
        which they wrote, which they audit. No third-party SDK gets a
        chance. That is the upside of the walled garden, and it is the main
        reason Proton has chosen not to build a CalDAV/CardDAV bridge for
        calendar and contacts the way they did for email.
      </p>

      <p>
        For a meaningful share of users this is the better privacy posture.
        End-to-end encryption protects data on the network and on the
        server. It does not protect data on a device that has 80 installed
        apps, half of which would happily read your address book if asked.
        A walled garden does.
      </p>

      <h2>What does system integration actually cost?</h2>

      <p>
        System integration via CalDAV (calendars and tasks) and CardDAV
        (contacts) is the opposite shape. Your encrypted PIM data is
        decrypted by a local bridge and exposed to the operating system as
        a standard calendar or address book. From there, any app on the
        system that has the relevant permission can read it.
      </p>

      <p>
        On a typical iPhone or stock Android phone, that surface is wide.
        Granting contacts permission to one app gives that app access to
        every contact on the device, including the encrypted ones from
        SilentSuite that the bridge has just made visible. Granting
        calendar permission has the same effect. The encryption boundary
        between you and your sync provider is intact. The boundary between
        your contacts and the apps you have installed is whatever the
        operating system enforces.
      </p>

      <p>
        That is not a bug in the bridge model. It is the explicit
        trade-off. You get the encrypted data inside the apps you already
        use, including the dialer that calls someone when you tap their
        number, the calendar that reminds you about a meeting, the maps app
        that resolves an address. Convenience comes back. Some surface area
        comes with it.
      </p>

      <h2>When walled gardens are the right call</h2>

      <p>
        Pick the walled garden when you cannot personally vouch for every
        app on your device, and when system-level convenience is not worth
        the spread. Concrete cases:
      </p>

      <ul>
        <li>
          <strong>Stock Android with the usual app sprawl.</strong> Phones
          come pre-loaded with apps from the manufacturer, the carrier, and
          a long tail of third-party SDKs embedded in apps you did install.
          Granting contacts permission is rarely a single decision;
          it&apos;s a decision you keep making, often for apps you forgot
          about.
        </li>
        <li>
          <strong>iOS for non-technical users.</strong> Apple&apos;s
          permission model is good, but the path of least resistance is
          still to tap &ldquo;Allow.&rdquo; If you don&apos;t want to make
          a permissions decision every time an app asks, walling the data
          off entirely is a stronger guarantee than careful clicking.
        </li>
        <li>
          <strong>Windows or macOS with a lot of installed software.</strong>{' '}
          The contacts and calendar APIs on both desktop OSes are reachable
          by any app the user runs. Office, Adobe, browser extensions,
          random utilities. A walled garden keeps your encrypted data out
          of all of that.
        </li>
        <li>
          <strong>Anyone whose threat model includes the device itself.</strong>{' '}
          If the laptop or phone is shared, managed by an employer,
          inherited from a partner, or sometimes used by a child, the
          fewer paths to the data, the better.
        </li>
      </ul>

      <p>
        The privacy point is sharp: the only data that cannot leak through
        an app permission is data that the OS doesn&apos;t have. Walled
        gardens are the cleanest way to get that.
      </p>

      <h2>When system integration is the right call</h2>

      <p>
        Pick system integration when you trust the operating system and you
        trust the apps that have permission to read the system address book
        or calendar. That is a real, achievable threat model in 2026,
        especially on a few specific platforms:
      </p>

      <ul>
        <li>
          <strong>GrapheneOS, CalyxOS, or another hardened Android.</strong>{' '}
          You picked the OS specifically to control the app surface. You
          install very little, you grant permissions deliberately, and the
          OS itself isn&apos;t mining your contacts on Google&apos;s behalf.
          On these phones, putting your encrypted contacts into the system
          contacts provider via DAVx5 gets you the convenience back without
          the spread.
        </li>
        <li>
          <strong>Linux desktops where you control the package set.</strong>{' '}
          Thunderbird, Evolution, KDE Kontact, GNOME Calendar. The number of
          apps that can read your CalDAV/CardDAV data is bounded by what
          you installed. If you trust that set, the bridge model is a
          better fit than browsing to a webapp every time you want to look
          up a number.
        </li>
        <li>
          <strong>Locked-down macOS where you actually use the
          permission prompts.</strong> If you reflexively decline calendar
          and contacts access for new apps, and only grant it to known good
          ones, you&apos;ve approximated the same posture by hand.
        </li>
        <li>
          <strong>Anyone who needs phone-level integration for daily
          life.</strong> Tap a contact and call them. Get a calendar
          notification on your watch. Have your maps app surface the
          address of your next meeting. These are not luxuries for many
          people; they are the workflow. Losing them is a real cost, not
          just an aesthetic preference.
        </li>
      </ul>

      <p>
        The convenience point is sharp the other way: in a walled garden,
        copying a phone number from your contacts app to your dialer is a
        manual step. Pasting an event from your calendar app into your
        meeting prep is a manual step. Multiplied across a day, it adds up
        to noticeable friction. For users on a trusted OS, paying that
        friction is the wrong trade.
      </p>

      <h2>How SilentSuite supports both</h2>

      <p>
        SilentSuite is the same encrypted service either way. What
        changes is where you decrypt it.
      </p>

      <p>
        <strong>Walled-garden mode:</strong> use the SilentSuite web app and
        the SilentSuite Android app only. Don&apos;t install the bridge,
        don&apos;t add the CalDAV/CardDAV endpoint to the system OS. Your
        encrypted calendar, contacts, and tasks live inside SilentSuite&apos;s
        own apps and nowhere else. No other app on the device gets a path
        to them. This is the closest equivalent to Proton&apos;s posture
        for users who want it.
      </p>

      <p>
        <strong>System-integration mode:</strong> install the standalone
        CalDAV/CardDAV bridge. The bridge runs on your machine, holds your
        decryption key locally, and exposes a standards-compliant endpoint
        that Apple Calendar, Thunderbird, Outlook, or DAVx5 can read.
        Your encrypted PIM data appears alongside any other calendars and
        address books you have, in the apps you already use.
      </p>

      <div className="not-prose my-10 p-6 sm:p-8 rounded-2xl border border-teal-400/30 bg-gradient-to-br from-teal-400/10 to-navy-900/40">
        <div className="text-white font-bold text-lg mb-1">
          The bridge model: E2EE plus standards
        </div>
        <div className="text-sm text-navy-300 mb-6">
          Sync runs over Etebase ciphertext. The local bridge decrypts on
          your machine and serves CalDAV / CardDAV to whichever client app
          you trust enough to give the data to.
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
        You can mix the two on different devices. Run system integration on
        your GrapheneOS phone where you control the app surface, and stick
        to the SilentSuite webapp on a work laptop you don&apos;t fully
        trust. The encrypted store is the same in both places. Where the
        plaintext appears is a per-device decision.
      </p>

      <h2>Doesn&apos;t the bridge break the encryption story?</h2>

      <p>
        No. The bridge runs on your device and holds your decryption key
        locally. It never sends plaintext over the network. The connection
        between the bridge and your client app (Apple Calendar, Thunderbird)
        is on the same machine. Encrypted at rest on the server, encrypted
        in transit, decrypted only on the device that has the key. That
        story is intact.
      </p>

      <p>
        What does change is who on that device can read the plaintext. With
        the walled-garden mode, only SilentSuite&apos;s own apps can. With
        the bridge, every app that has permission to the system address
        book or calendar can. That is the surface the bridge opens, and it
        is the surface a walled garden closes.
      </p>

      <h2>So which should you pick?</h2>

      <p>
        Pick the walled garden if you don&apos;t fully trust every app on
        your device, or if you specifically want your contacts and calendar
        out of the system surface where ad SDKs and other apps can reach
        them. Proton and Tuta are both reasonable choices in this category;
        SilentSuite&apos;s webapp-only mode is another.
      </p>

      <p>
        Pick system integration if you run a hardened OS, control your app
        set, and want your encrypted PIM data to flow naturally into the
        rest of your tools. SilentSuite is built specifically to support
        this side of the trade-off without compromising the encryption
        boundary on the server.
      </p>

      <p>
        Encryption protects data on the wire and on the server. The
        walled-garden vs system-integration choice protects data on the
        device. Both decisions matter. Pick them deliberately.
      </p>

      <h2>FAQ</h2>

      <p>
        <strong>Why did Proton not build a CalDAV bridge?</strong>
        <br />
        Because exposing your encrypted contacts and calendar to the
        operating system would let any app with permission read them.
        Proton built an IMAP bridge for email because email is already
        widely shared, but kept calendar and contacts walled off as a
        deliberate privacy property. We think this framing is the most
        honest one.
      </p>

      <p>
        <strong>Can I use SilentSuite as a walled garden, like Proton?</strong>
        <br />
        Yes. Use the SilentSuite web app and Android app only. Don&apos;t
        install the bridge and don&apos;t configure CalDAV/CardDAV in your
        OS. Your encrypted PIM data stays inside SilentSuite&apos;s own apps.
      </p>

      <p>
        <strong>Is system integration safe on GrapheneOS?</strong>
        <br />
        Yes, in the sense that GrapheneOS gives you the tools to make it
        safe. You install only the apps you actually want, you grant
        contacts and calendar permission deliberately, and the OS itself
        does not phone home with your data. On stock Android the same setup
        is harder to defend.
      </p>

      <p>
        <strong>Can I mix the two modes on different devices?</strong>
        <br />
        Yes. The encrypted store is one. Where you decrypt it is a
        per-device choice. Bridge on your trusted Linux laptop and
        GrapheneOS phone, webapp-only on your work machine.
      </p>

      <p>
        <strong>If I leave SilentSuite, can I take my data?</strong>
        <br />
        Yes. Standard <code>.ics</code> and <code>.vcf</code> exports work
        from the web client. The Etebase server is open source if you want
        to keep running on the same protocol with someone else, or
        yourself.
      </p>

      <hr />

      <p>
        Encryption alone is not the differentiator anymore. The shape of
        the integration is. Some users want their encrypted PIM nailed
        shut inside one provider&apos;s apps; some want it flowing through
        the rest of their trusted tools.{' '}
        <a href="https://app.silentsuite.io/signup">Try SilentSuite</a>{' '}
        and pick the mode that fits your device. Proton and Tuta are
        reasonable choices for the walled-garden side. Both options are
        better than the plaintext default that almost everyone is still on.
      </p>
    </>
  )
}
