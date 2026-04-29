type Brand = 'todoist' | 'mstodo' | 'apple' | 'google' | 'etesync' | 'silentsuite'

const brandColor: Record<Brand, string> = {
  todoist: '#E44332',
  mstodo: '#2564CF',
  apple: '#A1A1A6',
  google: '#4285F4',
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

export default function EncryptedTasksAndTodoLists2026() {
  return (
    <>
      <p>
        SilentSuite is an open-source, end-to-end encrypted to-do list and task
        sync, built on the same{' '}
        <a
          href="https://www.etebase.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Etebase protocol
        </a>{' '}
        as our calendar and contacts. The server stores ciphertext only, so we
        can&apos;t read your tasks. Hosted from &euro;3/mo, AGPL-3.0
        self-hostable, EU infrastructure.
      </p>

      <p>
        That covers the question for SilentSuite. The harder question is the
        rest of the market. Almost every popular to-do list app, from Todoist
        to Apple Reminders to Google Tasks to Microsoft To Do, can read every
        item on your list. This post is an honest look at the landscape, and
        why we think encrypted task sync deserves more attention than it gets.
      </p>

      <h2>Why your task list is more sensitive than you think</h2>

      <p>
        People are careful with their email and a little less careful with
        their calendar. They&apos;re almost universally careless with their
        task list, because it feels like a notepad. It isn&apos;t.
      </p>

      <p>
        Your tasks contain medication reminders. Therapy follow-ups.
        &ldquo;Call the lawyer.&rdquo; &ldquo;Renew the visa.&rdquo;
        &ldquo;Cancel the gym before the contract auto-renews.&rdquo;
        Personal health, legal exposure, financial deadlines. Tasks tend to
        be more concrete than calendar events, because calendar events are
        often shared and tasks are usually private notes-to-self. The result
        is a stream of plaintext intent that, in aggregate, describes the
        shape of your life with uncomfortable precision.
      </p>

      <p>
        Now ask: who can read it? For most of the popular task apps, the
        answer is &ldquo;the company that runs the service.&rdquo; Sometimes
        the answer is &ldquo;the company, plus its analytics partners,
        plus whoever issues a subpoena.&rdquo;
      </p>

      <BrandHeader brand="todoist" label="Todoist" sub="Doist, Czech Republic / global" />

      <p>
        <a href="https://todoist.com/" target="_blank" rel="noopener noreferrer">
          Todoist
        </a>{' '}
        is the most-used cross-platform to-do app, and it&apos;s a genuinely
        good product. It is{' '}
        <strong>not end-to-end encrypted</strong>. Tasks are stored in
        plaintext on Todoist&apos;s servers. Their privacy policy describes
        encryption in transit and at rest, which is the modern minimum, but
        means Todoist can read every item in your list and produce them in
        response to legal requests.
      </p>

      <p>
        Todoist also integrates with third parties (calendar sync, automation
        tools, AI features) which means your tasks are crossing additional
        trust boundaries. None of this is unusual or hidden. It&apos;s just
        worth being clear-eyed: if you wouldn&apos;t put it in a Google Doc,
        don&apos;t put it in Todoist either.
      </p>

      <BrandHeader brand="mstodo" label="Microsoft To Do" sub="Microsoft, USA" />

      <p>
        <a
          href="https://todo.microsoft.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Microsoft To Do
        </a>{' '}
        is free, polished, and built on Outlook tasks underneath. It&apos;s
        also fully readable by Microsoft. There is no end-to-end encryption.
        Tasks live in your Microsoft 365 account and inherit the same trust
        model as your Outlook mailbox: encrypted at rest on Microsoft&apos;s
        servers, decryptable by Microsoft.
      </p>

      <p>
        For corporate use this is generally fine because the trust boundary
        is the company, not the individual. For personal use, it means a
        line item like &ldquo;leave job&rdquo; sits in plaintext on
        infrastructure your employer&apos;s IT department can sometimes
        reach.
      </p>

      <BrandHeader brand="apple" label="Apple Reminders" sub="Apple, USA" />

      <p>
        <a
          href="https://www.apple.com/icloud/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Apple Reminders
        </a>{' '}
        through iCloud is closer to the encrypted end of the spectrum, but
        not all the way there. With{' '}
        <a
          href="https://support.apple.com/en-us/HT212520"
          target="_blank"
          rel="noopener noreferrer"
        >
          Advanced Data Protection for iCloud
        </a>{' '}
        enabled, Reminders becomes end-to-end encrypted. Without it, Apple
        holds the keys and can read your reminders.
      </p>

      <p>
        Advanced Data Protection is opt-in, off by default, requires a
        recovery contact or recovery key, and is restricted in some
        jurisdictions (notably the UK as of 2025). It also doesn&apos;t help
        you if you use Reminders outside the Apple ecosystem, because there
        is no CalDAV-compatible task export. Apple&apos;s reminders are
        Apple&apos;s reminders.
      </p>

      <BrandHeader brand="google" label="Google Tasks" sub="Google, USA" />

      <p>
        <a
          href="https://tasks.google.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Google Tasks
        </a>{' '}
        sits inside Gmail and Google Calendar. It is{' '}
        <strong>not end-to-end encrypted</strong>. Google can read your
        tasks. Google does read your tasks, in the loose sense that the
        infrastructure processes them in plaintext for indexing, search, and
        increasingly for AI features. Anything in Google Tasks should be
        treated like anything in Gmail: convenient, integrated, and
        absolutely visible to Google.
      </p>

      <BrandHeader brand="etesync" label="EteSync" sub="Stalled, but still running" />

      <p>
        <a
          href="https://www.etesync.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          EteSync
        </a>{' '}
        was the first service to do encrypted tasks properly. The Etebase
        protocol underneath is genuinely well-designed: zero-knowledge
        encryption, conflict resolution, offline support, the works. The
        problem is that EteSync&apos;s apps and server stopped getting
        updates. Existing users still sync, but new users are walking into a
        product that isn&apos;t being maintained.
      </p>

      <p>
        We covered this in detail in our post on{' '}
        <a href="/blog/looking-for-an-etesync-alternative">
          why we picked the EteSync project up
        </a>
        .
      </p>

      <BrandHeader brand="silentsuite" label="SilentSuite" sub="Maintained continuation of Etebase" />

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
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
          </div>
          <div>
            <div className="text-white font-bold text-xl leading-tight">
              SilentSuite Tasks
            </div>
            <div className="text-navy-300 text-sm mt-1">
              Encrypted to-do lists, alongside your encrypted calendar and
              contacts. One account, one app, one trust boundary.
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            'E2EE by default',
            'Open source (AGPL-3.0)',
            'Self-hostable',
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
        SilentSuite handles tasks the same way it handles calendars and
        contacts. Items are encrypted on your device before they leave it.
        Our server stores ciphertext only. We can&apos;t read your tasks
        even if we wanted to, because we don&apos;t have your key.
      </p>

      <p>
        Tasks live in the same account as your calendar and contacts, so
        you don&apos;t need a separate subscription for each PIM category.
        And because we share the Etebase protocol with EteSync, anyone
        coming from EteSync brings their existing task lists with them.
      </p>

      <h2>Comparison table</h2>

      <p>
        Here&apos;s how the popular task apps stack up on encryption,
        openness, and lock-in. We&apos;ve tried to be fair. If something
        is wrong, let us know.
      </p>

      <div className="not-prose overflow-x-auto my-6 rounded-xl border border-navy-700/60">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-navy-900/60">
            <tr>
              <th className="text-left p-3 font-semibold text-navy-300 border-b border-navy-700">
                &nbsp;
              </th>
              {[
                { key: 'todoist', label: 'Todoist' },
                { key: 'mstodo', label: 'MS To Do' },
                { key: 'apple', label: 'Apple Reminders' },
                { key: 'google', label: 'Google Tasks' },
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
              ['E2EE tasks', 'No', 'No', 'Partial', 'No', 'Yes', 'Yes'],
              ['Server can read your tasks', 'Yes', 'Yes', 'Partial', 'Yes', 'No', 'No'],
              ['Cross-platform', 'Yes', 'Yes', 'No', 'Yes', 'Yes', 'Yes'],
              ['Open source', 'No', 'No', 'No', 'No', 'Yes', 'Yes'],
              ['Self-hostable', 'No', 'No', 'No', 'No', 'Yes', 'Yes'],
              ['CalDAV / standard sync', 'No', 'No', 'No', 'No', 'Via bridge', 'Yes*'],
              ['Status', 'Active', 'Active', 'Active', 'Active', 'Abandoned', 'Active'],
              ['Price', 'Free / from $5/mo', 'Free', 'Bundled with iCloud', 'Free', 'Was €2/mo', 'From €3/mo'],
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
          &ldquo;Partial&rdquo; for Apple Reminders means E2EE only when
          Advanced Data Protection is enabled, which is opt-in and not
          available everywhere.
        </em>
      </p>

      <p>
        <em>
          * SilentSuite tasks sync over the Etebase protocol natively. CalDAV
          for tasks (VTODO) is exposed through our standalone bridge for
          third-party clients like Thunderbird.
        </em>
      </p>

      <h2>Is there an end-to-end encrypted Todoist alternative?</h2>

      <p>
        Practically, the choices in 2026 are SilentSuite or staying on a
        stalled EteSync. Proton and Tuta both offer encrypted email and
        calendar but don&apos;t have a real task product. Standard Notes can
        do plaintext to-dos inside encrypted notes, which is closer to a
        notebook than a task list. Joplin can store to-do markdown notes
        encrypted, but it&apos;s a notes app first and not designed around
        the task workflow (recurrence, due dates, reminders, sub-tasks).
      </p>

      <p>
        For dedicated, encrypted, cross-platform task sync that handles
        recurrence and reminders properly, the gap is real and we&apos;re
        one of very few options trying to fill it.
      </p>

      <h2>What about offline-only apps?</h2>

      <p>
        Apps like{' '}
        <a
          href="https://culturedcode.com/things/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Things
        </a>{' '}
        (Apple-only) sync over iCloud and inherit Apple&apos;s trust model.
        Plain-text Markdown systems like Obsidian Tasks store everything
        locally, which is privacy-perfect but breaks the moment you want it
        on your phone too. Org-mode users have decades of clever sync
        solutions, all of which require sysadmin tolerance.
      </p>

      <p>
        Local-first is a legitimate path. SilentSuite isn&apos;t local-only,
        but it is local-first in a meaningful sense: your client holds the
        keys, the server holds ciphertext, and your data is encrypted before
        it leaves the device. You get cross-device sync without giving the
        provider a window into your task list.
      </p>

      <h2>FAQ</h2>

      <p>
        <strong>Is Todoist end-to-end encrypted?</strong>
        <br />
        No. Todoist encrypts data in transit and at rest, but Todoist itself
        can read your tasks. There is no E2EE option in 2026.
      </p>

      <p>
        <strong>Is Apple Reminders end-to-end encrypted?</strong>
        <br />
        Only if you have{' '}
        <a
          href="https://support.apple.com/en-us/HT212520"
          target="_blank"
          rel="noopener noreferrer"
        >
          Advanced Data Protection for iCloud
        </a>{' '}
        enabled. By default, Apple holds the keys and can read reminders.
      </p>

      <p>
        <strong>Is Google Tasks end-to-end encrypted?</strong>
        <br />
        No. Google holds the keys and processes tasks in plaintext, like the
        rest of Google Workspace.
      </p>

      <p>
        <strong>What&apos;s the best encrypted to-do list app?</strong>
        <br />
        For dedicated, cross-platform, end-to-end encrypted task sync with
        proper recurrence and reminders, the realistic options are
        SilentSuite (active, maintained, &euro;3/mo or self-hosted) or
        EteSync (same protocol, no longer maintained). Apple Reminders with
        Advanced Data Protection is a fourth option if you live entirely in
        the Apple ecosystem.
      </p>

      <p>
        <strong>Can I self-host an encrypted task server?</strong>
        <br />
        Yes. SilentSuite&apos;s server is open source under AGPL-3.0 and
        runs on a standard Linux VPS or homelab.
      </p>

      <hr />

      <p>
        Tasks deserve the same encryption as the rest of your data. They
        just usually don&apos;t get it.{' '}
        <a href="https://app.silentsuite.io/signup">
          Sign up for SilentSuite
        </a>{' '}
        if you want a to-do list your provider can&apos;t read.
      </p>
    </>
  )
}
