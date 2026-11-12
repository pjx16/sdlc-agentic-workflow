# Contributing

The project is in `0.0.x` pre-release and built in public. Bug reports and feedback are welcome through issues. Pull requests are not accepted yet, except small fixes agreed in an issue first.

## How to help right now

- Open an issue for bugs, questions, ideas or problems with the plan in [`BUILD_PLAN.md`](./BUILD_PLAN.md).
- Check the scope (§2 of the plan) first: features outside it will not be accepted.

## Ground rules

- Use npm and Turborepo only (no pnpm or yarn).
- Keep functions small and named after what they do; prefer boring, well-documented libraries.
- Do not add `Co-Authored-By` trailers or any AI attribution to commits.
- Never commit secrets, tokens or `.env` files.
- Run `npm run lint && npm run typecheck && npm test` before opening a PR.
- Add an entry under `## [Unreleased]` in `CHANGELOG.md`.
- Never paste unredacted logs.

By participating, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
