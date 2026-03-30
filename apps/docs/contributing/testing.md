# Testing

How to run and write tests for SilentSuite.

## Test Framework

The monorepo uses [Vitest](https://vitest.dev/) as the test framework. There are currently 189+ core tests across the monorepo packages and apps.

Note: The Etebase server (Django) does not have test coverage yet. Contributions welcome.

## Running Tests

Run all tests across the monorepo:

```bash
pnpm test
```

Run tests for a specific app or package:

```bash
pnpm test --filter=landing
pnpm test --filter=web
```

## Type Checking

Run TypeScript type checking across all packages:

```bash
pnpm type-check
```

## Writing Tests

- Place test files next to the code they test, using the `.test.ts` or `.test.tsx` suffix.
- Write descriptive test names that explain the expected behaviour.
- Test behaviour, not implementation details.
- Keep tests independent -- each test should be able to run in isolation.

## Before Submitting a PR

Make sure all checks pass:

```bash
pnpm lint
pnpm type-check
pnpm test
pnpm build
```

CI will run these checks automatically on your pull request.
