# Next.js (App Router)

Added to every stage's prompt for Next.js projects. The repository's existing structure, Next.js version and `next.config` win over this file. Check the version before using an API from the latest docs.

**TypeScript basics apply.** Keep `strict` on; no `any`, `@ts-ignore` or non-null `!` to silence the compiler; narrow `unknown`; never leave a promise floating; validate untrusted input with a schema at the boundary.

## Server and Client Components

- **Server first.** Layouts and pages are **Server Components** by default. Use them to fetch data, use secrets, and send less JavaScript. Add `'use client'` only to the smallest component that needs state, event handlers, effects, browser-only APIs (`window`, `localStorage`) or custom hooks.
- `'use client'` marks a boundary: everything that file imports is bundled for the browser. Keep the directive on small leaf components, not on large parts of the tree.
- **Pass data as props**, and only serialisable values (no functions or class instances). Pass only the fields the client component needs, never a whole database record.
- **Compose with `children`.** A Server Component can be passed into a Client Component as `children` or another prop (a modal slot, for example). Put context providers in a small Client Component that takes `children`, as deep in the tree as possible. Wrap a third-party component that needs client features in your own `'use client'` file.
- **Keep server code on the server.** Put `import 'server-only'` in modules that use secrets, the database or `process.env`. Only `NEXT_PUBLIC_*` variables reach the browser; never prefix a secret with it.

## Data fetching

- Fetch in Server Components, close to where the data is used, with `fetch` or the project's data layer. Do not fetch in a client `useEffect` what the server could provide; for client-side data use React's `use` with a promise from the server, or the library the repository already uses (SWR, React Query).
- **Avoid waterfalls.** Start independent requests together and await them with `Promise.all` (`Promise.allSettled` when one failure must not break the page). Await sequentially only when one request needs the other's result.
- Stream slow parts: wrap them in `<Suspense>` with a meaningful fallback, or add `loading.tsx`. Put the `await` for request-time data deep in the tree so the rest of the page is not blocked.
- Non-`fetch` data access (ORM, SQL) that several components need in one request is wrapped in React's `cache`, so it runs once per request.
- Since Next.js 15, `params`, `searchParams`, `cookies()` and `headers()` are asynchronous: `await` them.
- **Caching.** Do what the repository's version and config do. With `cacheComponents: true`, cache with `'use cache'` plus `cacheLife` and `cacheTag`, and stream everything else; without it, follow the older fetch cache and revalidation options. Never cache data that depends on the user's cookies, headers or session in a shared cache.

## Mutations and data security

- Mutate with **Server Actions** (`'use server'`) or Route Handlers. After a mutation, call `revalidatePath` or `revalidateTag` (or `refresh()`), then `redirect` if needed. `redirect` throws, so call it outside a `try/catch` and after the revalidation. Never mutate during render (no cookie writes or revalidation in a component body); do it in an action.
- **Treat every Server Action and Route Handler like a public endpoint**: it can be called by a direct POST, not just from your UI. Inside each one: re-check authentication, check **authorization on the specific resource** (does this user own this record?), and validate all input (form data, params, search params, headers) with a schema (Zod or the repository's choice). A page-level check does not protect an action.
- **Centralise data access in a data access layer**: `server-only` functions that perform the auth and ownership checks and return **minimal DTOs**, not raw records. Keep `process.env` reads inside it. Components and actions call it; they do not query the database directly.
- Return only what the UI needs from an action; never return a whole record. Do not put secrets in closures captured by inline actions.
- Do auth checks close to the data. Layouts do not re-render on navigation, so a check there is not enough; `proxy.ts` (`middleware.ts` in older versions) is only for fast optimistic checks, never the only defence. Rate-limit expensive or abuse-prone actions.
- Sessions live in `HttpOnly`, `Secure`, `SameSite` cookies set on the server, with a minimal payload; do not store personal data in them. Prefer the authentication library the repository uses over hand-rolled code.

## Errors, routing and loading

- **Expected errors** (validation, failed request) are return values: have the action return `{ message }` or field errors and show them with `useActionState`, with `aria-live` on the message. Do not throw for them.
- **Unexpected errors** are thrown and caught by error boundaries: add `error.tsx` (a Client Component) per segment, and `global-error.tsx` (with its own `<html>` and `<body>`) at the root. Error boundaries do not catch errors in event handlers; catch those and set state.
- Use `notFound()` with `not-found.tsx` and `redirect()` from `next/navigation`; do not render 404 or error pages by hand. Follow the existing `app/` layout (route groups, private folders) and file conventions.
- Treat `/[param]` segments and `route.ts` handlers as user input: validate params and authorize.

## Components, accessibility and state

- Small components with typed props and no business logic in JSX. Reuse the repository's components, tokens and styling approach before adding new ones. Use `next/link`, `next/image` and `next/font` rather than raw equivalents.
- Accessible by default: semantic elements, a `label` for every control, button versus link used correctly, visible focus, keyboard use, and `alt` text.
- Prefer URL state (search params) and server data over client state; keep client state local; add a global store only if the repository already has one. Never use `dangerouslySetInnerHTML` with untrusted text.

## Tests

- Use the repository's runner (Vitest or Jest with Testing Library unless it says otherwise): render, interact the way a user does, and assert on visible text and roles, not on implementation details. Mock `fetch`, `next/navigation` and `next/headers` at the edge.
- Unit tests cover synchronous Server and Client Components, hooks and pure functions. **`async` Server Components are not unit-testable** with Vitest today: cover them with an end-to-end test (Playwright if the repository has it) or move their logic into a testable function.
- Test Server Actions and the data access layer as functions: success, validation failure, unauthenticated and not-the-owner cases. Test loading, error and empty states, not only the data state.

## Avoid

Fetching in client effects what the server could provide; `'use client'` at the top of large trees; importing server-only code into client files; passing whole records to client components; trusting `searchParams`, `params` or hidden form fields; authorization only in a layout or in the UI; secrets in `NEXT_PUBLIC_*`; mutations or cookie writes during render; `dangerouslySetInnerHTML` with untrusted text; and mixing server-only and client code in one file.

<!-- Sources: nextjs.org/docs/app/getting-started/{server-and-client-components,fetching-data,caching,mutating-data,error-handling}; /docs/app/guides/{data-security,authentication,testing/vitest}. -->
