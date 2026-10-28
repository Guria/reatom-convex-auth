# Reatom Convex Auth

An experiment in binding [Convex](https://convex.dev) to
[Reatom](https://github.com/reatom/reatom) v1001, built on the
[Karkas](https://github.com/apphane-dev/karkas) stack:

- The app runs on [`@reatomized/convex`](https://www.npmjs.com/package/@reatomized/convex),
  the published Reatom client for `convex`. Queries, connection and auth state
  are atoms. See [The Convex client](#the-convex-client).
- Convex Auth and better-auth on one deployment, behind one session model.
  See [Auth providers](#auth-providers).
- `packages/bench`: a browser benchmark of `@reatomized/convex`, rendered by
  @reatom/react and @reatom/jsx, against convex/react. See
  [packages/bench/README.md](packages/bench/README.md).
- `packages/convex-fake-server`: an in-process server that speaks Convex's
  websocket protocol, for stories, tests and the bench.

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

## Demo

https://reatomized.github.io/convex-demo/ runs the app against the
production deployment of the Convex project `aleksei-gurianov/reatom-convex-auth`
(`quirky-buffalo-548`). `.github/workflows/pages.yml` builds it on every push
to `main` or `exp/reatom-native-convex-client`, with the deployment URLs
written in the workflow.

The backend is deployed by hand, with a Convex login. `CONVEX_DEPLOYMENT`
selects the project over the local deployment in `.env.local`:

```bash
export CONVEX_DEPLOYMENT=dev:shiny-tortoise-848
nub exec convex deploy
SITE_URL=https://reatomized.github.io mise run convex:env --prod
```

Production's GitHub OAuth app has the callback URL
`https://quirky-buffalo-548.convex.site/api`. Its credentials are set with the
commands from [Auth providers](#auth-providers) plus `--prod`.

## Auth providers

The sign-in page has an "Auth provider" radio group: Convex Auth
(`@convex-dev/auth`, Password) or Better Auth (`@convex-dev/better-auth`, email
and password). The choice lives in localStorage and stays fixed while signed
in. Each provider has its own accounts, so the same email can exist twice.

"Continue with GitHub" signs in through the selected provider. Both libraries
share one GitHub OAuth app whose callback URL is the deployment's
`CONVEX_SITE_URL` plus `/api`. GitHub accepts any redirect under it, so it
covers `/api/auth/callback/github` and `/api/better-auth/callback/github`.
GitHub sends the browser back to `/login` with `?code=` (Convex Auth) or
`?ott=` (better-auth), and `src/entities/session` trades that for a session.
Each deployment needs the app's credentials, and a local one its own OAuth app
with the callback URL `http://127.0.0.1:3211/api`:

```bash
nub exec convex env set AUTH_GITHUB_ID <client id>
nub exec convex env set AUTH_GITHUB_SECRET  # reads the secret from stdin
```

Both providers run on one deployment. `src/entities/session` builds a provider
for each library with `@reatomized/convex/convex-auth` and
`@reatomized/convex/better-auth`, and passes the selected one to
`reatomAuthState`, which hands its token to Convex and reports `authenticated`
only after the backend accepts it. The private notes page renders only in that
state, so its Convex subscriptions never start for a signed-out user. Sign-in
goes through the Convex Auth provider's `signIn` or through better-auth's own
client.

On the backend, both libraries sign RS256 JWTs with the same issuer
(`CONVEX_SITE_URL`) and audience (`convex`). Convex checks a token against the
first provider whose issuer matches, and its OIDC check accepts Convex Auth's
kid-less tokens only when the JWKS holds one key. So the two
libraries share one key pair: `convex:env` derives Convex Auth's
`JWT_PRIVATE_KEY`/`JWKS` and better-auth's static `BETTER_AUTH_JWKS` from it,
and `convex/auth.config.ts` lists a single provider. better-auth is mounted at
`/api/better-auth` because Convex Auth owns `/api/auth`. Every token carries a
`provider` claim, and `convex/viewer.ts` turns it into the owner key for notes.

## The Convex client

`reatomConvexClient` comes from the published
[`@reatomized/convex`](https://www.npmjs.com/package/@reatomized/convex)
package. `src/shared/api/backend.ts` holds the client in the `convex` atom, so
stories put a client connected to the fake server there. The client takes
`@reatom/core` as a peer, and the app runs the published `1001.3.0` build, so
the client's atoms live in the app's context. It also peers `convex` and
imports `convex/values` and `convex/server` from it, so `ConvexError` and
function references are the app's own. `overrides` in
`package.json` keep `@convex-dev/auth`, better-auth, `convex-helpers` and
`convex-test` on the same `convex@1.48.0`.

| convex/react                             | App                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `useQuery(q, args)`                      | `convex().query(q, args)`: `data`, `error`, `status`                     |
| `usePaginatedQuery`                      | `convex().paginatedQuery(q, args, { initialNumItems })`, with `loadMore` |
| `useMutation(m).withOptimisticUpdate(u)` | `convex().mutation(m, args, { optimisticUpdate: u })`                    |
| `useAction`                              | `convex().action(a, args)`                                               |
| `useConvexAuth()`                        | `reatomAuthState(convex(), provider)`: `status`, `isAuthenticated`       |
| `useConvexConnectionState`               | `convex().connectionState`                                               |

A query is subscribed on the server while something reads its atoms. Query
errors land in `.error()` and never reach an error boundary. Routes gate on
`sessionStatus` instead of `<Authenticated>`. The pagination helpers from
`convex/react` work with the client's optimistic updates: the notes page adds
notes through `insertAtTop`.

`mise run bench` measures convex/react against `@reatomized/convex` rendered
by @reatom/react and by @reatom/jsx. Single queries, mutations and pagination
stay within 0.2 ms. Mounting 1000 queries takes 13 ms with @reatom/react and
6.3 ms with @reatom/jsx, against 54 ms for convex/react when the server
answers each query-set message, because the client batches subscriptions into
one message. When many components update at once, @reatom/react is 1.3–1.6×
slower than convex/react and @reatom/jsx 1.7–3× faster. See
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
