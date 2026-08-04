import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const ENDPOINT = 'https://plausible.silentsuite.io/api/event'
const REQUIRED_ENABLED_TEXT = ['docs.silentsuite.io', 'pageview', 'Hosted App Click', 'Android Download Click', 'GitHub Click']
const PROHIBITED_TEXT = ['utm_content', 'utm_term', 'referrer_category']

async function artifactText(directory) {
  let text = ''
  let files = 0
  async function collect(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) await collect(fullPath)
      else if (/\.(?:js|html)$/.test(entry.name)) {
        files += 1
        text += await readFile(fullPath, 'utf8')
      }
    }
  }
  await collect(directory)
  if (!files) throw new Error('docs analytics artifact contains no emitted JS or HTML')
  return text
}

export async function verifyDocsAnalyticsBuild(directory, mode) {
  if (mode !== 'enabled' && mode !== 'disabled') throw new Error('mode must be enabled or disabled')
  const text = await artifactText(directory)
  if (text.includes('__SILENTSUITE_DOCS_ANALYTICS_ENDPOINT__')) throw new Error('docs artifact contains unresolved analytics compile constant')
  const endpoints = text.match(/https:\/\/[^"'\s`]+\/api\/event/g) ?? []
  if (endpoints.some((endpoint) => endpoint !== ENDPOINT)) throw new Error('docs artifact contains an unapproved event endpoint')
  if (mode === 'disabled') {
    if (text.includes(ENDPOINT)) throw new Error('disabled docs artifact contains analytics endpoint')
    return
  }
  if (!text.includes(ENDPOINT)) throw new Error('enabled docs artifact is missing analytics endpoint')
  for (const required of REQUIRED_ENABLED_TEXT) {
    if (!text.includes(required)) throw new Error(`enabled docs artifact is missing required contract: ${required}`)
  }
  for (const prohibited of PROHIBITED_TEXT) {
    if (text.includes(prohibited)) throw new Error(`docs artifact contains prohibited analytics property: ${prohibited}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const directory = args[args.indexOf('--dir') + 1]
  const mode = args[args.indexOf('--mode') + 1]
  if (!directory || !mode) throw new Error('usage: verify-docs-analytics-build.mjs --dir <directory> --mode enabled|disabled')
  await verifyDocsAnalyticsBuild(directory, mode)
  console.log(`Docs analytics artifact verified (${mode})`)
}
