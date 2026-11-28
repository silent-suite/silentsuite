const path = require('path')
const createNextIntlPlugin = require('next-intl/plugin')
const withPWA = require('@ducanh2912/next-pwa').default
const { withSentryConfig } = require('@sentry/nextjs')
const { glitchtipSourceMapUpload } = require('./sentry-build-options')
const { runtimeCachingBeforeDefaults } = require('./pwa-runtime-caching')
const { plainDecodeEntityPlugin } = require('./note-markdown-worker-webpack')

// The Android app bundles a static copy of the login and calendar pages (see
// android-bundle/README.md). That build has no server: no route handlers, no
// middleware, no cookie-read locale, no service worker and no error reporter.
// Without this variable nothing below changes for the hosted or self-hosted app.
const androidBundle = process.env.SILENTSUITE_ANDROID_BUNDLE === '1'

const withNextIntl = createNextIntlPlugin(androidBundle ? './i18n/request.android.ts' : './i18n/request.ts')
// `https:` lets users reach their own Etebase server on any host, port or base path.
// It also admits every other HTTPS origin, so these routes no longer deny analytics via CSP.
// `data:` covers libsodium fetching its embedded base64 WASM; the edge policy needs it too.
const hostedConnectSources = "connect-src 'self' https://api.silentsuite.io https://server.silentsuite.io wss://server.silentsuite.io https://*.sentry.io https: data:"
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
  output: androidBundle ? 'export' : 'standalone',
  ...(androidBundle
    ? {
        // Only .tsx files are routes here, which leaves out app/api/**/route.ts
        // and middleware.ts; a static export cannot carry either.
        pageExtensions: ['tsx', 'jsx'],
        trailingSlash: true,
        images: { unoptimized: true },
        // A fixed ID keeps two builds of one commit byte-identical.
        generateBuildId: () => 'android-bundle',
      }
    : {}),
  // Both browser telemetry gates are inlined as literals, so a build without
  // them carries neither the error reporter nor the speed reporter.
  env: {
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN ?? '',
    NEXT_PUBLIC_WEB_VITALS_ENABLED: process.env.NEXT_PUBLIC_WEB_VITALS_ENABLED === 'true' ? 'true' : 'false',
    NEXT_PUBLIC_ANDROID_BUNDLE: androidBundle ? 'true' : 'false',
  },
  eslint: {
    // ESLint runs as a separate CI step; skip during builds
    ignoreDuringBuilds: true,
  },
  transpilePackages: ['@silentsuite/ui', '@silentsuite/core'],
  async headers() {
    // The Android app sets its own policy on every bundled response.
    if (androidBundle) return []
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
  webpack: (config, { webpack }) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    }
    config.resolve.alias = {
      ...config.resolve.alias,
      etebase: resolveEtebase(),
      ...(androidBundle ? { '@sentry/nextjs$': path.join(__dirname, 'android-bundle', 'sentry-stub.js') } : {}),
    }
    // The Notes preview's worker has no `document`; see the file.
    config.plugins.push(plainDecodeEntityPlugin(webpack))
    return config
  },
}

const pwaConfig = withPWA({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development' || androidBundle,
  register: true,
  skipWaiting: true,
  // A reload on reconnect would erase drafts the app keeps only in memory, such as
  // refused typing marked Not saved (#744). Only the offline fallback page reloads.
  reloadOnOnline: false,
  fallbacks: {
    document: '/offline',
  },
  // Our routes first, then next-pwa's defaults unchanged (see pwa-runtime-caching.js).
  extendDefaultRuntimeCaching: true,
  workboxOptions: {
    importScripts: ['/sw-cache-cleanup.js'],
    runtimeCaching: runtimeCachingBeforeDefaults,
  },
})(withNextIntl(nextConfig))

module.exports = androidBundle ? pwaConfig : withSentryConfig(pwaConfig, {
  silent: true,
  // The build plugin sends no usage data of its own.
  telemetry: false,
  ...glitchtipSourceMapUpload(),
  webpack: {
    // Browser error reports only: no server, middleware or component wrapping.
    autoInstrumentServerFunctions: false,
    autoInstrumentMiddleware: false,
    autoInstrumentAppDirectory: false,
    treeshake: {
      removeDebugLogging: true,
      removeTracing: true,
      excludeReplayIframe: true,
      excludeReplayShadowDOM: true,
      excludeReplayCompressionWorker: true,
    },
  },
})
