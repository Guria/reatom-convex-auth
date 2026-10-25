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

- [ ] placeholder routes: sign-in (public) and a protected page
- [ ] protected route redirects / shows sign-in when signed out (placeholder session atom)
- [ ] kahraman browser proof: both routes navigable, gate visible
- [ ] `mise run validate` green

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
- [ ] Reatom↔Convex binding in `shared/api`: client, query subscription with connect-hook cleanup, mutation, two-phase auth state
- [ ] Convex Auth adapter
- [ ] better-auth adapter (vanilla client)
- [ ] session entity + provider switch in the UI
- [ ] auth UI (sign-in/sign-up form, sign-out) and private page
- [ ] test strategy chosen and stated
- [ ] kahraman stories: gate-closed + gate-open for Convex Auth
- [ ] kahraman stories: gate-closed + gate-open for better-auth
- [ ] steiger clean, `mise run validate` green
- [ ] README run + provider-switch section
- [ ] manual check against the real local Convex backend
