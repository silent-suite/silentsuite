# Contributing to SilentSuite

Thanks for helping. Testing reports, documentation fixes, translations and code are all useful, and you don't need to write code to make a difference.

The full guides live in [`docs/contributing/`](./docs/contributing/). This page is the short version.

## Ways to help

- Test the apps. Try the Android app on your device, the Bridge with your DAV client (Thunderbird, Apple Calendar, Evolution, GNOME Calendar and others), or a fresh self-hosted server, and [open an issue](https://github.com/silent-suite/silentsuite/issues) with what worked and what didn't.
- Improve the docs. Fix anything unclear, outdated or wrong in [`docs/`](./docs/) or [`apps/docs/`](./apps/docs/). Reviews of privacy and security claims are welcome too.
- Translate. Read the [Translation Guide](./TRANSLATING.md) first. Proposals need a review by a fluent human speaker.
- Write code. Issues labelled [good first issue](https://github.com/silent-suite/silentsuite/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22) are small and should name the files involved. For larger changes, open an issue to talk about the approach before you write much code.

## Before you open a pull request

1. Set up your environment with the [Development Setup](./docs/contributing/dev-setup.md) guide.
2. Branch from `main` and open your pull request against `main`.
3. Keep it to one issue or one change, and link the issue if there is one.
4. Follow the [Code Conventions](./docs/contributing/code-conventions.md) and add or update tests where it makes sense ([Testing](./docs/contributing/testing.md)).
5. In the description, say what changed, why, and how you checked it. "Docs-only change, no tests run" is a fine answer for docs.

The [Pull Request Guide](./docs/contributing/pull-request-guide.md) has the full workflow and the local checks to run.

## What to expect

A maintainer will review your pull request and may ask for changes. SilentSuite is a small project, so reviews can take a while. If yours has been quiet for a long time, a polite comment on the pull request is fine.

Big or unexpected changes may be declined even when the code is good, which is another reason to open an issue first.

## Keep private data out

Don't paste passwords, API keys, recovery phrases, `.env` values or real calendar, contact or task content into issues, pull requests, screenshots or logs. Redact debug output before you post it.

Security problems go by email, not public issues. See [SECURITY.md](./SECURITY.md).

## Code of Conduct

Everyone taking part is expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

Your contribution is licensed under the license of the part of the repository you change: AGPL-3.0-only for the server, web app, self-host and documentation; GPL-3.0-only for the Android app; the terms in [`bridge/LICENSE`](./bridge/LICENSE) for the Bridge. Check the `LICENSE` file in the folder you are working in. The [README](./README.md#license) has the details.
