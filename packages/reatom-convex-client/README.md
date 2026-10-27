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

`mise run convex:smoke:native`, and `mise run e2e:real` against the app built
on this client, passed on a local anonymous backend with both auth providers:
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

## The SDK with both changes

[`packages/convex-patched`](../convex-patched/README.md) puts the two
changes into `BaseConvexClient`: query set edits batched per microtask, and
transitions applied to the queries they name while no optimistic update is
pending. From [RESULTS_PATCHED.md](../bench/RESULTS_PATCHED.md), all eight
columns in one page, medians in ms:

| Scenario, per-message | convex/react | convex/react, patched | binding, JSX | binding, JSX, patched | native, JSX |
| --------------------- | -----------: | --------------------: | -----------: | --------------------: | ----------: |
| mount                 |         59.2 |                  9.99 |         67.3 |                  13.9 |        11.9 |
| unmount               |         8.82 |                  1.44 |         10.4 |                  2.90 |        1.37 |
| update all            |         3.66 |                  3.81 |         3.69 |                  2.94 |        2.25 |
| coalesced mount       |         14.1 |                  9.61 |         16.9 |                  14.2 |        12.1 |

Under @reatom/react the patched binding mounts in 23.7 ms against 22.8 for
native. The patch adds 0.4 KiB gzip to each app.

convex/react on the patched SDK is the fastest column at mounting and
unmounting 1000 queries, with or without Reatom. The binding on the
patched SDK is 2 ms behind native on mount and 1.5 ms on unmount under
@reatom/jsx. Both send the same 2 transitions on mount, so the rest sits in
the client code above the protocol; this run doesn't profile where. Native
keeps its 8 KiB bundle advantage.

## The fork builds

Three branches of [Guria/convex-js](https://github.com/Guria/convex-js)
build `convex@1.48.0` from source:

- `batched-query-set-transitions` ports `convex.patch` to the TypeScript
  sources ("TS patch").
- `reatom-browser-client` moves the state of each `convex/browser` class
  into `@reatom/core` and keeps the API ("Reatom SDK").
- `reatom-native-client` keeps the sync client's state in atoms and exports
  them as `reatomConvexClient` from `convex/browser` ("Atoms SDK").
  `BaseConvexClient`, `ConvexClient` and convex/react run on top of it. Its
  parity tests run each scenario on npm `convex@1.48.0` and on the branch and
  expect the same trace; `REATOM.md` on the branch lists where it differs on
  purpose.

From [RESULTS_ARTIFACTS.md](../bench/RESULTS_ARTIFACTS.md), 19 columns in
one page, medians in ms. "Atoms SDK API" reads the Atoms SDK's atoms
directly, without the binding:

| Scenario             | convex/react | convex/react, TS patch | convex/react, Atoms SDK | binding, JSX, TS patch | binding, JSX, Atoms SDK | Atoms SDK API, JSX | native, JSX |
| -------------------- | -----------: | ---------------------: | ----------------------: | ---------------------: | ----------------------: | -----------------: | ----------: |
| mount                |         65.5 |                   10.6 |                    14.4 |                   17.4 |                    20.3 |               9.24 |        12.2 |
| unmount              |         9.87 |                   1.69 |                    2.91 |                   3.03 |                    4.65 |               1.99 |        1.94 |
| update all           |         4.12 |                   4.34 |                    6.15 |                   4.32 |                    5.16 |               3.15 |        3.13 |
| coalesced mount      |         14.8 |                   10.4 |                    13.3 |                   15.7 |                    18.7 |               9.77 |        12.5 |
| coalesced update all |         5.46 |                   4.09 |                    4.95 |                   4.30 |                    4.97 |               3.48 |        3.05 |

- Read directly, the Atoms SDK is as fast as native: under @reatom/jsx it
  mounts 1000 queries in 9.24 ms against 12.2 and matches native on update
  all and unmount (unmount IQRs 1.75–2.34 and 1.55–2.30). Under
  @reatom/react it mounts in 20.4 ms against 25.3.
- Through its compat classes it is slower than the TS patch: convex/react
  mounts in 14.4 ms against 10.6 and unmounts in 2.91 against 1.69, with IQRs
  apart. That is still 4.5× faster than stock on mount. Each query is an atom,
  so the SDK API pays an atom per subscription and a write per update.
- The Reatom SDK stays within about 1 ms of the TS patch under convex/react
  and @reatom/jsx. Under @reatom/react it updates 1000 queries in 12.7 ms
  against 10.0.
- Bundle, gzip over each app's baseline: the Atoms SDK API app adds 16.9 KiB
  under @reatom/jsx, native 15.2, the binding on the Atoms SDK 23.2. The
  convex/react app on the Atoms SDK adds 25.9 KiB against 20.9 stock, since it
  ships Reatom.

## Verdict

For convex/react apps, propose the `batched-query-set-transitions` branch
upstream. Two methods of `BaseConvexClient` take convex/react to 0.16× of its
stock mount time, and neither rewrite on Reatom beats that through the SDK
API.

For Reatom apps, the Atoms SDK reads as fast as the native client, and its
parity with `convex@1.48.0` is tested, which native's is not. It replaces
native if depending on a fork of `convex` and a Reatom preview build is
acceptable. If not, keep the binding on the patched SDK: under @reatom/jsx
it stays 1.1–5.2 ms behind native per 1000 subscriptions, and there is no
protocol code to own.

## Reproduce

```sh
nub install
mise run validate
mise run bench --native --write
mise run bench --native --unbatched --write
mise run bench --patched --write
mise run bench --artifacts --write  # needs the tarballs, see packages/bench/README.md
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
