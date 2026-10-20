#!/usr/bin/env node
// Installs the commit metadata guard as commit-msg and pre-push hooks in the
// repository's COMMON git hooks directory, so every linked worktree inherits them.
// Copies a stable guard snapshot next to the hooks (no dependency on any worktree
// keeping the script). Refuses to overwrite differing files, or to run when any
// worktree sets core.hooksPath or resolves another hooks directory; never changes git
// config. Re-running with identical files only restores their executable mode.
//
//   node install-hooks.mjs --repo <path> --base <branch> [--base <branch>]
//   (--base names the protected integration branch(es) on the pushed remote,
//    e.g. main for the public repo; dev and main for the private repo)
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const BRANCH = /^[A-Za-z0-9._/-]+$/

export function hookFiles(bases) {
  const baseArgs = bases.map(base => `--base ${base}`).join(' ')
  const wrapper = (mode, extra) => `#!/bin/sh\n# Commit metadata guard (installed by scripts/commit-metadata/install-hooks.mjs).\nexec node "$(dirname "$0")/commit-metadata-guard.mjs" ${mode}${extra} "$@"\n`
  return {
    'commit-metadata-guard.mjs': readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'guard.mjs'), 'utf8'),
    'commit-msg': wrapper('commit-msg', ''),
    'pre-push': wrapper('pre-push', ` ${baseArgs} --`),
  }
}

export function install(repo, bases) {
  if (!bases.length || bases.some(base => !BRANCH.test(base) || base.startsWith('-'))) throw new Error('invalid --base')
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir')
  if (common.status !== 0) throw new Error('not a git repository')
  const hooks = join(common.stdout.trim(), 'hooks')
  // Every linked worktree must resolve to the common hooks directory (a per-worktree
  // core.hooksPath via extensions.worktreeConfig would otherwise bypass these hooks).
  const worktrees = git('worktree', 'list', '--porcelain', '-z')
  if (worktrees.status !== 0) throw new Error('cannot list worktrees')
  for (const entry of worktrees.stdout.split('\0').filter(line => line.startsWith('worktree '))) {
    const path = entry.slice('worktree '.length)
    const at = (...args) => spawnSync('git', ['-C', path, ...args], { encoding: 'utf8' })
    if (at('config', '--get-all', 'core.hooksPath').status === 0) throw new Error(`core.hooksPath is set in ${path}; refusing (install manually)`)
    const resolved = at('rev-parse', '--path-format=absolute', '--git-path', 'hooks')
    if (resolved.status !== 0) throw new Error(`cannot inspect worktree ${path}; refusing (git worktree prune?)`)
    if (resolved.stdout.trim() !== hooks) throw new Error(`worktree ${path} uses another hooks directory; refusing`)
  }
  const files = hookFiles(bases)
  for (const [name, content] of Object.entries(files)) {
    const target = join(hooks, name)
    if (existsSync(target) && readFileSync(target, 'utf8') !== content) throw new Error(`refusing to overwrite existing ${target}`)
  }
  const written = []
  const repaired = []
  for (const [name, content] of Object.entries(files)) {
    const target = join(hooks, name)
    if (existsSync(target)) {
      // Identical content is ours; Git silently skips hooks that are not executable.
      if ((statSync(target).mode & 0o777) !== 0o755) { chmodSync(target, 0o755); repaired.push(target) }
      continue
    }
    writeFileSync(target, content, { flag: 'wx', mode: 0o755 })
    chmodSync(target, 0o755)
    written.push(target)
  }
  return { hooks, written, repaired }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  let repo
  const bases = []
  try {
    for (let i = 0; i < args.length; i += 2) {
      if (args[i] === '--repo' && args[i + 1] && !repo) repo = resolve(args[i + 1])
      else if (args[i] === '--base' && args[i + 1]) bases.push(args[i + 1])
      else throw new Error('usage: install-hooks.mjs --repo <path> --base <branch> [--base <branch>]')
    }
    if (!repo) throw new Error('missing --repo')
    const { hooks, written, repaired } = install(repo, bases)
    console.log(`commit-metadata hooks installed in ${hooks} (wrote ${written.length}, restored executable mode on ${repaired.length} file(s))`)
  } catch (error) {
    console.error(`commit-metadata install: ${error.message}`)
    process.exitCode = 2
  }
}
