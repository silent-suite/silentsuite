import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const appsRoot = path.resolve('apps')
const analyticsEndpoint = 'plausible.silentsuite.io/api/event'
const generatedAppRootArgument = process.argv.find((argument) => argument.startsWith('--generated-app-root='))
const generatedAppRoot = generatedAppRootArgument
  ? path.resolve(generatedAppRootArgument.slice('--generated-app-root='.length))
  : path.join(appsRoot, 'web/.next/static/chunks/app/(app)')
const generatedAuthRootArgument = process.argv.find((argument) => argument.startsWith('--generated-auth-root='))
const generatedAuthRoot = generatedAuthRootArgument
  ? path.resolve(generatedAuthRootArgument.slice('--generated-auth-root='.length))
  : path.join(appsRoot, 'web/.next/static/chunks/app/(auth)')
const enabledGeneratedBuild = process.argv.includes('--enabled-generated-build') || process.env.PUBLIC_ANALYTICS_ENABLED_BUILD === 'true'
const allowedAnalyticsFiles = new Set([
  path.join(appsRoot, 'web/app/(auth)/signup/signup-analytics.tsx'),
  path.join(appsRoot, 'web/app/(auth)/signup/commercial-funnel-analytics.tsx'),
  path.join(appsRoot, 'web/app/(app)/settings/subscription/subscription-entry.tsx'),
  path.join(appsRoot, 'web/next.config.js'),
  path.join(appsRoot, 'docs/.vitepress/config.mts'),
  path.join(appsRoot, 'docs/.vitepress/theme/index.mts'),
  path.join(appsRoot, 'docs/worker/index.mts'),
])
const violations = []

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name.startsWith('dist') || entry.name === 'cache') continue
    if (entry.isDirectory()) await walk(fullPath)
    else if (/\.(?:ts|tsx|js|jsx|mts|mjs)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) {
      const source = await readFile(fullPath, 'utf8')
      if (/plausible(?:\.silentsuite\.io|\s*\?*\.|\s*\()|window\.plausible/.test(source) && !allowedAnalyticsFiles.has(fullPath)) {
        violations.push(`${path.relative(process.cwd(), fullPath)}: direct analytics call outside approved boundary`)
      }
      if (/(?:@segment\/analytics|@amplitude\/analytics|mixpanel|google-analytics|googletagmanager|posthog|hotjar|analytics\.js)/i.test(source)) {
        violations.push(`${path.relative(process.cwd(), fullPath)}: unapproved analytics SDK`)
      }
      if (/utm_(?:content|term)/.test(source)) {
        violations.push(`${path.relative(process.cwd(), fullPath)}: prohibited free-form UTM key`)
      }
      if (fullPath.includes(`${path.sep}web${path.sep}app${path.sep}(app)${path.sep}`) && /plausible|analytics/i.test(source) && !allowedAnalyticsFiles.has(fullPath)) {
        violations.push(`${path.relative(process.cwd(), fullPath)}: analytics reference in authenticated app route`)
      }
    }
  }
}

await walk(appsRoot)

const requiredContracts = new Map([
  ['apps/docs/.vitepress/theme/public-analytics.mts', ['Hosted App Click', 'Android Download Click', 'github_release', 'fdroid', 'repository']],
  ['apps/docs/.vitepress/theme/index.mts', ['__SILENTSUITE_DOCS_ANALYTICS_ENDPOINT__', 'window.location.hostname', 'classifyDocsOutboundEvent']],
  ['apps/web/next.config.js', ['Content-Security-Policy', 'signupConnectSources', 'subscriptionConnectSources', "source: '/settings/subscription'", 'hostedConnectSources']],
  // Baseline signup pageviews: origin/route gate only, property-free builder, beacon
  // with keepalive fetch fallback. The commercial event flag is pinned on the
  // commercial entry below, because baseline pageviews must not depend on it.
  ['apps/web/app/(auth)/signup/signup-analytics.tsx', [
    'buildSignupPageviewPayload',
    "location.hostname === 'app.silentsuite.io'",
    "location.protocol === 'https:'",
    'keepalive: true',
  ]],
  ['apps/web/app/(auth)/signup/commercial-funnel-analytics.tsx', ["enabled === 'true'", 'buildPlanSelectedPayload', 'buildCheckoutInitiatedPayload', 'buildCheckoutReturnedPayload']],
  ['apps/web/app/(app)/settings/subscription/subscription-entry.tsx', ['buildSubscriptionManagementEntryPayload']],
  ['Dockerfile.web', ['ARG NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED=false']],
  ['.github/workflows/deploy-web.yml', ['NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED=true']],
  ['.github/workflows/preview-web.yml', ['NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED=false']],
  // Baseline pageview transport must be verified in both build flag modes, because it
  // is independent of NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED and must ship in every build.
  ['.github/workflows/ci.yml', [
    'pnpm run check:public-analytics',
    'NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED=false pnpm --filter @silentsuite/web build',
    'NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED=true pnpm --filter @silentsuite/web build',
  ]],
])
for (const [relativePath, snippets] of requiredContracts) {
  const source = await readFile(path.resolve(relativePath), 'utf8')
  for (const snippet of snippets) {
    if (!source.includes(snippet)) violations.push(`${relativePath}: missing required analytics contract ${snippet}`)
  }
}

try {
  let subscriptionRouteContainsEndpoint = false
  async function scanGenerated(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) await scanGenerated(fullPath)
      else if (/\.js$/.test(entry.name)) {
        const source = await readFile(fullPath, 'utf8')
        if (!source.includes(analyticsEndpoint)) continue
        const relativePath = path.relative(generatedAppRoot, fullPath)
        const isSubscriptionRouteChunk = /^settings[\\/]subscription[\\/]page-[^\\/]+\.js$/.test(relativePath)
        if (isSubscriptionRouteChunk) subscriptionRouteContainsEndpoint = true
        else violations.push(`${path.relative(process.cwd(), fullPath)}: analytics endpoint in authenticated production bundle`)
      }
    }
  }
  await scanGenerated(generatedAppRoot)
  if (enabledGeneratedBuild && !subscriptionRouteContainsEndpoint) {
    violations.push('subscription route chunk: expected analytics endpoint absent')
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

// Baseline signup pageview transport must survive into the emitted signup layout
// chunk. signup-analytics.tsx is imported only by the signup layout and defines the
// endpoint and keepalive fallback module-locally, so the emitting chunk is the
// identity. Commercial modules reach only signup page entries, and the shared
// 'pageview' literal lives in the common builder module, so neither co-located
// endpoint text nor pageview text may stand in for the baseline sender. This scan is
// build-flag independent: post-repair, the baseline transport ships in every mode.
try {
  let signupLayoutCarriesTransport = false
  async function scanGeneratedAuth(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) await scanGeneratedAuth(fullPath)
      else if (/\.js$/.test(entry.name)) {
        const source = await readFile(fullPath, 'utf8')
        if (source.includes('NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED')) {
          violations.push(`${path.relative(process.cwd(), fullPath)}: unresolved signup analytics flag literal in public bundle`)
        }
        const relativePath = path.relative(generatedAuthRoot, fullPath)
        if (!/^signup[\\/]layout-[^\\/]+\.js$/.test(relativePath)) continue
        if (source.includes(analyticsEndpoint) && source.includes('keepalive')) signupLayoutCarriesTransport = true
      }
    }
  }
  await scanGeneratedAuth(generatedAuthRoot)
  if (!signupLayoutCarriesTransport) {
    violations.push('signup layout chunk: expected baseline pageview transport absent')
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

async function generatedText(directory) {
  let result = ''
  async function collect(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) await collect(fullPath)
      else if (/\.(?:js|html)$/.test(entry.name)) result += await readFile(fullPath, 'utf8')
    }
  }
  await collect(directory)
  return result
}

try {
  const hostedBundle = await generatedText(path.join(appsRoot, 'docs/.vitepress/dist-hosted'))
  const selfHostedBundle = await generatedText(path.join(appsRoot, 'docs/.vitepress/dist-self'))
  if (!hostedBundle.includes('/api/event')) violations.push('hosted docs bundle: expected same-origin analytics endpoint absent')
  if (hostedBundle.includes('plausible.silentsuite.io')) violations.push('hosted docs bundle: direct upstream analytics endpoint present')
  if (selfHostedBundle.includes('/api/event') || selfHostedBundle.includes('plausible.silentsuite.io')) violations.push('self-hosted docs bundle: analytics endpoint present')
  if (hostedBundle.includes('__SILENTSUITE_DOCS_ANALYTICS_ENDPOINT__') || selfHostedBundle.includes('__SILENTSUITE_DOCS_ANALYTICS_ENDPOINT__')) {
    violations.push('docs bundle: unresolved analytics compile constant')
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
if (violations.length) {
  console.error(violations.join('\n'))
  process.exit(1)
}
console.log('Public analytics boundary check passed')
