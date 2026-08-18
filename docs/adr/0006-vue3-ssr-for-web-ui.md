# ADR-0006: Vue3 SSR for the Web UI

## Status

Accepted.

## Context

The control plane is a local, token-authenticated Web UI that lets the user
view status, add/remove shared folders. It previously shipped as a single
static `ui/index.html` file: inlined CSS + a hand-rolled DOM script that
stored the token in `localStorage` and `fetch`'d `/api/status` and
`/api/folders`.

A redesign was requested with three goals:

1. **Remove client-side JavaScript dependence** — no browser JS needed to
   see the current state of the device.
2. **Eliminate paste-token friction** — opening the page should be enough;
   the token is stored in an `HttpOnly` cookie instead of the browser.
3. **Unify rendering with the control API** — one server-side rendering path
   rather than a client that talks back to the same process.

## Decision

Adopt a **Vue 3 server-side rendering (SSR)** stack for the Web UI:

- Vue SFCs under `src/web/`, built by **Vite** with `@vitejs/plugin-vue` and
  `@vue/server-renderer`.
- A Vite `buildMode:'ssr'` + `target:'node22'` + `format:'es'` pipeline
  produces an SSR entry (`dist/ui/server.js`) and a tiny client bundle
  for interactive form actions.
- `src/api.ts` dynamically `import()`s the SSR entry on each `GET /`,
  renders the app with the current `StatusPayload`, and streams the HTML.
- A new `GET /login` shows the token prompt; a `POST /login` validates the
  token and sets an `HttpOnly; SameSite=Lax; Secure` session cookie.
- The existing `/api/*` endpoints **keep Bearer-token auth** for
  compatibility; the SSR page and `/login` additionally accept the
  `HttpOnly` cookie.

## Alternatives considered

1. **Hand-written template SSR, zero new runtime dependencies.**
   The simplest and most aligned with the project's zero-dependency history.
   A single function in `api.ts` could interpolate `StatusPayload` into HTML
   strings. Rejected: no component model, form/interaction logic would drift
   into ad-hoc JS, and the request explicitly favored a Vue stack.

2. **Full-stack framework (Nuxt / Next.js) running as a separate dev
   server behind a reverse proxy.**
   Heaviest option and introduces a second process to orchestrate. Rejected:
   the control plane is small (one status view + folder CRUD) and belongs in
   the same daemon process.

3. **Keep the static `ui/index.html` and add only cookie-based auth.**
   Solves the paste-token problem but not the "no client JS" goal. Rejected.

## Consequences

- **New runtime dependencies:** `vue`, `@vitejs/plugin-vue`, `@vue/server-renderer`, `vite`, plus `@vitejs/plugin-vue` types. The build now has two
  steps: `tsc` (backend) and `vite build` (SSR UI). The `npm run build`
  script composes both.
- **`import.meta.url` in `api.ts` must resolve** the SSR entry via
  `import.meta.resolve('./dist/ui/server.js')` rather than the old static
  `../ui/index.html` path.
- **Cookie lifecycle** is now part of the daemon's state surface: a cookie
  jar is per-request, no server-side session store is needed (the token
  itself is the session credential).
- **Client-side hydration** remains small: only the add/remove-folder form
  actions use a lightweight client bundle; the rest of the page is rendered
  on the server and served as static HTML.
