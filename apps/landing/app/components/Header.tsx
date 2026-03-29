'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Shield, Menu, X, ExternalLink } from 'lucide-react'

const navLinks = [
  { label: 'Blog', href: '/blog' },
  { label: 'Security', href: '/security' },
  { label: 'Pricing', href: '/#pricing' },
  { label: 'FAQ', href: '/#faq' },
  { label: 'GitHub', href: 'https://github.com/silent-suite', external: true },
]

const socialLinks: Array<{ label: string; href: string; rel?: string; icon: React.ReactNode }> = [
  {
    label: 'X',
    href: 'https://x.com/silentsuiteio',
    icon: (
      <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    ),
  },
  {
    label: 'Reddit',
    href: 'https://reddit.com/user/silentsuiteio',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current">
        <path d="M14.238 15.348c.085.084.085.221 0 .306-.465.462-1.194.687-2.231.687l-.008-.002-.008.002c-1.036 0-1.766-.225-2.231-.688-.085-.084-.085-.221 0-.305.084-.084.222-.084.307 0 .379.377 1.008.561 1.924.561l.008.002.008-.002c.915 0 1.544-.184 1.924-.561.085-.084.223-.084.307 0zM9.684 13.348c0-.547.453-.99.998-.99.547 0 .998.443.998.99 0 .547-.451.99-.998.99-.545 0-.998-.443-.998-.99zm4.988-.99c-.547 0-.998.443-.998.99 0 .547.451.99.998.99.547 0 .998-.443.998-.99 0-.547-.453-.99-.998-.99zM12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.492 13.731c.014.107.02.216.02.325 0 2.146-2.496 3.886-5.574 3.886-3.078 0-5.574-1.74-5.574-3.886 0-.11.007-.218.02-.326A1.473 1.473 0 0 1 5.6 12.38a1.478 1.478 0 0 1 2.14-1.317 7.236 7.236 0 0 1 3.936-1.263l.74-3.49a.294.294 0 0 1 .35-.227l2.468.494a1.042 1.042 0 1 1-.104.507l-2.213-.442-.66 3.11a7.208 7.208 0 0 1 3.86 1.26 1.476 1.476 0 0 1 2.133 1.318c0 .503-.257.964-.675 1.238z" />
      </svg>
    ),
  },
  {
    label: 'Mastodon',
    href: 'https://infosec.exchange/@silentsuiteio',
    rel: 'me',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current">
        <path d="M21.327 8.566c0-4.339-2.843-5.61-2.843-5.61-1.433-.658-3.894-.935-6.451-.956h-.063c-2.557.021-5.016.298-6.45.956 0 0-2.843 1.271-2.843 5.61 0 .993-.019 2.181.012 3.441.103 4.243.778 8.425 4.701 9.463 1.809.479 3.362.579 4.612.51 2.268-.126 3.541-.809 3.541-.809l-.075-1.646s-1.621.511-3.441.449c-1.804-.062-3.707-.194-3.999-2.409a4.523 4.523 0 0 1-.04-.621s1.77.432 4.014.535c1.372.063 2.658-.08 3.965-.236 2.506-.299 4.688-1.843 4.962-3.254.434-2.223.398-5.424.398-5.424zm-3.353 5.59h-2.081V9.057c0-1.075-.452-1.62-1.357-1.62-1 0-1.501.647-1.501 1.927v2.791h-2.069V9.364c0-1.28-.501-1.927-1.502-1.927-.904 0-1.357.545-1.357 1.62v5.099H6.026V8.903c0-1.074.273-1.927.823-2.558.566-.631 1.307-.955 2.228-.955 1.065 0 1.872.41 2.405 1.228l.518.869.519-.869c.533-.818 1.34-1.228 2.405-1.228.92 0 1.662.324 2.228.955.549.631.822 1.484.822 2.558v5.253z" />
      </svg>
    ),
  },
]

export default function Header() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const pathname = usePathname()
  const isHome = pathname === '/'
  const mobileMenuRef = useRef<HTMLDivElement>(null)
  const hamburgerRef = useRef<HTMLButtonElement>(null)

  // Escape to close mobile menu
  useEffect(() => {
    if (!mobileOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileOpen(false)
        hamburgerRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [mobileOpen])

  // Focus first link on open
  useEffect(() => {
    if (mobileOpen && mobileMenuRef.current) {
      const first = mobileMenuRef.current.querySelector<HTMLElement>('a, button')
      first?.focus()
    }
  }, [mobileOpen])

  // Focus trap within mobile menu
  const handleMobileMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !mobileMenuRef.current) return
    const focusable = mobileMenuRef.current.querySelectorAll<HTMLElement>(
      'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])'
    )
    if (focusable.length === 0) return
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault()
        last.focus()
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }, [])

  return (
    <header className="fixed top-0 left-0 right-0 z-50">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-navy-950/80 backdrop-blur-md border-b border-navy-700/50" />

      <nav className="relative max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2.5 group">
          <div className="w-8 h-8 rounded-lg bg-teal-400/10 border border-teal-400/20 flex items-center justify-center group-hover:bg-teal-400/20 transition-colors">
            <Shield className="w-4 h-4 text-teal-400" />
          </div>
          <span className="text-white font-semibold text-lg">
            SilentSuite
          </span>
        </Link>

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-8">
          {/* Page links */}
          <div className="flex items-center gap-6">
            {navLinks.map(({ label, href, external }) => (
              <Link
                key={label}
                href={href}
                {...(external
                  ? { target: '_blank', rel: 'noopener noreferrer' }
                  : {})}
                className="text-sm text-navy-300 hover:text-white transition-colors inline-flex items-center gap-1"
              >
                {label}
                {external && <ExternalLink className="w-3 h-3" />}
              </Link>
            ))}
          </div>

          {/* Divider */}
          <div className="h-4 w-px bg-navy-700" />

          {/* Social icons */}
          <div className="flex items-center gap-3">
            {socialLinks.map(({ label, href, icon, rel }) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel={rel ? `${rel} noopener noreferrer` : 'noopener noreferrer'}
                className="text-navy-400 hover:text-white transition-colors"
                title={label}
              >
                {icon}
              </a>
            ))}
          </div>

          {/* CTA */}
          <a
            href="https://app.silentsuite.io/signup"
            className="px-4 py-2 bg-teal-400 hover:bg-teal-500 text-navy-950 text-sm font-semibold rounded-lg transition-colors"
          >
            Get Started
          </a>
        </div>

        {/* Mobile hamburger */}
        <button
          ref={hamburgerRef}
          onClick={() => setMobileOpen(!mobileOpen)}
          className="md:hidden text-navy-300 hover:text-white transition-colors"
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? (
            <X className="w-6 h-6" />
          ) : (
            <Menu className="w-6 h-6" />
          )}
        </button>
      </nav>

      {/* Mobile menu */}
      {mobileOpen && (
        <div
          ref={mobileMenuRef}
          className="relative md:hidden bg-navy-950/95 backdrop-blur-md border-b border-navy-700/50"
          role="menu"
          onKeyDown={handleMobileMenuKeyDown}
        >
          <div className="max-w-6xl mx-auto px-6 py-6 flex flex-col gap-4">
            {navLinks.map(({ label, href, external }) => (
              <Link
                key={label}
                href={href}
                {...(external
                  ? { target: '_blank', rel: 'noopener noreferrer' }
                  : {})}
                onClick={() => setMobileOpen(false)}
                className="text-navy-300 hover:text-white transition-colors py-2 inline-flex items-center gap-1"
              >
                {label}
                {external && <ExternalLink className="w-3 h-3" />}
              </Link>
            ))}

            <div className="h-px bg-navy-700 my-2" />

            {/* Social row */}
            <div className="flex items-center gap-4">
              {socialLinks.map(({ label, href, icon, rel }) => (
                <a
                  key={label}
                  href={href}
                  target="_blank"
                  rel={rel ? `${rel} noopener noreferrer` : 'noopener noreferrer'}
                  className="text-navy-400 hover:text-white transition-colors"
                  title={label}
                >
                  {icon}
                </a>
              ))}
            </div>

            <a
              href="https://app.silentsuite.io/signup"
              onClick={() => setMobileOpen(false)}
              className="mt-2 px-4 py-3 bg-teal-400 hover:bg-teal-500 text-navy-950 text-sm font-semibold rounded-lg transition-colors text-center"
            >
              Get Started
            </a>
          </div>
        </div>
      )}
    </header>
  )
}
