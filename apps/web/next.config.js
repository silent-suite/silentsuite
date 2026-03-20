const path = require('path')
const withPWA = require('@ducanh2912/next-pwa').default

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

module.exports = withPWA({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development',
  register: true,
  skipWaiting: true,
  fallbacks: {
    document: '/offline',
  },
  importScripts: ['/notification-worker.js'],
})(nextConfig)
