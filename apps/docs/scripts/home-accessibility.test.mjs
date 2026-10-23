import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

// Run after the production build: inspect rendered output, not source strings.
const dist = resolve(import.meta.dirname, '../.vitepress/dist')
const home = readFileSync(resolve(dist, 'index.html'), 'utf8')
const guide = readFileSync(resolve(dist, 'user-guide/getting-started.html'), 'utf8')

function mainContent(html) {
  assert.equal([...html.matchAll(/<main\b/g)].length, 1, 'page must have exactly one main landmark')
  const match = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)
  assert.ok(match, 'main must contain page content')
  return match[1]
}

test('built homepage has one main containing the hero, features and integration content', () => {
  const main = mainContent(home)
  for (const text of ['Documentation', 'User Guide', 'Self-Hosting', 'Contributing', 'Apps &amp; Integrations', 'Use the Apps You Know']) {
    assert.ok(main.includes(text), `main must preserve ${text}`)
  }
  for (const href of ['/user-guide/getting-started', '/self-hosting/quick-start', '/contributing/dev-setup', '/user-guide/apps/', '/app-logo-notices']) {
    assert.ok(main.includes(`href="${href}"`), `main must preserve ${href}`)
  }
})

test('built guide retains its single default main landmark', () => {
  const main = mainContent(guide)
  assert.ok(main.includes('Getting Started'))
})

test('built desktop search accessible name includes its visible label and shortcut', () => {
  const button = home.match(/<button\b[^>]*class="[^"]*\bDocSearch-Button\b[^"]*"[^>]*>([\s\S]*?)<\/button>/)
  assert.ok(button, 'local search button must be present')
  const label = button[0].match(/aria-label="([^"]+)"/)
  assert.ok(label, 'local search button must have an accessible name')
  const normalize = (value) => value.replace(/\s+/g, ' ').trim().toLowerCase()
  const visible = normalize(button[1].replace(/<[^>]*>/g, ''))
  assert.ok(visible.includes('search') && visible.includes('k'), 'fixture must exercise visible search and shortcut')
  assert.ok(normalize(label[1]).includes(visible), 'accessible name must include the complete visible label')
})
