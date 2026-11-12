# Review checklist

Check only the diff and what it affects. At most 10 findings per round.

## Correctness

- Does the code do what each acceptance criterion says?
- Wrong conditions, off-by-one, null or undefined paths, wrong async
  handling (missing `await`, unhandled promise).
- Broken flows: a caller or consumer the change forgot to update.
- Does the change behave correctly on the edge cases the criteria name?

## Security

- Input from users, URLs, files, or other services is validated before use.
- Authentication and authorization: every new or changed endpoint, action,
  or query checks who the caller is and what they may access.
- No secrets, tokens, or credentials in code, tests, fixtures, or logs.
- Queries are parameterised; no SQL or shell commands built from strings
  with user input.
- No sensitive data (personal data, tokens) written to logs or error
  messages.
- User-supplied file names, paths, and URLs cannot reach outside their
  intended location (path traversal, SSRF).
- New dependencies: needed, maintained, and named in the plan.

## Data and contracts

- Database schema, migrations, API shapes, DTOs, and events changed only if
  the task asked for it.
- No destructive data operation without a safeguard.

## Tests

- Every acceptance criterion has a test that would fail if the behaviour
  broke.
- Tests check behaviour, not implementation details.
- No skipped, weakened, or deleted tests.

## Standards

- Follows the repository's existing patterns and the stack guideline.
- Small named functions; the main flow reads as a list of steps.
- Error handling follows the repository's pattern.
- No dead code, commented-out code, debug logging, or unexplained TODOs.
- No `any`, `@ts-ignore`, or lint suppressions added without a reason.

## Scope

- No changes outside the subtasks.
- No unrelated refactors or formatting churn.
