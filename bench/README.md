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

- **Mount 1000 queries: about 1.3× (+19 ms).** Each query model is several
  atoms plus a connect action per subscription.
- **Unmount 1000 queries: about 2.3× (+11 ms).** Most of it is aborting
  Reatom scopes, see below.
- **Update 1000 queries in one transition: about 2.2× (+4 ms).** That's
  roughly 4µs per update for `wrap()`, the atom write and recompute, and the
  component notification.
- **Fewer renders.** The binding renders each item twice on mount, against
  three times for `useQuery`, and commits half as often.
- **Bundle: +1.4 KiB gzip** for the Convex part over convex/react's, in an app
  that already ships Reatom. Without Reatom, add its 5.3 KiB.

None of this shows on a page with a few dozen queries. It matters only when
hundreds of subscriptions start or stop in one frame.

## Where unmount time goes

Aborting a Reatom scope builds an abort reason, a `DOMException` that captures
a stack: about 1.5 ms per 1000 in Node, while 1000 `AbortController`s cost
0.02 ms. Two places do it per subscription:

1. `withConnectHook` registers its cleanup through `abortVar.subscribe` and
   runs it through `abortVar.spawn`, so every disconnect builds two reasons and
   an extra frame. The binding uses its own `withSyncConnectHook`
   (`src/shared/api/convex/withSyncConnectHook.ts`): the same `onConnect`
   action with its abort scope, but the cleanup runs from a call hook on
   `onConnect.abort`, outside the aborted scope. That took unmount from 25.3
   to 21.6 ms.
2. `reatomComponent` subscribes every component to `abortVar`, and
   `abortVar.subscribe` detaches with `listenerController.abort()`, which
   builds a default reason per component. The controller only removes a
   listener; nobody reads that reason.

Both are candidates for Reatom itself. Passing one shared, prebuilt reason in
`abortVar.subscribe`'s unsubscribe (a one-line change) brought unmount to
12.3 ms with the binding's hook and 13.3 ms with `withConnectHook`, measured
by patching the installed `@reatom/core` for one run.

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
