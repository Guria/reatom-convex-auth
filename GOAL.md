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

- [ ] karkas scaffolded with `npm create karkas@latest . --no-git`
- [ ] `git init -b main`, untouched template committed
- [ ] `mise trust` + `nub install` succeed
- [ ] `mise run validate` green on the untouched template

## Stage 2 — routing skeleton for auth

- [ ] placeholder routes: sign-in (public) and a protected page
- [ ] protected route redirects / shows sign-in when signed out (placeholder session atom)
- [ ] kahraman browser proof: both routes navigable, gate visible
- [ ] `mise run validate` green

## Stage 3 — feature

- [ ] Convex installed, local anonymous deployment runs without login
- [ ] Convex schema + private query (`messages` or similar owned by the user)
- [ ] Both auth components coexist on one deployment (or env-var fallback, with reason)
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
