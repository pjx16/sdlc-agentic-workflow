# NestJS

Added to every stage's prompt for NestJS projects. The repository's existing structure and conventions win over this file; check its Nest version before using a newer API.

**TypeScript basics apply.** Keep `strict` on; no `any`, `@ts-ignore` or non-null `!` to silence the compiler; narrow `unknown`; never leave a promise floating; throw `Error` subclasses and keep the cause; read `process.env` only in the config provider.

## Structure and dependency injection

- **One module per feature**: `*.module.ts`, `*.controller.ts`, `*.service.ts`, DTOs and entities beside them. A module declares what it provides and exports only what others need.
- **Controllers stay thin**: bind the route, validate input, call one service method, shape the response. Business rules live in services; persistence in a repository or provider.
- **Inject through constructors**; never `new` a provider. Make shared things providers exported by a module.
- **Avoid circular dependencies.** If two modules or providers need each other, extract the shared part into a third module or provider. Use `forwardRef()` only as a last resort, on both sides. Do not import module or provider classes through `index.ts` barrel files in the same folder; that causes cycles.
- **Provider scope.** Keep providers singleton. Request-scoped providers make every dependant request-scoped; use them only when the task needs per-request state.

## DTO validation

- Validate **every** body, query and path parameter before it reaches a service. Use the project's approach: `class-validator` with `ValidationPipe`, or a schema pipe (Zod) if the repository uses one. Types alone do nothing at runtime.
- With `ValidationPipe`, the safe defaults are `whitelist: true` (strip unknown properties), `forbidNonWhitelisted: true` (reject them) and `transform: true` (instances and typed primitives). Register it globally (`APP_PIPE` if it needs injection); do not rely on someone remembering `@UsePipes`. Do not return detailed validation messages for internal fields to untrusted clients.
- DTOs are **classes** with decorators, not interfaces or generics, and they must be imported as values (not `import type`), or the metadata is lost. Build variants with mapped types (`PartialType`, `PickType`, `OmitType`, `IntersectionType`) instead of copying fields.
- Array elements are not validated by `ValidationPipe` on its own: use `ParseArrayPipe` or nested `@ValidateNested()` with `@Type()`. Use `ParseIntPipe`, `ParseUUIDPipe` and similar for path parameters.
- Never trust identifiers or ownership from the body; take the caller from the authenticated request.

## Errors

- Throw built-in `HttpException` subclasses (`BadRequestException`, `NotFoundException`, `ConflictException`, `ForbiddenException`...) or the project's own, from services. Pass `cause` to keep the original error for logs; it is never sent to the client. Add a stable `errorCode` when clients need to branch.
- Let exception filters shape the response; never return an error object with a 2xx status. Unknown exceptions become a generic 500: never leak stack traces, SQL or internals.
- Built-in exceptions are not logged by default. Log unexpected errors in a filter or interceptor, once, with context and without secrets.
- A catch-all filter (`@Catch()`) is registered first so more specific filters still run. Register global filters with `APP_FILTER` when they need dependencies.
- Do not `try/catch` in a controller just to translate errors; do it in a filter. Do not swallow errors in `try/catch` without rethrowing.

## Authentication and authorization

- Protect routes with **guards** (`CanActivate`), not ad-hoc checks inside handlers. Order of execution: middleware, guards, interceptors, pipes, handler. Register a global guard with `APP_GUARD`, and mark public routes explicitly with a decorator rather than leaving them unguarded by accident.
- Read required roles or permissions with `Reflector` and a custom decorator; keep the check itself in one place.
- Authentication failure is `UnauthorizedException` (401); authenticated but not allowed is `ForbiddenException` (403). A guard that returns `false` produces a 403.
- Authorization is per resource: on every route that reads or changes someone's data, check that the caller owns it or holds the right role (this prevents IDOR). A role guard alone does not do that.
- Never put business logic in guards or interceptors.

## Configuration

- Read configuration through `ConfigService` (`@nestjs/config`), never `process.env` in feature code. Validate the environment at startup (`validate` or a Zod `validationSchema`) so the app fails fast; coerce numbers explicitly because environment variables are strings.
- Use `getOrThrow` for required values, typed config namespaces (`registerAs`) for groups, and never commit `.env` files or secrets.

## Persistence

- Reach the database only through the project's ORM or query layer in a repository or service. Use parameterised queries; never build SQL from strings with input.
- Wrap multi-step writes that must succeed or fail together in a single transaction. Do not call external services (HTTP, queues) inside a transaction.
- Do not return entities with internal or sensitive columns; map to a response DTO.

## HTTP hardening

- Use the security headers the project already sets (Helmet, or the framework's built-in security headers in the newest Nest versions), CORS with an explicit origin list, and rate limiting (`@nestjs/throttler`) on authentication and other expensive routes. Do not weaken them to make a test pass.

## Tests

- Unit-test services with their dependencies replaced by fakes: `Test.createTestingModule({...}).compile()` (await it), then `overrideProvider(X).useValue(fake)` or `useMocker` for the rest.
- Test controllers and wiring end to end with `@nestjs/testing` and `supertest`: `createNestApplication()`, apply the same global pipes, filters and prefix as `main.ts`, `await app.init()`, request `app.getHttpServer()`, and `await app.close()` in `afterAll`. Assert status codes, response shape and the validation and auth failures, not only the success path.
- Override guards with `overrideGuard()` or by swapping the `APP_GUARD` registration, not by weakening the production guard. Resolve request-scoped providers with `moduleRef.resolve()` and a context id.
- Use the runner the repository already uses (Jest unless it says otherwise); name files `*.spec.ts` or `*.test.ts` (unit, beside the code) and `*.e2e-spec.ts` (under `test/`) as the repository does.

## Avoid

Fat controllers; business logic in guards, interceptors or pipes; `new` on a provider; circular module imports; global mutable state; `process.env` outside the config provider; swallowing errors in `try/catch`; request-scoped providers by default; unvalidated `@Body()`, `@Query()` or `@Param()`; `any`-typed DTOs; and returning raw entities or error objects with 200.

<!-- Sources: docs.nestjs.com/techniques/validation; /exception-filters; /guards; /fundamentals/testing; /fundamentals/circular-dependency; /techniques/configuration; /techniques/database; /security/helmet. -->
