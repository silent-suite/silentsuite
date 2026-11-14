import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const appsRoot = path.resolve('apps')
// App browser senders post to the same-origin relay; only the server-side relay
// module names the upstream analytics host.
const analyticsEndpoint = '/api/event'
const upstreamAnalyticsHost = 'plausible.silentsuite.io'
const generatedAppRootArgument = process.argv.find((argument) => argument.startsWith('--generated-app-root='))
const generatedAppRoot = generatedAppRootArgument
  ? path.resolve(generatedAppRootArgument.slice('--generated-app-root='.length))
  : path.join(appsRoot, 'web/.next/static/chunks/app/(app)')
const generatedAuthRootArgument = process.argv.find((argument) => argument.startsWith('--generated-auth-root='))
const generatedAuthRoot = generatedAuthRootArgument
  ? path.resolve(generatedAuthRootArgument.slice('--generated-auth-root='.length))
  : path.join(appsRoot, 'web/.next/static/chunks/app/(auth)')
const generatedStaticRootArgument = process.argv.find((argument) => argument.startsWith('--generated-static-root='))
// The browser telemetry artifact scan reads the whole emitted static tree. It runs
// on the default build output, or on an explicit root; a run aimed only at other
// generated roots (fixtures) skips it.
const generatedStaticRoot = generatedStaticRootArgument
  ? path.resolve(generatedStaticRootArgument.slice('--generated-static-root='.length))
  : generatedAppRootArgument || generatedAuthRootArgument ? undefined : path.join(appsRoot, 'web/.next/static')
const enabledGeneratedBuild = process.argv.includes('--enabled-generated-build') || process.env.PUBLIC_ANALYTICS_ENABLED_BUILD === 'true'
const allowedAnalyticsFiles = new Set([
  path.join(appsRoot, 'web/app/(auth)/signup/signup-analytics.tsx'),
  path.join(appsRoot, 'web/app/(auth)/signup/commercial-funnel-analytics.tsx'),
  path.join(appsRoot, 'web/app/(app)/settings/subscription/subscription-entry.tsx'),
  path.join(appsRoot, 'web/app/lib/analytics-relay.ts'),
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
  // Same-origin relay: fixed upstream, hosted-only gates, rebuilt payloads and the
  // peer-validated client address header.
  ['apps/web/app/lib/analytics-relay.ts', [
    "export const ANALYTICS_UPSTREAM = 'https://plausible.silentsuite.io/api/event'",
    "process.env.NEXT_PUBLIC_SELF_HOSTED !== 'true'",
    "process.env.NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED === 'true'",
    'INVENTORY.get(canonicalJson(parsed))',
    "headers.get('x-real-ip')",
    'X-Plausible-IP',
    "process.env.WEB_VITALS_FORWARD === 'on'",
    "entry.kind === 'vital' ? '' :",
  ]],
  ['apps/web/app/api/event/route.ts', ['relayAnalyticsEvent']],
  // Public-page speed ratings: own default-off build gate (relay gate and header
  // omission are pinned on the relay entry above).
  ['apps/web/app/(auth)/public-web-vitals.tsx', ["process.env.NEXT_PUBLIC_WEB_VITALS_ENABLED === 'true'", 'webVitalsPageFor(win.location.pathname)']],
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
        if (source.includes(upstreamAnalyticsHost)) violations.push(`${path.relative(process.cwd(), fullPath)}: upstream analytics host in browser bundle`)
        if (!source.includes(analyticsEndpoint)) continue
        const relativePath = path.relative(generatedAppRoot, fullPath)
        const isSubscriptionRouteChunk = /^settings[\\/]subscription[\\/]page-[^\\/]+\.js$/.test(relativePath)
        if (isSubscriptionRouteChunk) subscriptionRouteContainsEndpoint = true
        else violations.push(`${path.relative(process.cwd(), fullPath)}: analytics endpoint in authenticated production bundle`)
      }
    }
  }
  await scanGenerated(generatedAppRoot)
  // The same-origin sender is shared with the signup pages, so webpack may emit it
  // in a shared chunk that the subscription route loads rather than in the route
  // chunk itself. The app build manifest (four levels above chunks/app/(app))
  // lists every chunk each route loads: the subscription route must load the
  // endpoint, and no other authenticated route may.
  const nextDirectory = path.resolve(generatedAppRoot, '../../../..')
  let manifestPages
  try {
    manifestPages = JSON.parse(await readFile(path.join(nextDirectory, 'app-build-manifest.json'), 'utf8')).pages
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (manifestPages) {
    const endpointChunks = new Map()
    async function chunkCarriesEndpoint(file) {
      if (!endpointChunks.has(file)) endpointChunks.set(file, (await readFile(path.join(nextDirectory, file), 'utf8')).includes(analyticsEndpoint))
      return endpointChunks.get(file)
    }
    for (const [route, files] of Object.entries(manifestPages)) {
      if (!route.startsWith('/(app)/')) continue
      let carries = false
      for (const file of files) if (await chunkCarriesEndpoint(file)) carries = true
      if (route === '/(app)/settings/subscription/page') subscriptionRouteContainsEndpoint ||= carries
      else if (carries) violations.push(`${route}: analytics endpoint in authenticated production bundle`)
    }
  }
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
        if (source.includes(upstreamAnalyticsHost)) violations.push(`${path.relative(process.cwd(), fullPath)}: upstream analytics host in browser bundle`)
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
// Browser error reports and public-page speed ratings stay dormant until a later,
// reviewed activation change: no workflow or image build may switch them on here.
const dormantTelemetrySettings = /NEXT_PUBLIC_WEB_VITALS_ENABLED\s*[=:]\s*["']?true|WEB_VITALS_FORWARD|GLITCHTIP_|NEXT_PUBLIC_SENTRY_DSN/
const workflowDirectory = path.resolve('.github/workflows')
for (const file of [...(await readdir(workflowDirectory)).map((name) => path.join(workflowDirectory, name)), path.resolve('Dockerfile.web')]) {
  if (!/\.ya?ml$|Dockerfile\.web$/.test(file)) continue
  if (dormantTelemetrySettings.test(await readFile(file, 'utf8'))) {
    violations.push(`${path.relative(process.cwd(), file)}: enables dormant browser telemetry (error reports or speed ratings)`)
  }
}

// Emitted browser chunks: no tracing or session-replay code, no source maps, and
// each telemetry sender present only when its build gate was given.
if (generatedStaticRoot) {
  try {
    const sentryDsnBuild = Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN)
    const webVitalsBuild = process.env.NEXT_PUBLIC_WEB_VITALS_ENABLED === 'true'
    async function scanStatic(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name)
        const shown = path.relative(process.cwd(), fullPath)
        if (entry.isDirectory()) await scanStatic(fullPath)
        else if (entry.name.endsWith('.map')) violations.push(`${shown}: source map in served static output`)
        else if (entry.name.endsWith('.js')) {
          const source = await readFile(fullPath, 'utf8')
          if (/rrweb|name:"Replay"|"BrowserTracing"/.test(source)) violations.push(`${shown}: tracing or session replay code in browser bundle`)
          if (!sentryDsnBuild && source.includes('/api/error')) violations.push(`${shown}: error reporter present without NEXT_PUBLIC_SENTRY_DSN`)
          if (!webVitalsBuild && source.includes('"Web Vital"')) violations.push(`${shown}: speed reporter present without NEXT_PUBLIC_WEB_VITALS_ENABLED=true`)
        }
      }
    }
    await scanStatic(generatedStaticRoot)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

if (violations.length) {
  console.error(violations.join('\n'))
  process.exit(1)
}
console.log('Public analytics boundary check passed')
