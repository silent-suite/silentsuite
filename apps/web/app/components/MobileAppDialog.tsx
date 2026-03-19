'use client'

import { useCallback, useEffect, useRef } from 'react'
import { Smartphone, X, ExternalLink, QrCode } from 'lucide-react'

interface MobileAppDialogProps {
  open: boolean
  onClose: () => void
}

export function MobileAppDialog({ open, onClose }: MobileAppDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)

  // Close on Escape
  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  // Generate a simple QR-code-like placeholder using CSS
  // In production, you'd use a QR code library or pre-generated image
  const downloadUrl = 'https://docs.silentsuite.io/mobile'

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[60] bg-black/40 transition-opacity"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="fixed inset-0 z-[61] flex items-center justify-center p-4">
        <div
          ref={dialogRef}
          role="dialog"
          aria-label="Get the mobile app"
          aria-modal="true"
          className="w-full max-w-sm rounded-xl border border-[rgb(var(--border))] bg-[rgb(var(--background))] shadow-xl"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[rgb(var(--border))] px-4 py-3">
            <div className="flex items-center gap-2">
              <Smartphone className="h-5 w-5 text-[rgb(var(--primary))]" />
              <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">
                Get the mobile app
              </h2>
            </div>
            <button
              onClick={onClose}
              className="rounded-md p-1 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body */}
          <div className="px-4 py-5 space-y-5">
            <p className="text-sm text-[rgb(var(--muted))]">
              Access your encrypted calendar, tasks, and contacts on the go.
              Scan the QR code with your phone or visit the link below.
            </p>

            {/* QR Code area */}
            <div className="flex flex-col items-center gap-3">
              <div className="flex h-48 w-48 items-center justify-center rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))]">
                {/* QR code placeholder - replace with actual QR generation */}
                <div className="flex flex-col items-center gap-2 text-[rgb(var(--muted))]">
                  <QrCode className="h-24 w-24" />
                  <span className="text-[10px]">Scan to download</span>
                </div>
              </div>
              <p className="text-xs text-[rgb(var(--muted))]">
                Available for Android. iOS coming soon.
              </p>
            </div>

            {/* Links */}
            <div className="space-y-2">
              <a
                href={downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-[rgb(var(--primary))] px-4 py-2.5 text-sm font-medium text-white hover:bg-[rgb(var(--primary-hover))] transition-colors"
              >
                <ExternalLink className="h-4 w-4" />
                View setup instructions
              </a>
              <a
                href="https://docs.silentsuite.io"
                target="_blank"
                rel="noopener noreferrer"
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-4 py-2.5 text-sm font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--border))]/30 transition-colors"
              >
                Read the docs
              </a>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
