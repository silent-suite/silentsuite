import { Lock } from 'lucide-react'

export type BrowserFrameVariant = 'safari' | 'minimal'

interface BrowserFrameProps {
  variant?: BrowserFrameVariant
  url?: string
  children: React.ReactNode
  className?: string
}

/**
 * Window frame around an app mockup.
 *
 *   variant="safari"  — traffic-light dots + a URL pill (the most identifiable
 *                       "this is a real app" treatment without going full Chrome).
 *   variant="minimal" — no chrome, just rounded corners + ring + drop shadow,
 *                       in the Linear / Obsidian / Vercel style.
 *
 * The shadow on both variants is matte (slate-900 at low opacity), not pure
 * black, to avoid the 2014-skeuomorphic look.
 */
export default function BrowserFrame({
  variant = 'safari',
  url = 'app.silentsuite.io',
  children,
  className = '',
}: BrowserFrameProps) {
  return (
    <div
      className={`relative rounded-xl overflow-hidden ring-1 ring-white/10 bg-navy-900 ${className}`}
      style={{
        boxShadow:
          '0 30px 60px -20px rgba(15, 23, 42, 0.5), 0 8px 24px -8px rgba(15, 23, 42, 0.3)',
      }}
    >
      {variant === 'safari' ? (
        <div className="flex items-center gap-3 px-4 h-9 bg-navy-900 border-b border-white/5">
          {/* Traffic lights */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
            <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
            <span className="w-3 h-3 rounded-full bg-[#28c840]" />
          </div>
          {/* URL pill */}
          <div className="flex-1 flex justify-center">
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-navy-950/80 text-navy-300 text-xs font-medium max-w-md w-full justify-center">
              <Lock className="w-3 h-3 text-teal-400" aria-hidden="true" />
              <span className="truncate">{url}</span>
            </div>
          </div>
          {/* Right spacer to balance the URL pill centering against the dots */}
          <div className="w-[52px] flex-shrink-0" aria-hidden="true" />
        </div>
      ) : null}

      <div className="bg-navy-950">{children}</div>
    </div>
  )
}
