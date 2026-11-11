# Next.js (App Router)

- **Server first.** Pages and layouts are Server Components by default. Add `'use client'` only to the smallest component that needs state, effects or browser APIs, and keep data fetching on the server.
- **Data and mutations.** Fetch on the server (with the project's helper) and pass plain data down. Mutations go through route handlers or server actions that validate their input and check the session. Never expose secrets to the client; only `NEXT_PUBLIC_*` variables reach the browser.
- **Routing.** Follow the existing `app/` layout (route groups, `loading.tsx`, `error.tsx`, `not-found.tsx`). Use `notFound()` and `redirect()` from `next/navigation`; do not render error pages by hand.
- **Components.** Small, typed props, no business logic in JSX. Reuse the repository's existing components and styling approach before adding new ones. Make forms and controls accessible: labels, roles, keyboard use, visible focus.
- **State.** Prefer URL state and server data over client state. Keep client state local; avoid global stores unless the repository already uses one.
- **Tests.** Test components with the project's runner (`vitest` and Testing Library unless it says otherwise): render, interact the way a user does, assert on visible text and roles, not on implementation details. Mock `fetch` and `next/navigation` at the edge.
- **Avoid.** Fetching in client effects what the server could provide, `dangerouslySetInnerHTML` with untrusted text, large client bundles from importing server-only code, and mixing server-only and client code in one file.
