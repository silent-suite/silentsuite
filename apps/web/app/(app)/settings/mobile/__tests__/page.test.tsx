// @vitest-environment jsdom
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import MobileSettingsPage from '../page'

vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value, className }: { value: string; className?: string }) => (
    <svg data-testid="android-download-qr" data-value={value} className={className} />
  ),
}))

describe('MobileSettingsPage Android download choices', () => {
  it('offers active channels, a pending F-Droid state, and direct APK access', () => {
    render(<MobileSettingsPage />)

    expect(screen.getByRole('link', { name: /Google Play/i })).toHaveAttribute(
      'href',
      'https://play.google.com/store/apps/details?id=io.silentsuite.android',
    )
    expect(screen.getByRole('link', { name: /Obtainium/i })).toHaveAttribute(
      'href',
      'https://docs.silentsuite.io/user-guide/apps/android',
    )
    expect(screen.getByRole('link', { name: /Zapstore/i })).toHaveAttribute(
      'href',
      'https://zapstore.dev/apps/io.silentsuite.android',
    )
    expect(screen.getByText(/release timing may differ by channel/i)).toBeInTheDocument()
    expect(screen.queryByText(/work the same across every channel/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /F-Droid/i })).not.toBeInTheDocument()
    expect(screen.getByRole('group', {
      name: 'F-Droid, soon. Pending official inclusion',
    })).toBeInTheDocument()
    expect(screen.getByText('Soon')).toBeInTheDocument()
    expect(screen.getByText(/Pending official inclusion/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Download the signed APK/i })).toHaveAttribute(
      'href',
      'https://github.com/silent-suite/silentsuite/releases/latest',
    )
  })

  it('keeps one responsive QR code pointed at the canonical Android guide', () => {
    render(<MobileSettingsPage />)

    const qr = screen.getByTestId('android-download-qr')
    expect(qr).toHaveAttribute('data-value', 'https://docs.silentsuite.io/user-guide/apps/android')
    expect(qr.closest('[data-android-download-qr]')).toHaveClass('hidden', 'md:block')
  })
})
