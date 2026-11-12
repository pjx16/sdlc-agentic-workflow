# NestJS

- **Structure.** One module per feature (`*.module.ts`, `*.controller.ts`, `*.service.ts`, DTOs beside them). Controllers stay thin: parse and validate input, call a service, shape the response. Business logic lives in services.
- **Dependency injection.** Inject through constructors; never `new` a service. Provide shared things from a module that exports them; avoid circular module imports (extract the shared part into a third module).
- **DTO validation.** Validate every request body, query and parameter with the project's validation approach (class-validator pipes or a schema) before it reaches a service. Never trust types alone at runtime.
- **Errors.** Throw Nest `HttpException` subclasses (or the project's own) from services and let exception filters shape the response. Do not return error objects with a 200 status. Never leak stack traces or internals to clients.
- **Authentication and authorization.** Protect routes with guards, not ad-hoc checks inside handlers. Check ownership or role on every route that reads or changes someone's data.
- **Persistence.** Keep queries in a repository/service layer, use parameterised queries or the ORM, and wrap multi-step changes in a transaction.
- **Tests.** Unit-test services with their dependencies replaced by fakes; test controllers with `@nestjs/testing` and `supertest` for status codes and response shape. Use the runner already configured in the repository (`jest` unless it says otherwise). Name files `*.spec.ts` or `*.test.ts` as the repository does.
- **Avoid.** Fat controllers, business logic in guards or interceptors, global mutable state, reading `process.env` outside a config provider, and swallowing errors in `try/catch` without rethrowing.
