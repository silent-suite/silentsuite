import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import Header from './components/Header'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })

export const metadata: Metadata = {
  metadataBase: new URL('https://silentsuite.io'),
  title: 'SilentSuite — Encrypted PIM Sync',
  description: 'Calendar, contacts & tasks synced with end-to-end encryption. As easy as iCloud, as private as Signal.',
  keywords: ['encrypted sync', 'privacy', 'calendar', 'contacts', 'E2EE', 'secure'],
  alternates: {
    types: {
      'application/rss+xml': '/blog/feed.xml',
    },
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={inter.variable}>
      <head>
        <link rel="me" href="https://techhub.social/@silentsuiteio" />
        <link rel="me" href="https://infosec.exchange/@silentsuiteio" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'Organization',
              name: 'SilentSuite',
              url: 'https://silentsuite.io',
              description: 'End-to-end encrypted calendar, contacts and tasks sync service',
              sameAs: [
                'https://techhub.social/@silentsuiteio',
                'https://infosec.exchange/@silentsuiteio',
              ],
            }),
          }}
        />
      </head>
      <body className="font-sans antialiased">
        <Header />
        {children}
      </body>
    </html>
  )
}
