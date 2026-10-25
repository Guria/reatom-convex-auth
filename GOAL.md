# GOAL

State ledger. A box is checked only after its proof command passed; the proof is
noted next to it.

## Parked request

Convex + Reatom integration experiment with auth, on the karkas scaffold with
kahraman tests:

- Provider-agnostic Reatom↔Convex binding (written fresh), plus two auth
  adapters: Convex Auth (`@convex-dev/auth`, Password) and better-auth
  (`@convex-dev/better-auth`). One app, provider switchable in the UI; fall back
  to an env-var switch only if both can't share one Convex deployment.
- React + `@reatom/react` (`reatomComponent`), FSD layout checked by steiger.
- Local/anonymous Convex deployment, no login or guessed credentials.
- kahraman integration stories per provider: gate-closed (signed out → sign-in
  shown, private query not subscribed) and gate-open (sign up/in → private data
  visible → sign out).
- README section: running Convex dev + app, provider-switch mechanism.

## Stage 1 — scaffold + validation baseline

- [x] karkas scaffolded with `npm create karkas@latest . --no-git` (commit 89aae19)
- [x] `git init -b main`, untouched template committed (89aae19)
- [x] `mise trust` + `nub install` succeed
- [x] `mise run validate` green on the template after the drift repair in f2656fd
      (published 0.1.0 does not validate as-is: msw-storybook-addon 2 vs 3 API,
      coverage-v8/vitest mismatch, CSF3-only `parameters.msw`). Exit 0, 46 tests.

## Stage 2 — routing skeleton for auth

The template already ships this stage: `/login`, a `protectedRoute` layout
around `/dashboard`, a mock session atom, and kahraman stories. Proof is the
template's "Redirects Protected Routes" story in the green validate of f2656fd.
Backend work (Stage 3, commit 1b0edba) started before this box was formally
checked; no frontend code changed in between.

- [x] placeholder routes: sign-in (public) and a protected page (template)
- [x] protected route redirects to sign-in when signed out (template story)
- [x] kahraman browser proof: both routes navigable, gate visible (template story)
- [x] `mise run validate` green (f2656fd)

## Stage 3 — feature

- [x] Convex installed, local anonymous deployment runs without login
      (`CONVEX_AGENT_MODE=anonymous convex dev`, wrapped as `mise run convex:dev`)
- [x] Convex schema + private query: `notes.list` / `notes.add`, owner derived server-side
- [x] Both auth components coexist on one deployment. Proof: `mise run convex:smoke`
      (both providers sign up, get accepted, see only their own notes).
      Findings: one OIDC provider can serve both only if the JWKS has a single
      key (Convex Auth tokens have no `kid`), so both libraries sign with one
      shared RS256 key (`mise run convex:env`); better-auth lives at
      `/api/better-auth`; a `provider` claim tells the tokens apart.
- [x] Reatom↔Convex binding in `shared/api`: client, query subscription with connect-hook cleanup, mutation, two-phase auth state
      (unit tests `src/shared/api/convex/reatomConvex.test.ts`: subscribe on
      connect, re-subscribe on args change, unsubscribe on disconnect, errors
      stored, server ack tracked)
- [x] Convex Auth adapter (`shared/api/auth/convexAuth.ts`, own client for `auth:signIn`/`auth:signOut`)
- [x] better-auth adapter (vanilla `better-auth/client` behind a plain facade)
- [x] session entity (`entities/session`) + provider switch (radio group on the sign-in page)
- [x] auth UI (sign-in/sign-up form, account-menu sign-out) and private notes page
- [x] test strategy: an injected in-memory fake Convex deployment for stories
      (hermetic, part of validate; better-auth's real client runs against MSW),
      convex-test for backend functions, and `mise run convex:smoke` against the
      real local backend for what fakes cannot prove
- [x] kahraman stories: gate-closed + gate-open for Convex Auth (`src/app/integration/Auth.stories.tsx`)
- [x] kahraman stories: gate-closed + gate-open for better-auth (same file)
- [x] steiger clean, `mise run validate` green (exit 0, 54 tests)
- [ ] README run + provider-switch section
- [ ] manual check against the real local Convex backend
