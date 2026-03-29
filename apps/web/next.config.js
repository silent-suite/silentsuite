const path = require('path')
const withPWA = require('@ducanh2912/next-pwa').default
const { withSentryConfig } = require('@sentry/nextjs')

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
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    }
    config.resolve.alias = {
      ...config.resolve.alias,
      etebase: resolveEtebase(),
      'argon2-webworker': path.resolve(__dirname, 'app/lib/argon2-shim.js'),
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
})(nextConfig)

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
