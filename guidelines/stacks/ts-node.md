# TypeScript on Node.js

Added to every stage's prompt. The repository's existing patterns win over this file; the repository's `tsconfig`, lint rules and Node version decide what is allowed.

## Types

- **Strict TypeScript.** Keep `strict` on. It already covers `noImplicitAny`, `strictNullChecks`, `strictPropertyInitialization` and `useUnknownInCatchVariables`. Never loosen a compiler option, add `@ts-ignore`, or silence an error with `as any` or a non-null `!`. If the repository also enables `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` or `noImplicitOverride`, write code that satisfies them (check an indexed access for `undefined`, mark overrides with `override`).
- **`unknown`, not `any`.** Narrow it with type guards, `instanceof`, `in` or a schema parse. A `catch` variable is `unknown`: narrow it before reading `.message`.
- **Model states precisely.** Prefer discriminated unions over optional flags, `readonly` and `as const` for data that does not change, `satisfies` to check a literal without widening it, and small named types over repeated inline shapes.
- **Derive types from one source.** When a runtime schema (Zod or similar) exists, infer the type from it instead of writing both by hand.

## Modules and structure

- **Module system.** Follow the repository's: ES modules need `"type": "module"` or `.mjs`, and relative imports then need the file extension; `__dirname` does not exist there (use `import.meta.dirname`). Import built-ins with the `node:` prefix (`node:fs/promises`, `node:path`).
- One responsibility per file; a small public surface. No circular imports. Use the repository's import style (aliases, extensions, barrel files or not).
- **Functions.** Small, named, pure where possible; one clear step per function. Pass dependencies in. Read `process.env` once, at the edge, into a typed config object, and fail at startup if a required value is missing.

## Errors

- Throw `Error` subclasses with a precise message and, when you wrap another error, keep the original: `new Error('Could not load plan', { cause: err })`. Never throw strings or plain objects.
- Decide on a stable identifier for errors callers branch on (a `code` property or a subclass). Do not branch on `error.message`: Node itself says messages can change between versions.
- Distinguish expected failures (bad input, not found, conflict) from bugs. Handle the first kind explicitly and close to where they happen; let the second kind propagate.
- Never swallow an error. Do not catch only to log and continue; log with context or rethrow.
- Attach an `'error'` listener to every `EventEmitter` and stream you create, or the process crashes.

## Async

- Every promise is awaited, returned or explicitly handled; no floating promises (`void` only for a deliberate fire-and-forget with its own `.catch`). An unhandled rejection can terminate the process.
- Independent work runs in `Promise.all` (or `Promise.allSettled` when one failure must not cancel the rest). Bound concurrency for large batches; do not fire thousands of requests at once.
- Do not block the event loop with synchronous file, crypto or large JSON work on a request path. Put timeouts and cancellation (`AbortSignal`) on network and subprocess calls.

## Security (Node.js security best practices)

- **Validate untrusted input at the boundary** (HTTP bodies, query, headers, files, environment, queue messages) with a schema, and convert it to typed values there. Reject unknown fields where the contract is strict.
- **Prototype pollution.** Do not recursively merge or assign untrusted objects into your own objects. Use `Object.hasOwn()` (not `obj.hasOwnProperty`), and a `Map` or `Object.create(null)` for dictionaries keyed by user input.
- **Injection.** Parameterise database queries. Run subprocesses with `execFile`/`spawn` and an argument array, never a shell string built from input. Resolve user-supplied paths against a fixed base directory and reject anything that escapes it.
- **Secrets.** Never log, return or hard-code secrets, tokens or personal data. Compare secrets with `crypto.timingSafeEqual`, and hash passwords with a slow, salted function (`crypto.scrypt` or the repository's library).
- **HTTP servers.** Handle socket errors, keep the server's timeouts set, and put size limits on request bodies.
- **Dependencies.** Add one only when the plan names it. Keep the lockfile in step, and never run install scripts or downloaded code outside the sandbox.

## Tests

- Name files `*.test.ts` (or `*.spec.ts`) beside the code, or follow the repository's layout; use the runner already configured (Vitest or Jest unless it says otherwise).
- Test behaviour through the public interface: inputs, return values, thrown errors. One clear arrange, act, assert per test. Names read as behaviour: `rejects an expired token`.
- Mock only external boundaries (network, database, clock, file system). Reset or restore mocks, fake timers, stubbed globals and stubbed environment variables after every test so state cannot leak. Remember that `vi.mock` / `jest.mock` calls are hoisted above imports, and that mocking a function does not change calls made to it from inside its own module.
- No dependence on test order, real time, randomness or the network. Cover the error path and the edge cases the criteria name, not only the happy path.

## Avoid

Mutating arguments; default exports that hide names; `console.log` left in code; magic numbers without a named constant; catching an error only to log and continue; `enum` where a union of string literals does the job unless the repository uses enums; deep inheritance; global mutable state; and dependencies for what the standard library already does.

<!-- Sources: typescriptlang.org/tsconfig (strict family); nodejs.org/en/learn/getting-started/security-best-practices; nodejs.org/api/errors.html; nodejs.org/api/esm.html; vitest.dev/guide/mocking. -->
