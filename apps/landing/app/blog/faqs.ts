/**
 * Per-post FAQ Q&A pairs, used to emit FAQPage JSON-LD on blog posts that
 * have an FAQ section in their body. Kept here rather than in the post
 * component so the structured-data text stays in lockstep with the rendered
 * copy without scraping it at build time.
 *
 * Only posts whose body has an `<h2>FAQ</h2>` block belong in this map.
 */
export interface FaqEntry {
  q: string
  a: string
}

export const POST_FAQS: Record<string, FaqEntry[]> = {
  'encrypted-tasks-and-todo-lists-2026': [
    {
      q: 'Is Todoist end-to-end encrypted?',
      a: 'No. Todoist encrypts data in transit and at rest, but Todoist itself can read your tasks. There is no E2EE option in 2026.',
    },
    {
      q: 'Is Apple Reminders end-to-end encrypted?',
      a: 'Only if you have Advanced Data Protection for iCloud enabled. By default, Apple holds the keys and can read reminders.',
    },
    {
      q: 'Is Google Tasks end-to-end encrypted?',
      a: 'No. Google holds the keys and processes tasks in plaintext, like the rest of Google Workspace.',
    },
    {
      q: "What's the best encrypted to-do list app?",
      a: 'For dedicated, cross-platform, end-to-end encrypted task sync with proper recurrence and reminders, the realistic options are SilentSuite (active, maintained, €3/mo or self-hosted) or EteSync (same protocol, no longer maintained). Apple Reminders with Advanced Data Protection is a fourth option if you live entirely in the Apple ecosystem.',
    },
    {
      q: 'Can I self-host an encrypted task server?',
      a: "Yes. SilentSuite's server is open source under AGPL-3.0 and runs on a standard Linux VPS or homelab.",
    },
  ],

  'encrypted-contacts-2026-your-social-graph': [
    {
      q: 'Is Google Contacts end-to-end encrypted?',
      a: 'No. Google holds the keys and processes contacts in plaintext.',
    },
    {
      q: 'Is iCloud Contacts end-to-end encrypted?',
      a: 'Only with Advanced Data Protection enabled, which is opt-in and unavailable in some regions.',
    },
    {
      q: 'Is Proton Contacts end-to-end encrypted?',
      a: 'Partially. Proton encrypts notes and custom fields. Names, email addresses, and phone numbers are stored unencrypted so Proton Mail can use them.',
    },
    {
      q: 'Can I use SilentSuite contacts in Apple Contacts or Thunderbird?',
      a: 'Yes, through our standalone CardDAV bridge. The bridge decrypts locally and exposes your contacts to standard apps.',
    },
    {
      q: 'Does SilentSuite support vCard import and export?',
      a: 'Yes. Standard .vcf files in and out, no lock-in. Useful for migrating in from Google or out to wherever you want to go next.',
    },
  ],

  'walled-gardens-vs-system-integration-encrypted-pim': [
    {
      q: 'Why did Proton not build a CalDAV bridge?',
      a: 'Because exposing your encrypted contacts and calendar to the operating system would let any app with permission read them. Proton built an IMAP bridge for email because email is already widely shared, but kept calendar and contacts walled off as a deliberate privacy property.',
    },
    {
      q: 'Can I use SilentSuite as a walled garden, like Proton?',
      a: "Yes. Use the SilentSuite web app and Android app only. Don't install the bridge and don't configure CalDAV/CardDAV in your OS. Your encrypted PIM data stays inside SilentSuite's own apps.",
    },
    {
      q: 'Is system integration safe on GrapheneOS?',
      a: 'Yes, in the sense that GrapheneOS gives you the tools to make it safe. You install only the apps you actually want, you grant contacts and calendar permission deliberately, and the OS itself does not phone home with your data. On stock Android the same setup is harder to defend.',
    },
    {
      q: 'Can I mix the two modes on different devices?',
      a: 'Yes. The encrypted store is one. Where you decrypt it is a per-device choice. Bridge on your trusted Linux laptop and GrapheneOS phone, webapp-only on your work machine.',
    },
    {
      q: 'If I leave SilentSuite, can I take my data?',
      a: 'Yes. Standard .ics and .vcf exports work from the web client. The Etebase server is open source if you want to keep running on the same protocol with someone else, or yourself.',
    },
  ],

  'looking-for-an-etesync-alternative': [
    {
      q: 'Is SilentSuite the same protocol as EteSync?',
      a: 'Yes. We use Etebase under the hood, the same protocol EteSync built. Existing iOS users of the EteSync app can point it at a SilentSuite server today and it works.',
    },
    {
      q: 'Is SilentSuite end-to-end encrypted?',
      a: "Yes. Calendars, contacts, and tasks are encrypted on your device before they reach our server. We hold ciphertext only. We can't read your events, contacts, or tasks even if we wanted to.",
    },
    {
      q: 'Can I self-host SilentSuite?',
      a: 'Yes. The server is open source under AGPL-3.0. You can run it on your own VPS or homelab and point our clients at it.',
    },
    {
      q: 'How much does SilentSuite cost?',
      a: 'From €3/mo for the hosted plan. Self-hosting is free, you only pay for the infrastructure you run.',
    },
    {
      q: 'Does SilentSuite work with Apple Calendar or Thunderbird?',
      a: 'Yes, through our standalone CalDAV bridge. Install the bridge, sign in with your SilentSuite account, and your encrypted data appears in Apple Calendar, Thunderbird, or any CalDAV/CardDAV-compatible client.',
    },
    {
      q: 'What happens to my data if SilentSuite shuts down?',
      a: 'You can export your collections at any time as standard .ics / .vcf files. The server is open source, so you (or anyone) can run it independently. Data lock-in is not part of our model.',
    },
  ],
}
