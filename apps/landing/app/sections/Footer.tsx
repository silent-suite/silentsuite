import { Shield } from 'lucide-react'

const links = [
  { label: 'Blog', href: '/blog' },
  { label: 'Security', href: '/security' },
  { label: 'Privacy Policy', href: '/privacy' },
  { label: 'Terms', href: '/terms' },
  { label: 'GitHub', href: 'https://github.com/silent-suite', external: true },
  { label: 'Contact', href: 'mailto:info@silentsuite.io', external: true },
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
      <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current">
        <path d="M14.238 15.348c.085.084.085.221 0 .306-.465.462-1.194.687-2.231.687l-.008-.002-.008.002c-1.036 0-1.766-.225-2.231-.688-.085-.084-.085-.221 0-.305.084-.084.222-.084.307 0 .379.377 1.008.561 1.924.561l.008.002.008-.002c.915 0 1.544-.184 1.924-.561.085-.084.223-.084.307 0zM9.684 13.348c0-.547.453-.99.998-.99.547 0 .998.443.998.99 0 .547-.451.99-.998.99-.545 0-.998-.443-.998-.99zm4.988-.99c-.547 0-.998.443-.998.99 0 .547.451.99.998.99.547 0 .998-.443.998-.99 0-.547-.453-.99-.998-.99zM12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.492 13.731c.014.107.02.216.02.325 0 2.146-2.496 3.886-5.574 3.886-3.078 0-5.574-1.74-5.574-3.886 0-.11.007-.218.02-.326A1.473 1.473 0 0 1 5.6 12.38a1.478 1.478 0 0 1 2.14-1.317 7.236 7.236 0 0 1 3.936-1.263l.74-3.49a.294.294 0 0 1 .35-.227l2.468.494a1.042 1.042 0 1 1-.104.507l-2.213-.442-.66 3.11a7.208 7.208 0 0 1 3.86 1.26 1.476 1.476 0 0 1 2.133 1.318c0 .503-.257.964-.675 1.238z" />
      </svg>
    ),
  },
  {
    label: 'Mastodon',
    href: 'https://infosec.exchange/@silentsuiteio',
    rel: 'me',
    icon: (
      <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current">
        <path d="M21.327 8.566c0-4.339-2.843-5.61-2.843-5.61-1.433-.658-3.894-.935-6.451-.956h-.063c-2.557.021-5.016.298-6.45.956 0 0-2.843 1.271-2.843 5.61 0 .993-.019 2.181.012 3.441.103 4.243.778 8.425 4.701 9.463 1.809.479 3.362.579 4.612.51 2.268-.126 3.541-.809 3.541-.809l-.075-1.646s-1.621.511-3.441.449c-1.804-.062-3.707-.194-3.999-2.409a4.523 4.523 0 0 1-.04-.621s1.77.432 4.014.535c1.372.063 2.658-.08 3.965-.236 2.506-.299 4.688-1.843 4.962-3.254.434-2.223.398-5.424.398-5.424zm-3.353 5.59h-2.081V9.057c0-1.075-.452-1.62-1.357-1.62-1 0-1.501.647-1.501 1.927v2.791h-2.069V9.364c0-1.28-.501-1.927-1.502-1.927-.904 0-1.357.545-1.357 1.62v5.099H6.026V8.903c0-1.074.273-1.927.823-2.558.566-.631 1.307-.955 2.228-.955 1.065 0 1.872.41 2.405 1.228l.518.869.519-.869c.533-.818 1.34-1.228 2.405-1.228.92 0 1.662.324 2.228.955.549.631.822 1.484.822 2.558v5.253z" />
      </svg>
    ),
  },
  {
    label: 'GitHub',
    href: 'https://github.com/silent-suite',
    icon: (
      <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current">
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
      </svg>
    ),
  },
]

export default function Footer() {
  return (
    <footer className="bg-navy-950 border-t border-navy-700 text-navy-400">
      <div className="max-w-5xl mx-auto px-6 py-12">
        <div className="flex flex-col md:flex-row items-center justify-between gap-8">
          {/* Brand */}
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-teal-400/10 border border-teal-400/20 flex items-center justify-center">
              <Shield className="w-4 h-4 text-teal-400" />
            </div>
            <div>
              <p className="text-white font-semibold text-sm">SilentSuite</p>
              <p className="text-xs text-navy-500">Private Sync, By Design.</p>
            </div>
          </div>

          {/* Links */}
          <nav className="flex flex-wrap items-center justify-center gap-6 text-sm">
            {links.map(({ label, href, external }) => (
              <a
                key={label}
                href={href}
                {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                className="hover:text-white transition-colors"
              >
                {label}
              </a>
            ))}
          </nav>
        </div>

        <div className="mt-8 pt-8 border-t border-navy-700 flex flex-col md:flex-row items-center justify-between gap-4 text-xs text-navy-500">
          <p>&copy; {new Date().getFullYear()} SilentSuite. All rights reserved.</p>

          {/* Social icons */}
          <div className="flex items-center gap-4">
            {socialLinks.map(({ label, href, icon, rel }) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel={rel ? `${rel} noopener noreferrer` : 'noopener noreferrer'}
                className="text-navy-500 hover:text-white transition-colors"
                title={label}
              >
                {icon}
              </a>
            ))}
          </div>

          <p>
            Built for privacy. Open source. Your data, your control.
          </p>
        </div>
      </div>
    </footer>
  )
}
