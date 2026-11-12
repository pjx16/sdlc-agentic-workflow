# TypeScript on Node.js

- **Strict TypeScript.** Keep `strict` on. No `any`; use `unknown` and narrow it. No non-null assertions (`!`) to silence the compiler. Prefer `readonly` and `as const` for data that does not change.
- **Modules.** One responsibility per file; export a small public surface from an `index.ts`. No circular imports. Use the repository's existing import style (extensions, path aliases).
- **Functions.** Small, named, pure where possible. Pass dependencies in; do not reach for globals or `process.env` deep in the code (read configuration once, at the edge).
- **Errors.** Throw `Error` subclasses with a clear message; never swallow an error silently. Validate external input (HTTP bodies, files, environment) at the boundary, and turn it into typed values there.
- **Async.** Always `await` or return promises; never leave a floating promise. Use `Promise.all` for independent work, and bound concurrency for large batches.
- **Tests.** Name files `*.test.ts` next to the code (or follow the repository's layout). Test behaviour through the public interface, not private details. One clear arrange/act/assert per test. Do not depend on test order or the network.
- **Avoid.** Mutating arguments, default exports that hide names, `console.log` left in code, magic numbers without a named constant, and catching errors only to log and continue.
