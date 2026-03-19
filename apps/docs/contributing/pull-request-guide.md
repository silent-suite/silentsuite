# Pull Request Guide

How to submit changes to SilentSuite.

## Before You Start

1. **Check for existing issues.** If there's an issue for what you want to work on, comment on it to let others know you're picking it up.
2. **Open an issue first for large changes.** If you're proposing a new feature or significant refactor, open an issue to discuss the approach before writing code.

## Workflow

### 1. Fork and Clone

```bash
git clone https://github.com/YOUR-USERNAME/silentsuite.io.git
cd silentsuite.io
pnpm install
```

### 2. Create a Branch

Create a branch from `main` with a descriptive name:

```bash
git checkout -b fix/login-timeout
git checkout -b feature/task-export
```

### 3. Make Your Changes

- Follow the [Code Conventions](./code-conventions.md).
- Write or update tests for your changes (see [Testing](./testing.md)).
- Update documentation if your change affects user-facing behaviour.

### 4. Verify

Run all checks locally before pushing:

```bash
pnpm lint
pnpm type-check
pnpm test
pnpm build
```

### 5. Push and Open a PR

```bash
git push origin your-branch-name
```

Open a pull request on GitHub against the `main` branch.

## PR Description

Include in your PR description:

- **What** the change does.
- **Why** the change is needed (link the issue if there is one).
- **How** to test it.

## Review Process

- A maintainer will review your PR and may request changes.
- Address review feedback by pushing additional commits to your branch.
- Once approved, a maintainer will merge your PR.

## Tips

- Keep PRs small and focused. One change per PR is easier to review.
- If your PR includes documentation updates, even better.
- Don't be discouraged by review feedback -- it's part of the process.
