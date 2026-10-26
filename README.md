# Reatom Convex Auth

An experiment in binding [Convex](https://convex.dev) to
[Reatom](https://github.com/reatom/reatom) v1001, built on the
[Karkas](https://github.com/apphane-dev/karkas) stack:

- `packages/reatom-convex`: a Reatom binding that covers what `convex/react`
  does, with state in atoms instead of hooks. See
  [Compared with convex/react](#compared-with-convexreact).
- Convex Auth and better-auth on one deployment, behind one session model.
  See [Auth providers](#auth-providers).
- `packages/bench`: a browser benchmark of the binding against convex/react,
  rendered by @reatom/react and @reatom/jsx. See
  [packages/bench/README.md](packages/bench/README.md).

## Stack

- Package Manager: Nub
- Framework: React 19
- State Management & Routing: Reatom
- Styling: Panda CSS with Park UI components
- Internationalization: ParaglideJS
- UI Development & Testing: Storybook with Vitest integration
- Testing: Vitest browser mode with Playwright, written as Storybook stories
- Mocking: MSW (Mock Service Worker)
- Code Quality: oxfmt, oxlint, Fallow, TypeScript 7
- Build Tooling: Vite+ (`vite-plus`)
- Git Hooks & Quality Orchestration: `hk`
- Task Workflows: `mise`

## Architecture

The app follows a Feature-Sliced Design (FSD) layout under `src/`:

| Layer        | Responsibility                                                                |
| ------------ | ----------------------------------------------------------------------------- |
| `app/`       | Application shell, global composition, integration stories, MSW browser setup |
| `pages/`     | Route-level compositions and per-page UI, navigation, loading/error states    |
| `widgets/`   | Compositional blocks combining entities and shared UI (e.g. `AppShell`)       |
| `entities/`  | Domain models: API client calls, types, mocks, and Reatom atoms               |
| `shared/`    | Cross-cutting infra: API client, router, kahraman test extensions, components |
| `paraglide/` | Generated ParaglideJS output (do not edit)                                    |

## Setup

Install dependencies (this also generates Panda CSS, compiles ParaglideJS,
generates the MSW worker, and installs `hk` Git hooks):

```bash
nub install
```

## Development

The app needs a Convex backend. `convex:dev` runs a local deployment on
127.0.0.1:3210 with no Convex account, pushes `convex/` on every change, and
writes `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL` to `.env.local`. Keep it
running in its own terminal:

```bash
mise run convex:dev
```

On the first run, and whenever the deployment is new, set the variables both
auth libraries need. The script generates the missing secrets and leaves
existing ones alone:

```bash
mise run convex:env
```

Then start the app at http://localhost:5173:

```bash
mise run dev
```

The site URL better-auth trusts is `SITE_URL` on the deployment, which defaults
to `http://localhost:5173`. Run `SITE_URL=... mise run convex:env` on a fresh
deployment to use another origin.

Start Storybook:

```bash
mise run storybook
```

## Auth providers

The sign-in page has an "Auth provider" radio group: Convex Auth
(`@convex-dev/auth`, Password) or Better Auth (`@convex-dev/better-auth`, email
and password). The choice lives in localStorage and stays fixed while signed
in. Each provider has its own accounts, so the same email can exist twice.

Both providers run on one deployment. Each library sits behind an adapter in
`src/shared/api/auth/` that exposes a session atom, sign-in/up/out, and a token
fetcher. `src/entities/session` hands the active adapter's token to Convex and
reports `authenticated` only after the backend accepts it. The private notes
page renders only in that state, so its Convex subscriptions never start for a
signed-out user.

On the backend, both libraries sign RS256 JWTs with the same issuer
(`CONVEX_SITE_URL`) and audience (`convex`). Convex checks a token against the
first provider whose issuer matches, and its OIDC check accepts Convex Auth's
kid-less tokens only when the JWKS holds one key. So the two
libraries share one key pair: `convex:env` derives Convex Auth's
`JWT_PRIVATE_KEY`/`JWKS` and better-auth's static `BETTER_AUTH_JWKS` from it,
and `convex/auth.config.ts` lists a single provider. better-auth is mounted at
`/api/better-auth` because Convex Auth owns `/api/auth`. Every token carries a
`provider` claim, and `convex/viewer.ts` turns it into the owner key for notes.

## Compared with convex/react

The binding in `packages/reatom-convex/src/reatomConvex.ts` covers what the
official React hooks do. It keeps the state in atoms, so routes, loaders and
tests can read it without a component tree.

| convex/react                             | Binding                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `useQuery(q, args \| "skip")`            | `convex.query(q, () => args \| 'skip', name)`: `data`, `error`, `status` |
| `usePaginatedQuery`                      | `convex.paginatedQuery(q, () => args, { initialNumItems }, name)`        |
| `usePreloadedQuery`                      | `convex.preloadedQuery(preloaded, name)`                                 |
| `useMutation(m).withOptimisticUpdate(u)` | `convex.mutation(m, name, { optimisticUpdate: u })`                      |
| `useAction`                              | `convex.action(a, name)`                                                 |
| `useConvexAuth()`                        | `convex.serverAuthenticated`, `convex.isRefreshingAuth`                  |
| `useConvexConnectionState`               | `convex.connectionState`                                                 |
| `useConvex`                              | `convex.client`                                                          |

Query errors land in `.error()` and never reach an error boundary. A
subscription lives while something reads its atom, not while a component is
mounted. Gating is done by routes reading `sessionStatus` instead of
`<Authenticated>`. The pagination helpers from `convex/react` work with the
binding's optimistic updates: the notes page adds notes through `insertAtTop`.

`mise run bench` measures convex/react against the binding rendered by
@reatom/react and by @reatom/jsx. Single queries, mutations and pagination
come out within a few tenths of a millisecond. With 1000 subscriptions at
once, @reatom/react takes 1.25× as long to mount and 2.2× to unmount;
@reatom/jsx takes 1.1× and 1.2×, and updates 1000 readers of one query about
3× faster. See
[packages/bench/README.md](packages/bench/README.md).

## Validation

Run the full local quality pipeline (format, lint, typecheck, tests with
coverage, architecture, Fallow, build, tree-shaking):

```bash
mise run validate
```

For fast feedback on staged files, prefer `hk check` / `hk fix`.

`validate` never touches a real backend. Stories and unit tests run the real
Convex client against an in-process server that speaks Convex's websocket
protocol (`packages/convex-fake-server/src/fakeConvexServer.ts`, with app data in
`convexBackend.ts`). better-auth's real client talks to MSW handlers, and
`convex-test` covers the backend functions.
With `convex:dev` and `dev` running, two more checks hit the real thing:

```bash
mise run convex:smoke  # both providers sign up and read their own notes over HTTP
mise run e2e:real      # the same journeys in Chromium, including a reload
```
