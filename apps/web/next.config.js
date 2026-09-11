const path = require('path')
const createNextIntlPlugin = require('next-intl/plugin')
const withPWA = require('@ducanh2912/next-pwa').default
const { withSentryConfig } = require('@sentry/nextjs')

const withNextIntl = createNextIntlPlugin('./i18n/request.ts')
const hostedConnectSources = "connect-src 'self' https://api.silentsuite.io https://server.silentsuite.io wss://server.silentsuite.io https://*.sentry.io"
const signupConnectSources = `${hostedConnectSources} https://plausible.silentsuite.io https://api.stripe.com`
const subscriptionConnectSources = `${hostedConnectSources} https://plausible.silentsuite.io`

// Resolve etebase CJS entry — it's a dep of @silentsuite/core,
// not directly in apps/web's node_modules (pnpm strict isolation).
function resolveEtebase() {
  try {
    return require.resolve('etebase')
  } catch {
    // Fallback: resolve through @silentsuite/core's dependency tree
    const corePkg = require.resolve('@silentsuite/core/package.json')
    const coreDir = path.dirname(corePkg)
    return require.resolve('etebase', { paths: [coreDir] })
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    // ESLint runs as a separate CI step; skip during builds
    ignoreDuringBuilds: true,
  },
  transpilePackages: ['@silentsuite/ui', '@silentsuite/core'],
  async headers() {
    if (process.env.NEXT_PUBLIC_SELF_HOSTED === 'true') return []
    return [
      {
        source: '/signup/:path*',
        headers: [{ key: 'Content-Security-Policy', value: signupConnectSources }],
      },
      ...['/calendar/:path*', '/contacts/:path*', '/tasks/:path*', '/notes/:path*', '/settings/:path*'].map((source) => ({
        source,
        headers: [{ key: 'Content-Security-Policy', value: hostedConnectSources }],
      })),
      {
        source: '/settings/subscription',
        headers: [{ key: 'Content-Security-Policy', value: subscriptionConnectSources }],
      },
    ]
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    }
    config.resolve.alias = {
      ...config.resolve.alias,
      etebase: resolveEtebase(),
    }
    return config
  },
}

const pwaConfig = withPWA({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development',
  register: true,
  skipWaiting: true,
  fallbacks: {
    document: '/offline',
  },
  importScripts: ['/notification-worker.js'],
})(withNextIntl(nextConfig))

module.exports = withSentryConfig(pwaConfig, {
  // Suppresses source map upload logs during build
  silent: true,
  // Upload source maps only when DSN is configured
  disableServerWebpackPlugin: !process.env.NEXT_PUBLIC_SENTRY_DSN,
  disableClientWebpackPlugin: !process.env.NEXT_PUBLIC_SENTRY_DSN,
  // Hides source maps from generated client bundles
  hideSourceMaps: true,
  // Automatically tree-shake Sentry logger statements
  disableLogger: true,
})
