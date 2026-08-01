import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const docsRoot = process.cwd()
const repoRoot = resolve(docsRoot, '../..')

function read(path) {
  return readFileSync(path, 'utf8')
}

const hostedAndroid = read(resolve(docsRoot, 'user-guide/apps/android.md'))
const hostedIos = read(resolve(docsRoot, 'user-guide/apps/ios.md'))
const hostedFaq = read(resolve(docsRoot, 'user-guide/faq.md'))
const siblingFaq = read(resolve(repoRoot, 'docs/user-guide/faq.md'))
const siblingGettingStarted = read(resolve(repoRoot, 'docs/user-guide/getting-started.md'))
const siblingGuideIndex = read(resolve(repoRoot, 'docs/user-guide/README.md'))
const rootReadme = read(resolve(repoRoot, 'README.md'))
const settingsMobile = read(resolve(repoRoot, 'apps/web/app/(app)/settings/mobile/page.tsx'))
const themeCss = read(resolve(docsRoot, '.vitepress/theme/custom.css'))

function markdownInventory(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => resolve(entry.parentPath, entry.name))
}

const inventory = [
  resolve(repoRoot, 'README.md'),
  ...markdownInventory(resolve(docsRoot, 'user-guide')),
  ...markdownInventory(resolve(repoRoot, 'docs')),
]

const falseIosAvailabilityPatterns = [
  /\biOS\s+(?:access|sync)\s+via\s+(?:the\s+)?(?:original\s+)?EteSync\b/i,
  /\biOS\s+via\s+(?:an?\s+)?EteSync-compatible client\b/i,
  /\bEteSync(?:'s)? compatible open-source client\b/i,
  /\bEteSync iOS app\b[^.\n]*\bworks against\b/i,
  /\bExisting iOS users\b[^.\n]*\bEteSync\b[^.\n]*\bworks\b/i,
  /\bavailable for Android and iOS\b/i,
  /\bvirtually any calendar\/contacts app\b/i,
  /\*\*Desktop:\*\*[^\n]*\bwith any CalDAV\/CardDAV app\b/i,
  /\bnative apps on every major platform\b/i,
  /\bworks across all major platforms\b/i,
  /\bAny app that supports CalDAV or CardDAV can sync\b/i,
  /\bIf your app supports CalDAV\/CardDAV, it works\b/i,
  /\bit will most likely work\b/i,
  /\| DAVx5 \| Android \| Use CalDAV\/CardDAV account setup \|/i,
]

const falseFdroidAvailabilityPatterns = [
  /\b(?:SilentSuite|the (?:SilentSuite )?(?:Android )?app)\s+(?:is\s+|can be\s+)?(?:currently\s+|now\s+)?(?:available|downloadable|installable|downloaded|installed)\s+(?:on|from|through|via)\s+(?:the official\s+)?F-Droid\b/i,
  /\b(?:download|install|get|obtain)\s+(?:SilentSuite|the (?:SilentSuite )?(?:Android )?app)\s+(?:on|from|through|via)\s+(?:the official\s+)?F-Droid\b/i,
  /\bavailable\s+(?:now\s+)?(?:on|from|through|via)\b[^.\n]*\bF-Droid\b/i,
  /\bF-Droid\b\s*(?:[-—:|]\s*)?(?:is\s+)?(?:available(?:\s+now)?|download(?:\s+now)?|install(?:\s+now)?)(?:\b|$)/i,
  /\b(?:available|download|installation)\s+channels?\b[^.\n]*\bF-Droid\b/i,
  /\bchannels?\b[^.\n]*\binclude(?:s|d)?\b[^.\n]*\bF-Droid\b/i,
]

const falseQrTargetPatterns = [
  /\bQR(?:[- ]code)?\s+download\b/i,
  /\bQR(?:[- ]code)?\s+(?:that\s+)?(?:downloads?|links?|points?|opens?)\s+(?:directly\s+)?(?:to\s+)?[^,;.\n]*\b(?:APK|GitHub (?:APK|Releases?))\b/i,
  /\b(?:use|scan)\s+(?:the\s+)?QR(?:[- ]code)?\s+(?:to|for)\s+(?:download|get|open|install)\b[^,;.\n]*\b(?:APK|GitHub (?:APK|Releases?))\b/i,
  /\b(?:use|scan)\s+(?:the\s+)?QR(?:[- ]code)?\s+for\s+(?:the\s+)?(?:latest\s+)?(?:signed\s+)?(?:APK|GitHub (?:APK|Releases?))\b/i,
  /\bQR(?:[- ]code)?\s+(?:takes? you|lets? you)\s+(?:directly\s+)?(?:to\s+|download\s+|get\s+|open\s+)?[^,;.\n]*\b(?:APK|GitHub (?:APK|Releases?))\b/i,
]

function sentences(content) {
  const blocks = []
  let current = ''
  let currentKind = ''
  let fenceMarker = ''

  const flush = () => {
    if (current) blocks.push(current)
    current = ''
    currentKind = ''
  }

  const append = (line, kind) => {
    if (currentKind && currentKind !== kind) flush()
    current = current ? `${current} ${line}` : line
    currentKind = kind
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()

    const fence = line.match(/^(`{3,}|~{3,})/)
    if (fence) {
      flush()
      const marker = fence[1][0]
      if (!fenceMarker) fenceMarker = marker
      else if (fenceMarker === marker) fenceMarker = ''
      continue
    }
    if (fenceMarker) continue

    if (!line) {
      flush()
      continue
    }

    if (/^#{1,6}\s/.test(line) || /^:::/.test(line) || /^\|/.test(line)) {
      flush()
      blocks.push(line)
      continue
    }

    if (/^>/.test(line)) {
      const quoteLine = line.replace(/^>+\s*/, '')
      if (!quoteLine) flush()
      else append(quoteLine, 'quote')
      continue
    }

    if (/^(?:[-*+] |\d+\. )/.test(line)) {
      flush()
      append(line, 'list')
      continue
    }

    append(line, currentKind || 'paragraph')
  }
  flush()

  return blocks
    .flatMap((block) => block.split(/[.!?](?:[)"']?)\s+/))
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

function claimClauses(sentence) {
  const subject = '(?:SilentSuite|the (?:SilentSuite )?(?:Android )?app)\\b|F-Droid\\s+(?:is|will|would|can|has|offers|provides|supports)\\b'
  const separator = new RegExp(
    `(?:;\\s*|,\\s*(?:and|but|however)\\s+(?=(?:${subject}))|\\s+(?:and|but|however)\\s+(?=(?:${subject})))`,
    'i',
  )

  return sentence.split(separator).map((clause) => clause.trim()).filter(Boolean)
}

function isTruthfulFdroidContext(sentence) {
  return (
    /\b(?:official\s+)?F-Droid\b[^.\n]*\b(?:inclusion|publication|distribution)\b[^.\n]*\b(?:pending|planned|coming soon)\b/i.test(sentence) ||
    /\b(?:inclusion|publication|distribution)\b[^.\n]*\b(?:pending|planned|coming soon)\b[^.\n]*\b(?:official\s+)?F-Droid\b/i.test(sentence) ||
    /\bfuture\s+(?:reproducible\s+|developer-signed\s+)?F-Droid\s+builds?\b/i.test(sentence) ||
    /\b(?:SilentSuite|the (?:SilentSuite )?(?:Android )?app)\s+(?:is|are)\s+not\s+(?:yet\s+|currently\s+)?available\b[^.\n]*\bF-Droid\b/i.test(sentence) ||
    /\bF-Droid\b\s+(?:is|are)\s+not\s+(?:yet\s+|currently\s+)?available\b/i.test(sentence) ||
    /\b(?:do|does|will|would)\s+not\s+(?:currently\s+)?include\s+(?:(?:Google Play|Zapstore|GitHub Releases|Obtainium)\s*(?:,|or|and)\s*)*F-Droid\b/i.test(sentence) ||
    /\bF-Droid\b\s+(?:is|was|will be|would be)\s+not\s+(?:currently\s+)?included\b/i.test(sentence) ||
    /\b(?:when|once|after)\b[^,;.\n]*\bF-Droid\b[^,;.\n]*\b(?:available|published|included|approved)\b/i.test(sentence) ||
    /\bwhen\s+available\b[^,;.\n]*\b(?:include|support|publish)\b[^,;.\n]*\bF-Droid\b/i.test(sentence) ||
    /\b(?:will|would)\s+(?:eventually\s+)?(?:include|support|publish)\b[^,;.\n]*\bF-Droid\b/i.test(sentence) ||
    /\b(?:install|download|get)\s+(?:Obtainium|Tasks\.org|Etar|Simple Calendar)\b[^\n]*\bfrom\b[^\n]*\bF-Droid\b/i.test(sentence) ||
    /\b(?:Obtainium|Tasks\.org|Etar|Simple Calendar)\b\s+(?:is|are)\s+available\s+from\s+F-Droid\b/i.test(sentence) ||
    /\boriginal EteSync app\b[^\n]*\bfrom\b[^\n]*\bF-Droid\b/i.test(sentence)
  )
}

function findFalseFdroidAvailabilityClaim(content) {
  return sentences(content)
    .flatMap(claimClauses)
    .find(
      (clause) =>
        /\bF-Droid\b/i.test(clause) &&
        !isTruthfulFdroidContext(clause) &&
        falseFdroidAvailabilityPatterns.some((pattern) => pattern.test(clause)),
    )
}

function findFalseQrTargetClaim(content) {
  return sentences(content).find((sentence) =>
    falseQrTargetPatterns.some((pattern) => pattern.test(sentence)),
  )
}

function hasFalseFdroidAvailabilityClaim(content) {
  return findFalseFdroidAvailabilityClaim(content) !== undefined
}

function hasFalseQrTargetClaim(content) {
  return findFalseQrTargetClaim(content) !== undefined
}

test('hosted Android guide exposes direct logo buttons for every distribution state', () => {
  const assets = ['google-play.svg', 'obtainium.svg', 'zapstore.png', 'fdroid.png', 'github.svg']
  for (const asset of assets) {
    assert.equal(existsSync(resolve(docsRoot, `public/channel-icons/${asset}`)), true, asset)
    assert.match(hostedAndroid, new RegExp(`/channel-icons/${asset.replace('.', '\\.')}`))
  }

  assert.match(hostedAndroid, /href="https:\/\/play\.google\.com\/store\/apps\/details\?id=io\.silentsuite\.android"/)
  assert.match(hostedAndroid, /href="obtainium:\/\/add\/https:\/\/github\.com\/silent-suite\/silentsuite"/)
  assert.match(hostedAndroid, /href="https:\/\/zapstore\.dev\/apps\/io\.silentsuite\.android"/)
  assert.match(hostedAndroid, /href="https:\/\/github\.com\/silent-suite\/silentsuite\/releases\/latest"/)
  assert.match(hostedAndroid, /class="android-channel-button is-pending"[^>]*aria-label="F-Droid, on the roadmap, pending official inclusion"/)
})

test('channel buttons use theme-appropriate high-contrast focus indicators', () => {
  assert.match(themeCss, /\.android-channel-button\[href\]:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--vp-c-brand-3\)/s)
  assert.match(themeCss, /\.dark \.android-channel-button\[href\]:focus-visible\s*\{[^}]*outline-color:\s*var\(--vp-c-brand-1\)/s)
})

test('current docs and Settings expose iOS only as unsupported roadmap work', () => {
  assert.match(hostedIos, /On the roadmap, coming soon/)
  assert.match(hostedIos, /does not currently support iOS/)
  assert.match(settingsMobile, /On the roadmap, coming soon/)
  assert.match(settingsMobile, /iOS is not currently supported\./)

  for (const path of inventory) {
    const content = read(path)
    for (const pattern of falseIosAvailabilityPatterns) {
      assert.doesNotMatch(content, pattern, path)
    }
  }
  for (const pattern of falseIosAvailabilityPatterns) {
    assert.doesNotMatch(settingsMobile, pattern, 'Settings → Mobile')
  }
})

test('all Android documentation states that official F-Droid inclusion is pending', () => {
  assert.match(hostedAndroid, /Official F-Droid publication is pending inclusion\./)
  assert.match(hostedFaq, /Official F-Droid inclusion is pending\./)
  assert.match(siblingFaq, /Official F-Droid inclusion is pending\./)
  assert.match(siblingGettingStarted, /Official F-Droid inclusion is pending\./)
  assert.match(siblingGuideIndex, /Official F-Droid inclusion is pending\./)
  assert.match(rootReadme, /Official F-Droid inclusion is pending\./)
})

test('F-Droid availability classifier rejects false claims and permits truthful context', () => {
  const rejected = [
    'SilentSuite is available on F-Droid.',
    'The Android app is available from the official F-Droid repository.',
    'SilentSuite can be downloaded from F-Droid.',
    'Download SilentSuite from F-Droid.',
    'Install SilentSuite via F-Droid.',
    'Get the Android app through F-Droid.',
    'F-Droid — available now',
    'F-Droid is available now.',
    'F-Droid: download now',
    'F-Droid: install now',
    'Available on Google Play, Zapstore, and F-Droid.',
    'Available channels: Google Play, Zapstore, and F-Droid.',
    'Download channels include GitHub Releases and F-Droid.',
    'Installation channels include Google Play and F-Droid.',
    'Our Android channels include F-Droid.',
    '> SilentSuite can be downloaded\n> from F-Droid.',
    '### Future F-Droid\nSilentSuite is available on F-Droid.',
    'SilentSuite does not include ads and is available on F-Droid.',
    '> Future F-Droid\n>\n> SilentSuite is available on F-Droid.',
    'Future updates improve privacy, and SilentSuite is available on F-Droid.',
    'Obtainium is useful, and SilentSuite is available on F-Droid.',
    'Install Obtainium from F-Droid, and SilentSuite is available on F-Droid.',
    'Official F-Droid inclusion is pending, but SilentSuite is available on F-Droid.',
    'Future reproducible F-Droid builds use one certificate, and SilentSuite is available on F-Droid.',
    'Google Play is not available, and SilentSuite is available on F-Droid.',
    'Official F-Droid inclusion is pending and SilentSuite is available on F-Droid.',
    'Install Obtainium from F-Droid and SilentSuite is available on F-Droid.',
    'Future reproducible F-Droid builds use one certificate and SilentSuite is available on F-Droid.',
    'Official F-Droid inclusion is pending and F-Droid is available now.',
  ]
  const accepted = [
    'SilentSuite is not yet available from the official F-Droid package index.',
    'Official F-Droid inclusion is pending.',
    'When F-Droid distribution becomes available, keep updates on that channel.',
    'When available, installation channels will include F-Droid.',
    'Install Obtainium from F-Droid.',
    'Tasks.org is available from F-Droid.',
    'Future reproducible F-Droid builds use the developer-signed certificate.',
    'SilentSuite is not available from Google Play or F-Droid.',
    'Available channels do not include F-Droid.',
    '~~~text\nSilentSuite is available on F-Droid.\n~~~',
    '```text\nSilentSuite is available on F-Droid.\n```',
  ]

  for (const content of rejected) {
    assert.equal(hasFalseFdroidAvailabilityClaim(content), true, content)
  }
  for (const content of accepted) {
    assert.equal(hasFalseFdroidAvailabilityClaim(content), false, content)
  }
})

test('documentation inventory contains no false F-Droid availability claims', () => {
  for (const path of inventory) {
    const content = read(path)
    assert.equal(findFalseFdroidAvailabilityClaim(content), undefined, path)
  }
})

test('QR target classifier rejects APK claims and permits guide plus separate APK wording', () => {
  const rejected = [
    'The QR code downloads the signed APK.',
    'Use the QR-code download in Settings.',
    'The QR code that links to the latest signed APK is in Settings.',
    'The QR code points directly to the GitHub Release.',
    'The QR code points directly to GitHub Releases.',
    'Scan the QR code to download the latest APK.',
    'Use the QR code to download the signed APK.',
    'The QR code takes you to GitHub Releases.',
    'The QR code lets you download the signed APK.',
    'Scan the QR code for the GitHub APK.',
    'The QR downloads the signed APK.',
    'Scan QR for the GitHub APK.',
  ]
  const accepted = [
    'The QR code opens the Android installation guide.',
    'The QR code opens the guide, while a separate APK link opens GitHub Releases.',
    'Scan the QR code to compare every Android installation option.',
  ]

  for (const content of rejected) assert.equal(hasFalseQrTargetClaim(content), true, content)
  for (const content of accepted) assert.equal(hasFalseQrTargetClaim(content), false, content)
})

test('Settings QR descriptions use the canonical guide and never claim an APK target', () => {
  for (const content of [siblingFaq, siblingGettingStarted, siblingGuideIndex]) {
    assert.match(content, /https:\/\/docs\.silentsuite\.io\/user-guide\/apps\/android/)
  }

  for (const path of inventory) {
    const content = read(path)
    assert.equal(findFalseQrTargetClaim(content), undefined, path)
  }
})
