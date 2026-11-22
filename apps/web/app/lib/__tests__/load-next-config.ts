import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'

export const configPath = path.resolve(__dirname, '../../../next.config.js')

export interface LoadedNextConfig {
  /** The options the config passes to next-pwa. */
  options: Record<string, unknown>
  /** What the config exports once its wrappers have run (they are stubbed to return it unchanged). */
  config: { webpack?: (webpackConfig: object, context: { webpack: unknown }) => unknown }
}

/** Runs next.config.js with only the config wrappers stubbed, so tests can read what it sets. */
export function loadNextConfig(): LoadedNextConfig {
  let options: Record<string, unknown> | undefined
  const requireFromConfig = createRequire(configPath)
  const wrappers: Record<string, unknown> = {
    path,
    'next-intl/plugin': () => (config: unknown) => config,
    '@ducanh2912/next-pwa': { default: (opts: Record<string, unknown>) => { options = opts; return (config: unknown) => config } },
    '@sentry/nextjs': { withSentryConfig: (config: unknown) => config },
    './sentry-build-options': { glitchtipSourceMapUpload: () => ({}) },
    './pwa-runtime-caching': requireFromConfig('./pwa-runtime-caching.js'),
    './note-markdown-worker-webpack': requireFromConfig('./note-markdown-worker-webpack.js'),
  }
  const cjsModule: { exports: unknown } = { exports: {} }
  // The config resolves etebase with require.resolve when its webpack hook runs.
  const configRequire = Object.assign(
    (id: string) => {
      if (!(id in wrappers)) throw new Error(`Unexpected config import: ${id}`)
      return wrappers[id]
    },
    { resolve: (id: string, resolveOptions?: { paths?: string[] }) => requireFromConfig.resolve(id, resolveOptions) },
  )
  vm.runInNewContext(readFileSync(configPath, 'utf8'), {
    module: cjsModule,
    exports: cjsModule.exports,
    require: configRequire,
    process: { env: { NODE_ENV: 'production' } },
    __dirname: path.dirname(configPath),
    __filename: configPath,
  })
  if (!options) throw new Error('next.config.js did not configure next-pwa')
  return { options, config: cjsModule.exports as LoadedNextConfig['config'] }
}
