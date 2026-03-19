export interface BlogPost {
  slug: string
  title: string
  description: string
  date: string          // ISO date string (YYYY-MM-DD)
  author: string
  readingTime: string   // e.g. "8 min read"
  tags: string[]
  coverImage?: string   // path relative to /public, e.g. "/blog/cover-slug.png"
}

export const posts: BlogPost[] = [
  {
    slug: 'why-we-are-building-silentsuite',
    title: 'Why We\'re Building an Encrypted Alternative to Google Calendar',
    description:
      'Your calendar knows more about you than your diary. Every doctor\'s appointment, every meeting, every relationship. Synced to servers that can read it all. We\'re building something better.',
    date: '2026-03-12',
    author: 'Timo',
    readingTime: '8 min read',
    tags: ['privacy', 'encryption', 'announcement'],
    coverImage: '/blog/cover-why-we-are-building-silentsuite.png',
  },
  {
    slug: 'who-can-read-your-calendar',
    title: 'Who Can Read Your Calendar? A Privacy Guide for 2026',
    description:
      'Your calendar reveals more about you than your email. We compared Google, Apple, Microsoft, Proton, Tuta, Nextcloud, and SilentSuite on encryption, key ownership, and openness.',
    date: '2026-03-17',
    author: 'Timo',
    readingTime: '7 min read',
    tags: ['privacy', 'encryption', 'comparison'],
    coverImage: '/blog/cover-who-can-read-your-calendar.png',
  },
  // --- DRAFTS (cover images ready in public/blog/, publish one at a time) ---
  // {
  //   slug: 'silentsuite-vs-google-calendar',
  //   title: 'SilentSuite vs Google Calendar: What Google Knows About Your Schedule',
  //   description:
  //     'Every event you create in Google Calendar is processed in plaintext on Google\'s servers. We break down what Google sees, what "encrypted at rest" really means, and how zero-knowledge encryption changes things.',
  //   date: '2026-03-14',
  //   author: 'Timo',
  //   readingTime: '8 min read',
  //   tags: ['privacy', 'comparison', 'encryption'],
  //   coverImage: '/blog/cover-silentsuite-vs-google-calendar.png',
  // },
  // {
  //   slug: 'encrypted-calendar-sync-2026-comparing-options',
  //   title: 'Encrypted Calendar Sync in 2026: Comparing Your Options',
  //   description:
  //     'There are now multiple services offering encrypted calendar sync. Most are incomplete, ecosystem-locked, or abandoned. We compare Proton, Tuta, EteSync, Nextcloud, and SilentSuite.',
  //   date: '2026-03-20',
  //   author: 'Timo',
  //   readingTime: '10 min read',
  //   tags: ['privacy', 'encryption', 'comparison'],
  //   coverImage: '/blog/cover-encrypted-calendar-sync-2026-comparing-options.png',
  // },
  // {
  //   slug: 'self-hosting-vs-hosted-private-calendar',
  //   title: 'Self-Hosting vs Hosted: Which Private Calendar Setup Is Right for You?',
  //   description:
  //     'Self-host everything is the default advice in privacy circles. But does it actually make your calendar more secure? We compare self-hosted CalDAV, hosted E2EE services, and the hybrid option.',
  //   date: '2026-03-24',
  //   author: 'Timo',
  //   readingTime: '8 min read',
  //   tags: ['privacy', 'self-hosting', 'encryption'],
  //   coverImage: '/blog/cover-self-hosting-vs-hosted-private-calendar.png',
  // },
]

export function getPost(slug: string): BlogPost | undefined {
  return posts.find((p) => p.slug === slug)
}

export function getAllPosts(): BlogPost[] {
  return [...posts].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  )
}
