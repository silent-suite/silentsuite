'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useTheme } from 'next-themes'
import { Shield, ShieldCheck, Calendar, CheckSquare, Users, Sun, Moon, Lock, EyeOff, Globe } from 'lucide-react'

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const { theme, setTheme, resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  const isDark = mounted ? resolvedTheme === 'dark' : true

  return (
    <div className={`relative flex min-h-screen items-center justify-center overflow-hidden transition-colors duration-300 ${
      isDark ? 'bg-gradient-to-br from-navy-950 via-navy-900 to-emerald-950/20' : 'bg-gradient-to-br from-gray-50 via-white to-emerald-50/30'
    }`}>
      {/* Subtle grid pattern background */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        aria-hidden="true"
        style={{
          backgroundImage: isDark
            ? 'linear-gradient(rgba(52,211,153,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(52,211,153,0.3) 1px, transparent 1px)'
            : 'linear-gradient(rgba(16,185,129,0.15) 1px, transparent 1px), linear-gradient(90deg, rgba(16,185,129,0.15) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      {/* Multi-color gradient orbs */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full blur-3xl" aria-hidden="true"
        style={{ background: isDark
          ? 'radial-gradient(circle, rgba(52,211,153,0.06) 0%, rgba(59,130,246,0.03) 50%, transparent 70%)'
          : 'radial-gradient(circle, rgba(16,185,129,0.08) 0%, rgba(59,130,246,0.04) 50%, transparent 70%)'
        }}
      />
      <div className="pointer-events-none absolute -top-32 -right-32 h-[400px] w-[400px] rounded-full blur-3xl" aria-hidden="true"
        style={{ background: isDark
          ? 'radial-gradient(circle, rgba(139,92,246,0.05) 0%, transparent 70%)'
          : 'radial-gradient(circle, rgba(139,92,246,0.06) 0%, transparent 70%)'
        }}
      />
      <div className="pointer-events-none absolute -bottom-32 -left-32 h-[400px] w-[400px] rounded-full blur-3xl" aria-hidden="true"
        style={{ background: isDark
          ? 'radial-gradient(circle, rgba(59,130,246,0.04) 0%, transparent 70%)'
          : 'radial-gradient(circle, rgba(59,130,246,0.05) 0%, transparent 70%)'
        }}
      />

      {/* Floating productivity icons */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <Calendar className={`absolute top-[12%] left-[8%] h-8 w-8 ${isDark ? 'text-emerald-500/[0.08]' : 'text-emerald-600/[0.12]'} rotate-[-15deg]`} />
        <CheckSquare className={`absolute top-[18%] right-[12%] h-7 w-7 ${isDark ? 'text-blue-400/[0.08]' : 'text-blue-500/[0.12]'} rotate-[10deg]`} />
        <Users className={`absolute bottom-[20%] left-[10%] h-7 w-7 ${isDark ? 'text-purple-400/[0.08]' : 'text-purple-500/[0.12]'} rotate-[8deg]`} />
        <Calendar className={`absolute bottom-[15%] right-[8%] h-6 w-6 ${isDark ? 'text-emerald-400/[0.08]' : 'text-emerald-500/[0.12]'} rotate-[-8deg]`} />
        <ShieldCheck className={`absolute top-[40%] left-[5%] h-6 w-6 ${isDark ? 'text-emerald-400/[0.08]' : 'text-emerald-500/[0.12]'} rotate-[12deg]`} />
        <CheckSquare className={`absolute top-[55%] right-[6%] h-5 w-5 ${isDark ? 'text-violet-400/[0.08]' : 'text-violet-500/[0.12]'} rotate-[-12deg]`} />
        <Users className={`absolute top-[8%] left-[45%] h-5 w-5 ${isDark ? 'text-blue-400/[0.08]' : 'text-blue-500/[0.12]'} rotate-[20deg]`} />
        <Shield className={`absolute bottom-[8%] right-[40%] h-6 w-6 ${isDark ? 'text-emerald-400/[0.08]' : 'text-emerald-500/[0.12]'} rotate-[-5deg]`} />
      </div>

      <div className="relative z-10 w-full max-w-2xl px-3 sm:px-4">
        {/* Theme toggle */}
        {mounted && (
          <div className="absolute top-4 right-4 sm:top-2 sm:right-0">
            <button
              onClick={() => setTheme(isDark ? 'light' : 'dark')}
              className={`rounded-full p-2 transition-colors ${
                isDark
                  ? 'text-navy-400 hover:text-white hover:bg-navy-800'
                  : 'text-gray-400 hover:text-gray-700 hover:bg-gray-200'
              }`}
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        )}

        <div className="mb-4 sm:mb-8 flex flex-col items-center text-center">
          <div className="flex items-center gap-2.5">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
              isDark
                ? 'bg-emerald-400/10 border border-emerald-400/20'
                : 'bg-emerald-500/10 border border-emerald-500/20'
            }`}>
              <Shield className={`w-4 h-4 ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`} aria-hidden="true" />
            </div>
            <span className={`font-semibold text-lg transition-colors ${isDark ? 'text-white' : 'text-gray-900'}`}>
              SilentSuite
            </span>
          </div>
          <div className="mt-2 sm:mt-3 flex items-center gap-1.5">
            <ShieldCheck className="h-4 w-4 text-emerald-500" aria-hidden="true" />
            <p className="text-sm font-medium text-emerald-500">
              End-to-End Encrypted Productivity
            </p>
          </div>
        </div>
        {/* Trust signals bar */}
        <div className={`mb-3 sm:mb-6 flex flex-wrap items-center justify-center gap-3 sm:gap-6 text-xs transition-colors ${
          isDark ? 'text-navy-400' : 'text-gray-500'
        }`}>
          <div className="flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5 text-emerald-500" />
            <span>End-to-end encrypted</span>
          </div>
          <div className="flex items-center gap-1.5">
            <EyeOff className="h-3.5 w-3.5 text-emerald-500" />
            <span>Zero-knowledge</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Globe className="h-3.5 w-3.5 text-emerald-500" />
            <span>Your Data, Your Control</span>
          </div>
        </div>

        <div className={`rounded-xl border backdrop-blur-sm px-4 py-6 sm:px-8 sm:py-8 shadow-2xl transition-colors ${
          isDark
            ? 'border-navy-800 bg-navy-900/80'
            : 'border-gray-200 bg-white/80'
        }`}>
          {children}
        </div>

        {/* Terms and conditions */}
        {pathname === '/signup' && (
          <p className={`mt-6 text-center text-xs transition-colors ${isDark ? 'text-navy-500' : 'text-gray-400'}`}>
            By continuing, you agree to our{' '}
            <a
              href="https://silentsuite.io/terms"
              target="_blank"
              rel="noopener noreferrer"
              className={`underline transition-colors ${isDark ? 'hover:text-navy-300' : 'hover:text-gray-600'}`}
            >
              Terms and Conditions
            </a>{' '}
            and{' '}
            <a
              href="https://silentsuite.io/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className={`underline transition-colors ${isDark ? 'hover:text-navy-300' : 'hover:text-gray-600'}`}
            >
              Privacy Policy
            </a>
            .
          </p>
        )}
      </div>
    </div>
  )
}
