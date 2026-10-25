# Benchmark: convex/react vs the Reatom binding

```bash
mise run bench            # print the report
mise run bench --write    # save it to bench/RESULTS.md
```

[RESULTS.md](RESULTS.md) holds the latest numbers. This page explains them.

## How it runs

`scripts/bench.ts` builds `bench/index.html` in production mode, with React's
profiling build so `<Profiler>` can count commits. It opens the page in
Chromium with cross-origin isolation, which gives 5µs timers, and calls
`runBenchmarks`. Both bindings run the same scenarios
(`bench/official.tsx`, `bench/reatom.tsx`). Every iteration gets a fresh
server, client and React root, and the two bindings swap which one runs first.

The server is `src/shared/mocks/fakeConvexServer.ts`, running in the page. It
speaks Convex's websocket protocol and answers on later macrotasks, so both
clients do their normal work: JSON parsing, query set versions, optimistic
layers. There is no network and no server-side query execution. That removes
the noise both bindings would share and isolates what differs between them.

Bundle sizes come from minified builds of `bench/size/*.tsx`. Each one is the
same small app: client, auth, connection state, a skippable query, an
optimistic mutation and a paginated query.

## What the numbers say

The two are within a tenth of a millisecond on single queries, mutations,
optimistic updates and pagination. The gaps show up only when 1000
subscriptions start, stop or update at once.

- **Mount 1000 queries: about 1.3× (+19 ms).** Most of this is Reatom's
  `withConnectHook`. Every connection runs an abortable action and registers
  its cleanup through `abortVar`, so each subscription creates an
  `AbortController` plus a promise. Measured on its own, an empty connect hook
  adds 3–17 ms per 1000 connects.
- **Unmount 1000 queries: about 2.9× (+17 ms).** Same cause: disconnecting
  aborts each of those controllers. An empty hook adds 11–19 ms per 1000
  disconnects, which covers the whole gap.
- **Update 1000 queries in one transition: about 2.3× (+4.6 ms).** That's
  roughly 5µs per update for `wrap()`, the atom write and recompute, and the
  component notification.
- **Fewer renders.** The binding renders each item twice on mount, against
  three times for `useQuery`, and commits half as often.
- **Bundle: +1.3 KiB gzip** for the Convex part over convex/react's, in an app
  that already ships Reatom. Without Reatom, add its 5.3 KiB.

A Reatom app would only feel the connect-hook cost if it mounts or unmounts
hundreds of subscriptions in one frame. A synchronous connect hook doesn't
need an abort scope, so that overhead could be fixed in Reatom itself.

## What the binding avoids

`ConvexClient.onUpdate` from `convex/browser` checks every listener on every
transition. Each new subscription brings back its own transition, so N
subscriptions cost O(N²). Without React, 1000 `onUpdate` subscriptions took
about 300 ms. `ConvexReactClient.watchQuery` took about 4 ms against the same
server. The binding subscribes through `client.client` (`BaseConvexClient`)
instead and dispatches by query token the way `ConvexReactClient` does
(`watchQuery` in `src/shared/api/convex/reatomConvex.ts`). With `onUpdate`,
the mount scenario took 268 ms.

Paginated queries still go through `ConvexClient.onPaginatedUpdate_experimental`
because the paginated query client is not exported. That's fine for the few
paginated lists an app usually has.

## Limits

- One machine, one browser. Treat the ratios as more meaningful than the
  absolute times.
- The official pagination column measures the stable `usePaginatedQuery`.
  It keeps pages in React state. The binding uses the core paginated query
  client, the same one `usePaginatedQuery_experimental` uses.
- Anything at or under 0.2 ms is within a few timer ticks.
