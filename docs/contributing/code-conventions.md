# Code Conventions

Style guide and patterns we follow in the SilentSuite codebase.

## General Principles

- **Keep it simple.** Prefer clarity over cleverness.
- **Be consistent.** Follow existing patterns in the codebase.
- **Type everything.** TypeScript strict mode is enabled. Avoid `any`.

## TypeScript

- Use `const` by default. Use `let` only when reassignment is necessary.
- Prefer named exports over default exports.
- Use descriptive variable and function names. No abbreviations unless universally understood.
- Define types and interfaces close to where they're used.

## React

- Use functional components with hooks.
- Prefer composition over prop drilling.
- Keep components small and focused on a single responsibility.

## File Naming

- Use kebab-case for file names: `user-profile.tsx`, `auth-service.ts`.
- Use PascalCase for component files when they export a single React component: `UserProfile.tsx`.
- Test files live next to the code they test: `user-profile.test.ts`.

## Commits

- Write clear, descriptive commit messages.
- Use present tense: "Add feature" not "Added feature."
- Reference issue numbers where applicable: "Fix login timeout (#42)."

## Linting

Run the linter before submitting a PR:

```bash
pnpm lint
```

Fix any issues before pushing. The CI pipeline will reject PRs with lint errors.
