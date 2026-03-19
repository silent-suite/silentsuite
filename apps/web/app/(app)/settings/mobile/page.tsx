'use client'

import { Smartphone, ExternalLink, QrCode } from 'lucide-react'

export default function MobileSettingsPage() {
  const downloadUrl = 'https://docs.silentsuite.io/mobile'

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-base font-semibold text-[rgb(var(--foreground))]">
          Connect Mobile
        </h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          Access your encrypted calendar, tasks, and contacts on your phone.
        </p>
      </div>

      {/* QR Code section */}
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-6">
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-48 w-48 items-center justify-center rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))]">
            <div className="flex flex-col items-center gap-2 text-[rgb(var(--muted))]">
              <QrCode className="h-24 w-24" />
              <span className="text-[10px]">Scan to download</span>
            </div>
          </div>
          <p className="text-sm text-[rgb(var(--foreground))] font-medium">
            Scan with your phone camera
          </p>
          <p className="text-xs text-[rgb(var(--muted))] text-center">
            The QR code will take you to the mobile app download page.
            Currently available for Android. iOS coming soon.
          </p>
        </div>
      </div>

      {/* Manual setup */}
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 space-y-4">
        <div className="flex items-center gap-3">
          <Smartphone className="h-5 w-5 text-[rgb(var(--primary))]" />
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Manual setup</p>
            <p className="text-xs text-[rgb(var(--muted))]">
              Follow the documentation to set up the mobile app manually
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <a
            href={downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-lg bg-[rgb(var(--primary))] px-4 py-2.5 text-sm font-medium text-white hover:bg-[rgb(var(--primary-hover))] transition-colors"
          >
            <ExternalLink className="h-4 w-4" />
            View setup instructions
          </a>
          <a
            href="https://docs.silentsuite.io"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-lg border border-[rgb(var(--border))] px-4 py-2.5 text-sm font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] transition-colors"
          >
            Read the full documentation
          </a>
        </div>
      </div>

      {/* Supported platforms */}
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 space-y-3">
        <p className="text-sm font-medium text-[rgb(var(--foreground))]">Supported platforms</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] p-3 text-center">
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Android</p>
            <p className="text-xs text-[rgb(var(--primary))]">Available now</p>
          </div>
          <div className="rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] p-3 text-center">
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">iOS</p>
            <p className="text-xs text-[rgb(var(--muted))]">Coming soon</p>
          </div>
        </div>
      </div>
    </div>
  )
}
