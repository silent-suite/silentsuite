#!/usr/bin/env node
// Commit metadata guard: rejects automated author/committer identities and
// automated attribution trailers/signatures in commit metadata. Human authors and
// human co-authors are preserved. Dependency-free; identical in both repositories.
//
//   guard.mjs commit-msg <message-file>             (local commit-msg hook)
//   guard.mjs pre-push --base <branch>... -- <remote> <url>   (local pre-push hook; refs on stdin)
//   guard.mjs range --base <rev>... --head <rev>    (CI: every commit in head --not each base)
//
// Exit 0 clean, 1 violations, 2 usage/unresolvable input (fail closed). Output names
// commit ids and reasons only, never message content.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const TOOL = String.raw`(?:claude|anthropic|codex|openai|chatgpt|copilot|gemini|cursor|devin|aider|gpt-?\d)`
// A display name that is a tool/model/product name. A bare human first name
// (e.g. "Claude") is not matched here; it is only rejected with an automated email.
const AUTOMATED_NAME = new RegExp(String.raw`^(?:` + [
  String.raw`claude[ -]?code\b.*`,
  String.raw`claude[ -]?(?:opus|sonnet|haiku|fable|instant)\b.*`,
  String.raw`claude \d.*`,
  String.raw`anthropic\b.*`,
  String.raw`(?:openai )?codex\b.*`,
  String.raw`openai\b.*`,
  String.raw`chatgpt\b.*`,
  String.raw`gpt-?\d.*`,
  String.raw`(?:github )?copilot\b.*`,
  String.raw`gemini (?:code assist|cli)`,
  String.raw`cursor agent`,
  String.raw`devin ai`,
  String.raw`aider\b.*`,
  String.raw`${TOOL}[\w.-]*\[bot\]`,
].join('|') + ')$', 'i')
// Vendor no-reply/agent mailboxes and tool bot accounts, not every vendor address.
const AUTOMATED_EMAIL = new RegExp(String.raw`^(?:(?:no-?reply|claude|codex)[^@]*@(?:[\w-]+\.)*(?:anthropic|openai)\.com|(?:\d+\+)?${TOOL}[\w.-]*\[bot\]@users\.noreply\.github\.com|cursoragent@cursor\.com)$`, 'i')
// Identity trailers whose value is checked; the session-link trailer is always rejected.
const IDENTITY_TRAILER = /^\s*(?:[*-]\s+)?(co-authored-by|signed-off-by|assisted-by|generated-by|helped-by)\s*:\s*(.*)$/i
const SESSION_TRAILER = /^\s*(?:[*-]\s+)?claude-session\s*:/i
// The whole line must be the signature ("Generated with <product>", optionally as a markdown
// link or with a URL), so human attribution and prose about such footers pass. Bare first
// names (Claude, Devin) are not product names here.
const PRODUCT = String.raw`(?:claude (?:code|(?:opus|sonnet|haiku|fable)(?: [\d.]+)?)|anthropic(?: claude)?|(?:openai )?codex(?: cli)?|chatgpt|openai|gpt-?[\d.]+[a-z]*|(?:github )?copilot|gemini(?: code assist| cli)?|cursor(?: agent)?|devin ai|aider)`
const PROVENANCE = new RegExp(String.raw`^[^\p{L}\p{N}]*generated (?:with|by|using) (?:\[${PRODUCT}\]\([^)\s]*\)|${PRODUCT}(?: \(?https?://[^\s)]*\)?)?)[\s.!]*$`, 'iu')

const normalize = value => String(value).normalize('NFKC').replace(/\s+/g, ' ').trim()

export function parseIdentity(value) {
  const match = /^(.*?)\s*<([^<>]*)>\s*$/.exec(normalize(value))
  return match ? { name: match[1].trim(), email: match[2].trim() } : { name: normalize(value), email: '' }
}

export function isAutomatedIdentity({ name = '', email = '' }) {
  return AUTOMATED_NAME.test(normalize(name)) || AUTOMATED_EMAIL.test(normalize(email))
}

// Returns reasons (no message content) for one commit's author, committer and message.
export function inspectCommit({ author, committer, message }) {
  const reasons = []
  if (author && isAutomatedIdentity(author)) reasons.push('automated author identity')
  if (committer && isAutomatedIdentity(committer)) reasons.push('automated committer identity')
  String(message).split(/\r\n|\r|\n/).forEach((raw, index) => {
    const line = raw.normalize('NFKC')
    const at = `line ${index + 1}`
    const trailer = IDENTITY_TRAILER.exec(line)
    if (trailer && isAutomatedIdentity(parseIdentity(trailer[2]))) {
      reasons.push(`automated ${trailer[1].toLowerCase()} trailer (${at})`)
    } else if (SESSION_TRAILER.test(line)) {
      reasons.push(`automated session link trailer (${at})`)
    } else if (PROVENANCE.test(normalize(line))) {
      reasons.push(`automated provenance signature (${at})`)
    }
  })
  return reasons
}

function git(args, options = {}) {
  const result = spawnSync('git', args, { encoding: options.raw ? undefined : 'utf8', input: options.input, maxBuffer: 1 << 30 })
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed`)
  return result.stdout
}

function resolveCommit(rev) {
  if (typeof rev !== 'string' || !rev || rev.startsWith('-')) throw new Error('invalid revision')
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], { encoding: 'utf8' })
  const sha = result.stdout?.trim()
  if (result.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`unresolvable revision: ${rev}`)
  return sha
}

function parseRawCommit(raw) {
  const split = raw.indexOf('\n\n')
  const header = split === -1 ? raw : raw.slice(0, split)
  const commit = { message: split === -1 ? '' : raw.slice(split + 2) }
  for (const line of header.split('\n')) {
    const match = /^(author|committer) (.*) \d+ [+-]\d{4}$/.exec(line)
    if (match && commit[match[1]]) throw new Error('malformed commit object')
    if (match) commit[match[1]] = parseIdentity(match[2])
  }
  if (!commit.author || !commit.committer) throw new Error('malformed commit object')
  return commit
}

// Every commit reachable from head and not from EACH base, checked per base and combined
// (merges and their imported ancestors included; no truncation). Bases never shield each
// other: a commit on dev but not main is still checked when main is also a base.
// Unresolvable refs throw (fail closed).
export function checkRange(bases, head) {
  if (!bases.length) throw new Error('at least one base is required')
  const tip = resolveCommit(head)
  const resolved = bases.map(resolveCommit)
  const list = [...new Set(resolved.flatMap(base => git(['rev-list', tip, `^${base}`]).split('\n').filter(Boolean)))]
  if (!list.length) return []
  const batch = git(['cat-file', '--batch'], { input: `${list.join('\n')}\n`, raw: true })
  const violations = []
  let offset = 0
  for (const sha of list) {
    const end = batch.indexOf(10, offset)
    const [id, type, size] = batch.subarray(offset, end).toString('utf8').split(' ')
    if (id !== sha || type !== 'commit') throw new Error('unexpected object in commit batch')
    const raw = batch.subarray(end + 1, end + 1 + Number(size)).toString('utf8')
    offset = end + 1 + Number(size) + 1
    for (const reason of inspectCommit(parseRawCommit(raw))) violations.push({ commit: sha, reason })
  }
  return violations
}

function parseBases(args) {
  const bases = []
  let i = 0
  for (; i < args.length && args[i] !== '--'; i += 2) {
    if (args[i] !== '--base' || !/^[A-Za-z0-9._/-]+$/.test(args[i + 1] ?? '') || args[i + 1].startsWith('-')) throw new Error('invalid --base')
    bases.push(args[i + 1])
  }
  if (!bases.length) throw new Error('missing --base')
  return { bases, rest: args.slice(i + 1) }
}

function report(violations, hint) {
  for (const { commit, reason } of violations) console.error(`commit-metadata: ${commit}: ${reason}`)
  if (violations.length) console.error(`commit-metadata: rejected ${violations.length} violation(s). ${hint}`)
  return violations.length ? 1 : 0
}

export function main(argv, stdin = () => readFileSync(0, 'utf8')) {
  const [mode, ...args] = argv
  try {
    if (mode === 'commit-msg') {
      if (args.length !== 1) throw new Error('usage: commit-msg <file>')
      const message = readFileSync(args[0], 'utf8').split(/\r?\n/).filter(line => !line.startsWith('#')).join('\n')
      const ident = name => parseIdentity(git(['var', name]).trim().replace(/ \d+ [+-]\d{4}$/, ''))
      const reasons = inspectCommit({ author: ident('GIT_AUTHOR_IDENT'), committer: ident('GIT_COMMITTER_IDENT'), message })
      return report(reasons.map(reason => ({ commit: 'new commit', reason })), 'Remove automated attribution and use a human identity.')
    }
    if (mode === 'pre-push') {
      const { bases, rest } = parseBases(args)
      const remote = rest[0]
      if (!remote || !/^[A-Za-z0-9._-]+$/.test(remote) || remote.startsWith('-')) throw new Error('pre-push requires a named remote')
      const violations = []
      for (const line of stdin().split('\n').filter(Boolean)) {
        const [localRef, localSha] = line.split(' ')
        if (!localRef || !/^[0-9a-f]{40,64}$/.test(localSha ?? '')) throw new Error('malformed pre-push input')
        if (/^0+$/.test(localSha)) continue // deletion: nothing new is published
        violations.push(...checkRange(bases.map(base => `refs/remotes/${remote}/${base}`), localSha))
      }
      const unique = [...new Map(violations.map(v => [`${v.commit} ${v.reason}`, v])).values()]
      return report(unique, 'History is not rewritten automatically; fix the branch before pushing.')
    }
    if (mode === 'range') {
      const headIndex = args.indexOf('--head')
      if (headIndex === -1 || args.length !== headIndex + 2) throw new Error('usage: range --base <rev>... --head <rev>')
      const { bases } = parseBases([...args.slice(0, headIndex), '--'])
      const violations = checkRange(bases, args[headIndex + 1])
      if (!violations.length) console.log('commit-metadata: no automated attribution in new commits')
      return report(violations, 'Every newly reachable commit must be free of automated attribution.')
    }
    throw new Error('usage: guard.mjs commit-msg|pre-push|range ...')
  } catch (error) {
    console.error(`commit-metadata: BLOCKED (fail closed): ${error.message}`)
    return 2
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2))
