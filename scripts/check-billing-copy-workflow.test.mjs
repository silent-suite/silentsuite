import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('public CI invokes the non-noop annual billing copy guard', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.scripts['check:billing-copy'], 'node --test scripts/check-billing-copy.test.mjs scripts/check-billing-copy-workflow.test.mjs && node scripts/check-billing-copy.mjs')
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(workflow, /pnpm run check:billing-copy/)
})

test('Web and Docs preview/deploy workflows enforce the root guard and preview filters cover its inputs', () => {
  const root = new URL('../', import.meta.url)
  for (const name of ['preview-web.yml', 'deploy-web.yml', 'preview-docs.yml', 'deploy-docs.yml']) {
    const workflow = readFileSync(new URL(`.github/workflows/${name}`, root), 'utf8')
    assert.match(workflow, /pnpm run check:billing-copy/, `${name} must run the root copy guard`)
  }
  for (const name of ['preview-web.yml', 'preview-docs.yml']) {
    const workflow = readFileSync(new URL(`.github/workflows/${name}`, root), 'utf8')
    for (const path of ["'README.md'", "'docs/**'", "'apps/docs/**'", "'android/**'", "'scripts/check-billing-copy*.mjs'", "'package.json'", "'pnpm-lock.yaml'", "'.github/workflows/**'"]) {
      assert.match(workflow, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name} must trigger on ${path}`)
    }
  }
})

test('public CI workflows trigger only from main while release and manual paths remain available', () => {
  const root = new URL('../', import.meta.url)
  const workflows = new Map(
    ['ci.yml', 'ci-server.yml', 'build-android.yml', 'test-bridge-linux.yml', 'test-bridge-windows.yml']
      .map(name => [name, readFileSync(new URL(`.github/workflows/${name}`, root), 'utf8')]),
  )

  for (const [name, workflow] of workflows) {
    assert.match(workflow, /push:\n\s+branches: \[main\]/, `${name} push must target only main`)
    assert.match(workflow, /pull_request:\n\s+branches: \[main\]/, `${name} PRs must target only main`)
    assert.doesNotMatch(workflow, /branches: \[[^\]]*\bdev\b/, `${name} must not retain dev branch triggers`)
  }
  const android = workflows.get('build-android.yml')
  assert.match(android, /tags:\n\s+- 'v\*'/, 'Android release tags must remain enabled')
  assert.match(android, /\n  workflow_dispatch:\n/, 'Android manual dispatch must remain enabled')
  for (const name of ['test-bridge-linux.yml', 'test-bridge-windows.yml']) {
    assert.match(workflows.get(name), /\n  workflow_dispatch:\n/, `${name} manual dispatch must remain enabled`)
  }
})

test('web preview deploy has a main-only, exact-head manual trust boundary', () => {
  const preview = readFileSync(new URL('../.github/workflows/preview-web.yml', import.meta.url), 'utf8')
  const prJob = preview.split('  build-preview:\n')[1].split('  resolve-trusted-target:\n')[0]
  const resolver = preview.split('  resolve-trusted-target:\n')[1].split('  build-shared-preview-image:\n')[0]
  const build = preview.split('  build-shared-preview-image:\n')[1].split('  publish-and-deploy-preview:\n')[0]
  const deploy = preview.split('  publish-and-deploy-preview:\n')[1]

  assert.match(preview, /name: Preview Web App \(protected-main shared deploy \+ PR builds\)/)
  assert.match(preview, /push:\n\s+branches:\n\s+- main/)
  assert.match(preview, /pull_request:\n\s+branches: \[main\]/)
  assert.match(preview, /workflow_dispatch:\n\s+inputs:\n\s+pr_number:/)
  assert.match(preview, /expected_sha:/)
  assert.doesNotMatch(preview, /pull_request_target/)
  assert.ok(prJob.includes('shared preview updates from protected \\`main\\` only'))
  assert.ok(prJob.includes('manually dispatched exact-head preview is a separate, identified operation'))
  assert.doesNotMatch(prJob, /secrets\./, 'PR build must not receive private secrets')
  assert.match(prJob, /persist-credentials: false/)
  const prBuildArgs = prJob.match(/build-args:\s*\|([\s\S]*?)\n\s+cache-from/)
  assert.ok(prBuildArgs, 'PR Docker build must declare build args')
  assert.ok(prBuildArgs[1].trim().split('\n').every(line => line.trim().startsWith('NEXT_PUBLIC_')), 'PR Docker build args must be public inputs')

  for (const contract of [
    /WORKFLOW_REF.*github\.ref/,
    /refs\/heads\/main/,
    /\^\[1-9\]\[0-9\]\*\$/,
    /\^\[0-9a-f\]\{40\}\$/,
    /\.state == "open" and \.base\.ref == "main" and \.head\.repo\.id == \$repository_id and \.head\.sha == \$expected_sha/,
  ]) assert.match(resolver, contract)
  assert.match(resolver, /cache_scope="main"/)
  assert.match(resolver, /cache_scope="pr-\$PR_NUMBER"/)

  assert.match(build, /ref: \$\{\{ needs\.resolve-trusted-target\.outputs\.target_sha \}\}/)
  assert.match(build, /persist-credentials: false/)
  assert.match(build, /permissions:\n\s+contents: read/)
  assert.doesNotMatch(build, /packages: write|VPS_HOST|VPS_USER|VPS_SSH_KEY|GITHUB_TOKEN/)
  assert.match(build, /outputs: type=docker,dest=\$\{\{ runner\.temp \}\}\/preview-image\.tar/)
  assert.match(build, /cache-from: type=gha,scope=preview-\$\{\{ needs\.resolve-trusted-target\.outputs\.cache_scope \}\}/)
  assert.match(build, /cache-to: type=gha,mode=max,scope=preview-\$\{\{ needs\.resolve-trusted-target\.outputs\.cache_scope \}\}/)
  assert.match(deploy, /actions\/download-artifact@/)
  assert.doesNotMatch(deploy, /actions\/checkout@|pnpm install|docker\/build-push-action@/)
  assert.match(deploy, /group: preview-web-shared-main\n\s+cancel-in-progress: false/)
  assert.match(deploy, /permissions:\n\s+contents: read\n\s+packages: write\n\s+pull-requests: read/)
  assert.match(deploy, /docker push "\$exact_image"[\s\S]*docker push "\$shared_image"/)
  assert.match(deploy, /Revalidate trusted target immediately before publication/)
  assert.match(deploy, /main advanced; refusing stale preview publication/)
  assert.match(deploy, /PR identity changed; refusing preview deployment/)
})

test('the annual billing guard inventories all production source and copy roots', () => {
  const source = readFileSync(new URL('./check-billing-copy.mjs', import.meta.url), 'utf8')
  for (const root of ['apps/web', 'apps/docs', 'docs', 'android/app/src', 'README.md', 'runbooks', 'scripts', '.github/workflows']) {
    assert.match(source, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${root} must be part of the inventory`)
  }
  assert.match(source, /tests and fixtures are only/i)
  assert.match(source, /production-imports-excluded-test-module/)
  assert.match(source, /production-imports-prohibited-fixture/)
})
