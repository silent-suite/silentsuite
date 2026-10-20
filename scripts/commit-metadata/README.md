# Commit metadata guard

Rejects automated author/committer identities and automated attribution in commit
messages (tool `Co-authored-by`/`Signed-off-by` trailers, session-link trailers,
"Generated with/by <tool>" signatures). Human authors and human co-authors, including
people whose first name matches a tool name, are allowed. File contents are not checked.
The same three files are kept identical in the public and private repositories.

- `guard.mjs` — dependency-free checker (`commit-msg`, `pre-push`, `range` modes).
  Exit 0 clean, 1 violations, 2 fail closed (missing/unresolvable refs, bad input).
  Output lists commit ids and reasons only.
- `install-hooks.mjs` — installs `commit-msg` and `pre-push` into the repository's
  common git hooks directory, so all linked worktrees inherit them.
- `guard.test.mjs` — `node --test scripts/commit-metadata/guard.test.mjs` (creates
  disposable repositories under the OS temp directory or `COMMIT_METADATA_TEST_TMP`).

## Local hooks

From a checkout of the reviewed revision:

```sh
# public repository: protected integration branch main
node scripts/commit-metadata/install-hooks.mjs --repo <public checkout> --base main
# private repository: feature branches target dev; promotions target main
node scripts/commit-metadata/install-hooks.mjs --repo <private checkout> --base dev --base main
```

The installer copies a snapshot of `guard.mjs` to `<common git dir>/hooks/` next to
the two hook wrappers, so hooks do not depend on any worktree's files. It refuses to
run when a differing hook file already exists, or when any linked worktree sets
`core.hooksPath` (including per-worktree config), resolves another hooks directory or
cannot be inspected (`git worktree prune` stale entries). It never changes git config.
Re-running with identical files only restores their executable mode. After the guard
changes, review and re-install (remove the three installed files first). Linked
worktrees or hook settings added later are not re-checked; re-run the installer.

`pre-push` checks every commit in the pushed tip that is not reachable from
`refs/remotes/<remote>/<target>`, independent of the previous remote branch head, so
already-pushed violations, new branches and ancestors imported by merges are covered,
while violations already in the target are not. With one `--base` (public) the target is
automatic. With several (private `dev` and `main`) the target is never guessed: a push
to exactly `refs/heads/dev` or `refs/heads/main` selects itself; any other branch must
declare the base its pull request will target, once per local branch:

```sh
git config branch.<branch>.commitMetadataBase dev    # feature branch for a PR into dev
git config branch.<branch>.commitMetadataBase main   # dev-to-main promotion branch
```

A missing, unknown, repeated or conflicting declaration (for example declared `dev`
but pushed to `refs/heads/main`) fails closed. The declaration is a local claim; the CI
check uses the actual PR target. Deletions are skipped. Missing remote-tracking bases
or pushes to an unnamed URL fail closed (`git fetch` first). History is never rewritten.

`git commit --no-verify` / `git push --no-verify` bypass local hooks; the CI check is
the shared backstop.

## CI

`.github/workflows/commit-metadata.yml` runs `guard.mjs range` on pull requests for
every commit in the PR head that is not reachable from the current target branch tip.
It uses plain `pull_request`, `contents: read`, no secrets, full history and no
persisted credentials. The checker runs from the PR's own tree, so changes to
`scripts/commit-metadata/` or the workflow need reviewer attention. Adding the workflow
does not make it a required merge check; that needs a separately approved branch
protection or ruleset change listing `Commit metadata`, where the plan supports it.
