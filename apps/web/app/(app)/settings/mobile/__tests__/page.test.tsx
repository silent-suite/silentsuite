// @vitest-environment jsdom
import React from 'react'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import MobileSettingsPage from '../page'

vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value, size, className }: { value: string; size?: number; className?: string }) => (
    <svg data-testid="android-download-qr" data-value={value} data-size={size} className={className} />
  ),
}))

vi.mock('next/image', () => ({
  default: ({
    src,
    alt = '',
    unoptimized,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & { unoptimized?: boolean }) => (
    <img src={String(src)} alt={alt} data-unoptimized={unoptimized ? 'true' : 'false'} {...props} />
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
      name: 'F-Droid, on the roadmap. Pending official inclusion',
    })).toBeInTheDocument()
    expect(screen.getByText('Soon')).toBeInTheDocument()
    expect(screen.getByText(/Pending official inclusion/i)).toBeInTheDocument()
    const directApk = screen.getByRole('link', { name: /Direct APK/i })
    expect(directApk).toHaveAttribute(
      'href',
      'https://github.com/silent-suite/silentsuite/releases/latest',
    )
    expect(directApk).not.toHaveClass('min-h-28')
    expect(directApk.closest('[data-android-managed-channels]')).toBeNull()

    for (const src of [
      '/channel-icons/google-play.svg',
      '/channel-icons/obtainium.svg',
      '/channel-icons/zapstore.png',
      '/channel-icons/fdroid.png',
      '/channel-icons/github.svg',
    ]) {
      expect(document.querySelector(`img[src="${src}"]`)).toBeInTheDocument()
      expect(existsSync(resolve(process.cwd(), `public${src}`))).toBe(true)
    }

    expect(screen.getByText('On the roadmap, coming soon')).toBeInTheDocument()
    expect(screen.getByText('iOS is not currently supported.')).toBeInTheDocument()
    expect(screen.queryByText(/EteSync iOS app/i)).not.toBeInTheDocument()
  })

  it('keeps one responsive QR code pointed at the canonical Android guide', () => {
    render(<MobileSettingsPage />)

    const qr = screen.getByTestId('android-download-qr')
    expect(qr).toHaveAttribute('data-value', 'https://docs.silentsuite.io/user-guide/apps/android')
    expect(qr).toHaveAttribute('data-size', '144')
    expect(qr.closest('[data-android-download-qr]')).toHaveClass(
      'hidden',
      'lg:flex',
      'lg:col-start-3',
      'lg:row-start-1',
      'lg:row-span-2',
    )
    expect(qr.closest('a')).toHaveClass('min-h-28', 'rounded-lg')
    expect(screen.getByRole('link', { name: /Google Play/i })).toHaveClass('min-h-28', 'rounded-lg')
  })

  it('delivers Zapstore and F-Droid PNG marks directly without image optimization', () => {
    render(<MobileSettingsPage />)

    for (const channel of ['zapstore', 'fdroid']) {
      const image = document.querySelector(`img[src="/channel-icons/${channel}.png"]`)
      expect(image).toBeInTheDocument()
      expect(image).toHaveAttribute('data-unoptimized', 'true')
    }
  })

  it('uses a responsive two-by-two managed grid beside the spanning desktop QR card', () => {
    render(<MobileSettingsPage />)

    const grid = document.querySelector('[data-android-managed-channels]')
    expect(grid).toHaveClass(
      'grid',
      'sm:grid-cols-2',
      'lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(15rem,0.9fr)]',
      'lg:grid-rows-2',
    )
    expect(
      Array.from(grid?.querySelectorAll('[data-android-channel]') ?? []).map((card) =>
        card.getAttribute('data-android-channel'),
      ),
    ).toEqual(['Google Play', 'Zapstore', 'Obtainium', 'F-Droid'])

    const directApk = screen.getByRole('link', { name: /Direct APK/i })
    expect(directApk.closest('[data-android-managed-channels]')).toBeNull()
  })

  it('keeps active channels keyboard-visible and safe when opening external destinations', () => {
    render(<MobileSettingsPage />)

    for (const name of ['Google Play', 'Zapstore', 'Obtainium']) {
      const link = screen.getByRole('link', { name: new RegExp(name, 'i') })
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
      expect(link).toHaveClass('focus-visible:ring-2')
    }

    expect(screen.getByRole('group', {
      name: 'F-Droid, on the roadmap. Pending official inclusion',
    })).toHaveAttribute('aria-disabled', 'true')
  })
})
