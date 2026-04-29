export default function LookingForAnEteSyncAlternative() {
  return (
    <>
      <p>
        If you&apos;re looking for an EteSync alternative because the project
        has gone quiet, this post is for you. SilentSuite is an open-source,
        end-to-end encrypted replacement for EteSync, built on the same{' '}
        <a
          href="https://www.etebase.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Etebase protocol
        </a>{' '}
        underneath. Same encrypted sync for calendars, contacts, and tasks.
        Same zero-knowledge architecture. New maintained product around it.
        We&apos;re available now from &euro;3/mo or as a self-hosted server
        under AGPL-3.0.
      </p>

      <p>
        That&apos;s the short answer. The longer answer is below: what happened
        to EteSync, what still works, what doesn&apos;t, what we changed, and
        the honest alternatives if SilentSuite isn&apos;t a fit for you.
      </p>

      <h2>What happened to EteSync?</h2>

      <p>
        <a
          href="https://www.etesync.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          EteSync
        </a>{' '}
        was the original end-to-end encrypted sync service for calendars,
        contacts, and tasks. It was built around the Etebase protocol, which
        is genuinely well-designed: zero-knowledge encryption, proper key
        management, conflict resolution, offline support. The cryptography is
        sound. For a long stretch, EteSync was the only service that did
        encrypted PIM (personal information management) sync properly outside
        of the walled gardens of Proton and Tuta.
      </p>

      <p>
        The problem isn&apos;t the protocol. The protocol still works. The
        problem is that the apps and the hosted server stopped seeing
        meaningful updates. The EteSync Android app, web client, and DAV
        bridge fell behind. Issues piled up on GitHub without responses. For
        a service that handles your daily schedule, &ldquo;it still kind of
        works on my phone&rdquo; isn&apos;t enough. People started looking
        for somewhere else to go.
      </p>

      <h2>Is EteSync dead?</h2>

      <p>
        Not technically. The hosted service at etesync.com is still running.
        Existing accounts still sync. The Android app is still on F-Droid. If
        you have a working setup, it isn&apos;t going to vanish overnight.
      </p>

      <p>
        But it isn&apos;t being maintained either. There&apos;s no roadmap, no
        release cadence, no responses to the active issues. The web client UI
        looks like it did in 2020. New devices and new OS versions break
        things that nobody is fixing. Practically speaking, EteSync is in a
        permanent twilight: alive enough to keep your data, not alive enough
        to grow with you.
      </p>

      <h2>How SilentSuite continues EteSync</h2>

      <p>
        SilentSuite is what happens when the protocol gets a maintained
        product around it. We forked Etebase, kept the same encryption and
        the same data model, and rebuilt the parts that had bit-rotted. New
        Android client, new web client, new CalDAV bridge, active server
        development, EU-hosted infrastructure, sustainable pricing.
      </p>

      <p>
        Concretely, here&apos;s what stays the same and what&apos;s new:
      </p>

      <div className="not-prose grid sm:grid-cols-2 gap-4 my-8">
        <div className="rounded-xl border border-navy-700/60 bg-navy-900/40 p-5">
          <div className="text-white font-bold text-base mb-3">
            Same as EteSync
          </div>
          <ul className="text-sm space-y-2 text-navy-200 list-disc pl-5">
            <li>The Etebase protocol underneath</li>
            <li>Zero-knowledge encryption (server can&apos;t read your data)</li>
            <li>Calendars, contacts, and tasks in one product</li>
            <li>Open source server (AGPL-3.0)</li>
            <li>Self-hostable</li>
            <li>iOS access via the original EteSync app (for now)</li>
          </ul>
        </div>
        <div className="rounded-xl border border-teal-400/30 bg-teal-400/5 p-5">
          <div className="text-teal-300 font-bold text-base mb-3">
            New in SilentSuite
          </div>
          <ul className="text-sm space-y-2 text-navy-200 list-disc pl-5">
            <li>Active development with a real release cadence</li>
            <li>Modern Android app, theme-aware light/dark</li>
            <li>Updated web client</li>
            <li>Standalone CalDAV bridge for Apple Calendar and Thunderbird</li>
            <li>EU-hosted, GDPR-compliant infrastructure</li>
            <li>Hosted from &euro;3/mo, sustainable without ads or data sales</li>
          </ul>
        </div>
      </div>

      <p>
        We are not pretending we have everything EteSync had on day one. We
        don&apos;t yet have a native iOS client of our own. We&apos;re early.
        But we&apos;re here, and we&apos;re shipping.
      </p>

      <h2>How do I migrate from EteSync to SilentSuite?</h2>

      <p>
        Because we share the Etebase protocol, migration is straightforward
        rather than a full export-import dance.
      </p>

      <ol>
        <li>
          <strong>Create a SilentSuite account</strong> at{' '}
          <a href="https://app.silentsuite.io/signup">app.silentsuite.io/signup</a>.
          The free trial gives you time to migrate without committing.
        </li>
        <li>
          <strong>Export your EteSync collections</strong> from the EteSync
          web client or Android app. Each calendar, address book, and task
          list exports as a standard{' '}
          <code>.ics</code>, <code>.vcf</code>, or task file.
        </li>
        <li>
          <strong>Import into SilentSuite</strong> through the web client.
          The data model is identical, so events, contacts, and tasks come in
          intact, including recurrence rules and reminders.
        </li>
        <li>
          <strong>Re-point your devices.</strong> On Android, install the
          SilentSuite app and sign in. On iOS, you can keep using the
          original EteSync app pointed at the SilentSuite server (same
          protocol). For Apple Calendar or Thunderbird, install our standalone
          CalDAV bridge and connect it.
        </li>
        <li>
          <strong>Verify, then deactivate EteSync.</strong> Confirm a few
          recent events and contacts arrived correctly before pulling the
          plug on the old account.
        </li>
      </ol>

      <p>
        We have step-by-step migration docs on our help site, and if you hit
        a snag we&apos;ll help you through it. Migrating off a stalled
        service is exactly the kind of thing that should be friction-free.
      </p>

      <h2>Honest alternatives if SilentSuite isn&apos;t a fit</h2>

      <p>
        We&apos;re not the only encrypted-PIM option, and we don&apos;t
        pretend to be the answer for everyone. If you&apos;re evaluating, the
        other realistic choices in 2026 are:
      </p>

      <ul>
        <li>
          <strong>
            <a
              href="https://proton.me/calendar"
              target="_blank"
              rel="noopener noreferrer"
            >
              Proton Calendar
            </a>
            :
          </strong>{' '}
          End-to-end encrypted, bundled with Proton Mail, polished UI. No
          CalDAV, no third-party app integration, no proper task sync. Good
          choice if you live entirely inside the Proton ecosystem.
        </li>
        <li>
          <strong>
            <a
              href="https://tuta.com/calendar"
              target="_blank"
              rel="noopener noreferrer"
            >
              Tuta Calendar
            </a>
            :
          </strong>{' '}
          Similar trade-offs to Proton. Real encryption, locked into Tuta&apos;s
          own apps, no CalDAV. Tasks aren&apos;t a first-class feature.
        </li>
        <li>
          <strong>
            <a
              href="https://nextcloud.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Nextcloud
            </a>
            :
          </strong>{' '}
          Self-hosted, supports CalDAV and CardDAV, huge ecosystem. But
          calendar and contacts data is stored in plaintext in the Nextcloud
          database. Fine if you control the server, weaker if you use a
          hosted Nextcloud provider.
        </li>
        <li>
          <strong>Stay on EteSync:</strong> Genuinely an option if your
          current setup works and you accept the lack of updates. Your data
          isn&apos;t going anywhere as long as the hosted server keeps
          running. We just don&apos;t recommend it for new users in 2026.
        </li>
      </ul>

      <p>
        For a deeper feature-by-feature breakdown of these services, see our{' '}
        <a href="/blog/encrypted-calendar-sync-2026-comparing-options">
          full encrypted calendar comparison
        </a>
        .
      </p>

      <h2>What we&apos;re not</h2>

      <p>
        We&apos;re not a venture-funded privacy startup. We&apos;re not chasing
        a billion-dollar exit. We&apos;re building a sustainable product
        around a protocol we believe in, hosted in the EU, with the option to
        self-host the server if you don&apos;t want to trust us.
      </p>

      <p>
        The same incentive structure that took down{' '}
        <a
          href="https://en.wikipedia.org/wiki/Skiff_(company)"
          target="_blank"
          rel="noopener noreferrer"
        >
          Skiff
        </a>{' '}
        (acquired by Notion in 2024 and shut down) is something we&apos;ve
        explicitly designed away from. Open-source server, exportable data,
        AGPL-3.0 licensing, EU hosting, paid by users instead of investors.
        If we ever go away, you can take the server with you.
      </p>

      <h2>FAQ</h2>

      <p>
        <strong>Is SilentSuite the same protocol as EteSync?</strong>
        <br />
        Yes. We use Etebase under the hood, the same protocol EteSync built.
        Existing iOS users of the EteSync app can point it at a SilentSuite
        server today and it works.
      </p>

      <p>
        <strong>
          Is SilentSuite end-to-end encrypted?
        </strong>
        <br />
        Yes. Calendars, contacts, and tasks are encrypted on your device
        before they reach our server. We hold ciphertext only. We can&apos;t
        read your events, contacts, or tasks even if we wanted to.
      </p>

      <p>
        <strong>Can I self-host SilentSuite?</strong>
        <br />
        Yes. The server is open source under AGPL-3.0. You can run it on your
        own VPS or homelab and point our clients at it.
      </p>

      <p>
        <strong>How much does SilentSuite cost?</strong>
        <br />
        From &euro;3/mo for the hosted plan. Self-hosting is free, you only
        pay for the infrastructure you run.
      </p>

      <p>
        <strong>Does SilentSuite work with Apple Calendar or Thunderbird?</strong>
        <br />
        Yes, through our standalone CalDAV bridge. Install the bridge, sign in
        with your SilentSuite account, and your encrypted data appears in
        Apple Calendar, Thunderbird, or any CalDAV/CardDAV-compatible client.
      </p>

      <p>
        <strong>What happens to my data if SilentSuite shuts down?</strong>
        <br />
        You can export your collections at any time as standard{' '}
        <code>.ics</code> / <code>.vcf</code> files. The server is open
        source, so you (or anyone) can run it independently. Data lock-in is
        not part of our model.
      </p>

      <hr />

      <p>
        EteSync proved encrypted PIM sync was possible. We&apos;re making sure
        it stays available. If you&apos;ve been waiting for someone to pick
        the project up, this is us doing that.
      </p>

      <p>
        <a href="https://app.silentsuite.io/signup">
          Get started with SilentSuite
        </a>
        , or read our full{' '}
        <a href="/blog/encrypted-calendar-sync-2026-comparing-options">
          comparison of encrypted calendar options
        </a>{' '}
        if you want to see all your choices side by side.
      </p>
    </>
  )
}
