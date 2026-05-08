import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import { ThemeProvider } from 'next-themes'
import { AuthProvider } from '@/app/providers/auth-provider'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })

export const metadata: Metadata = {
  title: 'SilentSuite',
  description: 'End-to-end encrypted productivity suite',
  manifest: '/manifest.json',
  // Next picks up app/icon.svg and app/apple-icon.svg automatically, which now
  // match the landing page shield. The PNGs in public/ are kept for the PWA
  // manifest but no longer advertised in <head>.
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'SilentSuite',
  },
}

export const viewport: Viewport = {
  themeColor: '#0f172a',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="font-sans">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <AuthProvider>
            {children}
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
