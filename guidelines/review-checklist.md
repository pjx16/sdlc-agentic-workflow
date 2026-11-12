# Review checklist

Review only what is in the diff you are given. Do not comment on code that the change did not touch.

## Practices
- The repository's existing patterns are followed (structure, naming, error handling, test style).
- Functions are small and named for what they do; no dead code, no leftover debugging output, no commented-out code.
- Errors are handled deliberately: no swallowed exceptions, no vague messages, no leaked internals.
- Every acceptance criterion has a test that would fail without the change, and the tests check behaviour, not implementation details.
- Edge cases implied by the criteria are covered: empty input, limits, failures of dependencies.

## Security
- All external input is validated at the boundary (request bodies, query strings, files, environment).
- Authentication and authorization are checked on every route or action that reads or changes protected data.
- No secrets, tokens or personal data in code, tests, fixtures or logs.
- Queries are safe: parameterised or built by the ORM, never assembled from strings.
- No sensitive data is written to logs or returned to the client.
- User-supplied files, paths and URLs are handled safely (no path traversal, no unchecked redirects, no unrestricted fetching).

## Output
- At most 10 findings per round, most important first.
- Each finding has a `severity` (`critical`, `high`, `medium` or `low`), the `file` and `line`, the `issue`, the `rule` it breaks (a short name from this checklist), and a concrete `fix`.
- `critical` and `high` are for defects and security problems that must be fixed before merging; use `medium` and `low` for improvements.
- Only report issues in the diff. If there is nothing to report, return an empty list.
