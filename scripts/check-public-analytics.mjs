import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const appsRoot = path.resolve('apps')
const allowedAnalyticsFiles = new Set([
  path.join(appsRoot, 'web/app/(auth)/signup/signup-analytics.tsx'),
  path.join(appsRoot, 'web/next.config.js'),
  path.join(appsRoot, 'docs/.vitepress/config.mts'),
  path.join(appsRoot, 'docs/.vitepress/theme/index.mts'),
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
      if (fullPath.includes(`${path.sep}web${path.sep}app${path.sep}(app)${path.sep}`) && /plausible|analytics/i.test(source)) {
        violations.push(`${path.relative(process.cwd(), fullPath)}: analytics reference in authenticated app route`)
      }
    }
  }
}

await walk(appsRoot)

const requiredContracts = new Map([
  ['apps/docs/.vitepress/theme/public-analytics.mts', ['Hosted App Click', 'Android Download Click', 'github_release', 'repository']],
  ['apps/docs/.vitepress/theme/index.mts', ['__SILENTSUITE_DOCS_ANALYTICS_ENDPOINT__', 'window.location.hostname', 'classifyDocsOutboundEvent']],
  ['apps/web/next.config.js', ['Content-Security-Policy', 'signupConnectSources', 'hostedConnectSources']],
  ['apps/web/app/(auth)/signup/signup-analytics.tsx', [
    "enabled === 'true'",
    "location.hostname === 'app.silentsuite.io'",
    "location.protocol === 'https:'",
  ]],
  ['Dockerfile.web', ['ARG NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED=false']],
  ['.github/workflows/deploy-web.yml', ['NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED=true']],
  ['.github/workflows/preview-web.yml', ['NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED=false']],
  ['.github/workflows/ci.yml', ['pnpm run check:public-analytics']],
])
for (const [relativePath, snippets] of requiredContracts) {
  const source = await readFile(path.resolve(relativePath), 'utf8')
  for (const snippet of snippets) {
    if (!source.includes(snippet)) violations.push(`${relativePath}: missing required analytics contract ${snippet}`)
  }
}

const generatedAppRoot = path.join(appsRoot, 'web/.next/static/chunks/app/(app)')
try {
  async function scanGenerated(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) await scanGenerated(fullPath)
      else if (/\.js$/.test(entry.name) && /plausible\.silentsuite\.io|window\.plausible/.test(await readFile(fullPath, 'utf8'))) {
        violations.push(`${path.relative(process.cwd(), fullPath)}: analytics endpoint in authenticated production bundle`)
      }
    }
  }
  await scanGenerated(generatedAppRoot)
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
  if (!hostedBundle.includes('plausible.silentsuite.io/api/event')) violations.push('hosted docs bundle: expected analytics endpoint absent')
  if (selfHostedBundle.includes('plausible.silentsuite.io')) violations.push('self-hosted docs bundle: analytics endpoint present')
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
