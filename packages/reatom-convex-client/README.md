# Native Reatom Convex client

An experiment: `convex/browser`'s `BaseConvexClient` and `ConvexClient`
rewritten in Reatom v1001, speaking `convex@1.48.0`'s websocket protocol. It
imports nothing from `convex/browser` or `convex/react` at runtime; it uses
`convex/values` for the value codec, `convex/server` for function names and
`convex`'s version string.

```ts
import { reatomConvex, reatomConvexClient } from 'reatom-convex-client'

const convex = reatomConvex(
	() => reatomConvexClient('https://your-deployment.convex.cloud'),
	'convex',
)
const notes = convex.query(api.notes.list, () => args(), 'notes')
```

`reatomConvex` has the API of `reatom-convex`: `query`, `preloadedQuery`,
`paginatedQuery`, `mutation` with `optimisticUpdate`, `action`, `setAuth`,
`clearAuth`, `serverAuthenticated`, `isRefreshingAuth`, `connectionState`.
`convex.client` holds a `reatomConvexClient`, not an SDK object. Call it and
close it inside a Reatom frame.

## How state is kept

- Socket state, connection count, retries and pause intent are atoms. The
  socket opens on the first subscriber, request or `setAuth`, and stays open
  until `close()`.
- Query set version, identity version, the version of received results, the
  highest observed timestamp, the token, the auth state machine, in-flight
  requests and pending optimistic updates are atoms.
- Each query token has one entry with a `result` atom. Connecting that atom
  adds the query to the server's set; losing its last reader removes it. Dedupe
  is Reatom's subscriber count. The binding's query state is a computed over
  the entry, with no callback bridge and no per-model connect hook.
- Query set changes made in one microtask go out as one `ModifyQuerySet`.
  `batchQuerySet: false` sends one message per change, as the SDK does.
- A transition updates only the entries it names. Optimistic updates replay
  only while some are pending.
- Socket handles, timers, the chunk buffer, the token and id indexes and raw
  server results live in a mutable object inside a per-context runtime atom.
  Nothing subscribes to them; they exist so lookups stay O(1). Entries are held
  through `WeakRef`, so an unused one gets collected.
- `withConnectionHooks` sets Reatom's internal `__reatom.onConnect` to two
  plain actions: no AbortController per connect, no AbortError per disconnect.
  It only fits synchronous work.
- Pagination keeps its page list in a writable computed. Page queries are
  ordinary entries, so equal pages dedupe across models. Losing the last reader
  resets the list to the first page.

## Protocol coverage

Implemented and tested against the fake server or a scripted socket:

- `Connect` with session id, connection count, last close reason and highest
  observed timestamp; query set add/remove with versions; journals; u64
  timestamps; query failures with `ConvexError` data.
- Both transition shapes, chunked transitions, pings, start-version checks,
  fatal errors.
- Mutations resolve once a transition reaches their commit timestamp, so the
  caller reads its own write. Optimistic updates compose in request order and
  drop on confirmation or failure.
- Actions resolve on their response. On reconnect an in-flight action fails,
  queued requests are sent, and mutations are resent. Duplicate responses are
  ignored.
- Auth: cached then fresh token, server confirmation, scheduled refresh with
  clock skew, `initialAuthTokenReuse`, bounded retries on rejection, refresh
  callbacks, `expectAuth`, replacing or clearing auth during a fetch. A throwing
  fetcher logs and ends unauthenticated.
- Backoff with jitter and the server's overload reasons, 60s inactivity
  reconnect, the browser `online` event, the unsaved-changes warning.
- Live pagination, `loadMore`, server-requested page splits, skip, args
  changes, page errors. Preloaded values become live queries.

`mise run convex:smoke:native` and `mise run e2e:real` against `mise run
dev:native` passed on a local anonymous backend with both auth providers:
queries, real JWTs, mutations, load-more, a sign-up action, session restore and
sign-out.

Missing or stubbed:

- Admin auth and impersonation, component paths, `reportDebugInfoToConvex`
  metrics, the HTTP client, transition listeners and the imperative
  `onUpdate`-style API.
- Function log lines print in the SDK's format, but the SDK's log-line
  listeners don't exist.
- Loaded page lists belong to each model; `ConvexClient` shares them between
  equal paginated subscriptions. Invalid cursors surface as errors.
- Resuming from an auth pause always sends `Authenticate`, `None` when there is
  no token. The SDK sends nothing then, which can leave the old identity on the
  server if auth was cleared mid-fetch.
- Tested against one local backend in Node and Chromium only. Hosted
  deployments, long auth sessions and other browsers are untested.
- `withConnectionHooks` depends on a Reatom internal, and the wire types are a
  copy of 1.48.0's. Either can break on upgrade.

## Results

From [RESULTS_NATIVE.md](../bench/RESULTS_NATIVE.md) (batching on) and
[RESULTS_NATIVE_UNBATCHED.md](../bench/RESULTS_NATIVE_UNBATCHED.md) (one
message per query set change). Medians in ms, 1000 components, stable Reatom,
all columns in one page. Method and limits are in the
[benchmark README](../bench/README.md).

| Scenario, per-message | convex/react | binding, React | native, React | binding, JSX | native, JSX | native, JSX, unbatched |
| --------------------- | -----------: | -------------: | ------------: | -----------: | ----------: | ---------------------: |
| mount                 |         63.5 |           83.4 |          23.5 |         71.2 |        12.1 |                   29.1 |
| update all            |         4.06 |           9.28 |          9.03 |         4.25 |        3.50 |                   3.25 |
| unmount               |         9.66 |           20.6 |          11.4 |         11.5 |        2.37 |                   10.2 |
| shared update         |         2.98 |           4.38 |          4.82 |         0.83 |        0.86 |                   0.85 |
| optimistic shown      |         0.13 |           0.15 |          0.13 |         0.25 |        0.22 |                   0.24 |

| Scenario, coalesced | convex/react | binding, React | native, React | binding, JSX | native, JSX | native, JSX, unbatched |
| ------------------- | -----------: | -------------: | ------------: | -----------: | ----------: | ---------------------: |
| mount               |         15.1 |           29.9 |          22.5 |         20.4 |        12.0 |                   16.3 |
| unmount             |         4.84 |           16.6 |          11.2 |         6.22 |        1.83 |                   4.88 |

Convex's share of the bundle, gzip, over each app's baseline: convex/react
+20.9 KiB, binding +22.1 KiB under React and +23.0 KiB under JSX, native
+14.1 KiB and +15.2 KiB.

Where it wins:

- **Mounting and unmounting many queries.** Batching turns 1000 `Add`
  messages into one, and the per-message server then answers with 2
  transitions instead of 1001. That alone takes native JSX mount from 29.1 to
  12.1 ms and unmount from 10.2 to 2.37 ms.
- **Transitions without batching.** The unbatched native client still mounts
  in half the binding's time (29.1 vs 71.2 ms under JSX, 45.5 vs 82.5 under
  React). `BaseConvexClient` rebuilds and diffs its whole result map on every
  transition, so 1000 transitions cost O(N²). Native touches the entries a
  transition names.
- **Bundle.** 8 KiB gzip less than the binding plus `convex/browser`, about
  a third of Convex's share, because the SDK's classes, logger, metrics and
  vendored `Long` and `jwt-decode` are gone.
- **Paginated first page**, 0.17 vs 0.24 ms: no `PaginatedQueryClient`
  layer between the page queries and the atoms.

Where it doesn't:

- **Anything React renders.** Under @reatom/react, update all (9.0 vs 9.3 ms),
  shared update and the rest track the binding. The cost is
  `reatomComponent`, not the client.
- **Unmount under React without batching**, 19.8 vs 20.6 ms. Most of that is
  each component's `abortVar` subscription.
- **Single queries, mutations, optimistic updates.** Within a few hundredths
  of a millisecond of the binding in every column.
- **Code to own.** About 2300 lines replace the binding's 420, plus
  1200 lines of tests, all tracking a protocol Convex doesn't publish as
  stable.

## Verdict

Not worth pursuing as a replacement for the binding. The measurable gains come
from two changes: batching query set edits per microtask, and applying a
transition to the queries it names instead of rebuilding the result map. Both
fit inside `BaseConvexClient`, and both pay off only when hundreds of
subscriptions start or stop at once. Everything else either matches the
binding or depends on the view layer. In exchange the app owns reconnect, auth
races and pagination splits that the SDK ships with each Convex release. The
real-backend smoke test already caught one pagination bug the fake server had
missed: loaded cursors survived a user switch.

It would earn its keep for an app on @reatom/jsx that mounts large query sets
and counts kilobytes: there per-message mount is 0.19× convex/react and the
bundle is 8 KiB smaller. The cheaper path is to propose the two changes to `convex/browser`
and keep the binding.

## Reproduce

```sh
nub install
mise run validate
mise run bench --native --write
mise run bench --native --unbatched --write
```

Against a local anonymous deployment, each in its own terminal:

```sh
mise run convex:dev
mise run convex:env           # local signing keys and auth secret, no login
mise run convex:smoke:native  # refuses a non-loopback URL
mise run dev:native           # the app with backend.ts swapped to this client
mise run e2e:real
```

`validate` stays offline; it runs the fake-server and scripted-socket tests.
