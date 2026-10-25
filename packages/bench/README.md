# Benchmark: convex/react vs the Reatom binding

```bash
mise run bench            # print the report
mise run bench --write    # save it to RESULTS.md
```

[RESULTS.md](RESULTS.md) holds the latest numbers. This page explains them.

## How it runs

`run.ts` builds `index.html` in production mode, with React's profiling build
so `<Profiler>` can count commits, once per Reatom build:

- `stable`: the `@reatom/*` packages this package depends on.
- `next`: the ones `packages/reatom-next` installs. Point its `package.json`
  dependencies at another release or a pkg.pr.new preview to compare it. It
  installs the pkg.pr.new preview of the Reatom branch
  [`perf/abort-reason-connect-hook-jsx-runtime`](https://github.com/reatom/reatom/tree/perf/abort-reason-connect-hook-jsx-runtime)
  at `45b31c8`, see [Where unmount time goes](#where-unmount-time-goes).

Reatom keeps global state, so a page never loads two copies. A Vite plugin
resolves every `@reatom/core`, `@reatom/react` and `@reatom/jsx` import, the
binding's and the adapters' included, from the build's package directory. It
records the directories it used and fails on a second copy of a package; the
report header lists the version of each from there. Each page also reports
`@reatom/core`'s `VERSION`, which carries only the major.

The runner opens each page in its own browser context, with cross-origin
isolation for 5µs timers. Five columns run the same scenarios: convex/react
(`official.tsx`, in the stable page), and the binding rendered by
@reatom/react (`reatom.tsx`) and by @reatom/jsx (`reatomJsx.tsx`) in each
build. Every iteration runs each scenario for all five columns, switching
pages as it goes, and rotates which column starts. Every run gets a fresh
server, client and container.

Published @reatom/jsx has only the classic `h`/`hf` runtime; its
`jsx-runtime` entry exports neither `jsx` nor `Fragment`. TypeScript reads the
package's JSX types through a per-file `@jsxImportSource`. For a build whose
`jsx-runtime` lacks `jsx`, the plugin resolves it to `reatomJsxRuntime.ts`, a
small adapter over `h`; the report header says which builds used it.

The server is `packages/convex-fake-server`, running in the page. It
speaks Convex's websocket protocol and answers on later macrotasks, so both
clients do their normal work: JSON parsing, query set versions, optimistic
layers. There is no network and no server-side query execution. That removes
the noise both bindings would share and isolates what differs between them.

Bundle sizes come from minified builds of `size/*.tsx`. Each one is the
same small app: client, auth, connection state, a skippable query, an
optimistic mutation and a paginated query. The Reatom apps and their baselines
are built once per Reatom build.

## What the numbers say

These are the stable build's numbers; the next section covers `next`. All three are within a few tenths of a millisecond on single queries,
mutations, optimistic updates and pagination. The gaps show up only when 1000
subscriptions start, stop or update at once, and they depend more on the view
layer than on the binding.

With @reatom/jsx:

- **Close to convex/react on lifecycle.** Mount 1.2×, unmount 1.2×, update
  all 1.1×.
- **Faster when many elements read one query.** Mount 0.39×, update 0.25×:
  there is no component layer, so an update writes the bound attributes.
- **Slower on the 100-item list.** Optimistic update 1.5×, confirmed mutation
  1.7×. Reactive array children rebuild the whole list on each change; a
  `reatomLinkedList` is upstream's answer for lists that change often.
- **Smallest bundle.** The whole app is 30.7 KiB gzip against 86.7 KiB for
  convex/react, because React is gone.

With @reatom/react:

- **Mount 1000 queries: about 1.3× (+17 ms).** Each query model is several
  atoms plus a connect action per subscription.
- **Unmount 1000 queries: about 2.4× (+12 ms).** Most of it is aborting
  Reatom scopes, see below.
- **Update 1000 queries in one transition: about 2.1× (+4 ms).** That's
  roughly 4µs per update for `wrap()`, the atom write and recompute, and the
  component notification.
- **Fewer renders.** The binding renders each item twice on mount, against
  three times for `useQuery`, and commits half as often.
- **Bundle: +1.2 KiB gzip** for the Convex part over convex/react's, in an app
  that already ships Reatom. Without Reatom, add its 5.3 KiB.

The same binding runs close to convex/react under @reatom/jsx, so most of the
@reatom/react gap is per-component work in `reatomComponent`, not the binding.

None of this shows on a page with a few dozen queries. It matters only when
hundreds of subscriptions start or stop in one frame.

## Where unmount time goes

Aborting a Reatom scope builds an abort reason, a `DOMException` that captures
a stack: about 1.5 ms per 1000 in Node, while 1000 `AbortController`s cost
0.02 ms. Two places do it per subscription:

1. `withConnectHook` registers its cleanup through `abortVar.subscribe` and
   runs it through `abortVar.spawn`, so every disconnect builds two reasons and
   an extra frame. The binding uses its own `withSyncConnectHook`
   (`packages/reatom-convex/src/withSyncConnectHook.ts`): the same `onConnect`
   action with its abort scope, but the cleanup runs from a call hook on
   `onConnect.abort`, outside the aborted scope. That took unmount from 25.3
   to 21.6 ms.
2. `reatomComponent` subscribes every component to `abortVar`, and
   `abortVar.subscribe` detaches with `listenerController.abort()`, which
   builds a default reason per component. The controller only removes a
   listener; nobody reads that reason.

The `next` build fixes both in Reatom, plus the missing JSX runtime:

- `abortVar.subscribe` detaches every listener with one shared, prebuilt
  reason.
- `withConnectHook` runs a synchronously returned cleanup from
  `onConnect.abort`, the way `withSyncConnectHook` does. A cleanup that a
  promise resolves to keeps the abort subscription.
- @reatom/jsx exports `jsx`, `jsxs`, `jsxDEV` and `Fragment`, so the
  `jsx-runtime` entry works without the adapter.

Against stable, in [RESULTS.md](RESULTS.md):

- **@reatom/react unmount: 20.4 → 11.9 ms**, 2.41× → 1.40× of convex/react.
  The binding already avoids `withConnectHook`, so this is the shared reason
  alone, saved once per `reatomComponent`.
- **@reatom/jsx: no change.** It has no per-component `abortVar`
  subscription, and the native runtime runs the same as the adapter.
- **Everything else is within the interquartile range.**
- **Bundle:** the @reatom/jsx baseline grows 0.4 KiB gzip. The preview builds
  the branch's whole `@reatom/jsx`, including changes on its base newer than
  the 1001.3.0 release. @reatom/react apps are the same size.

With `withConnectHook` fixed upstream, the binding could drop
`withSyncConnectHook` once it requires a release with the change.

## What the binding avoids

`ConvexClient.onUpdate` from `convex/browser` checks every listener on every
transition. Each new subscription brings back its own transition, so N
subscriptions cost O(N²). Without React, 1000 `onUpdate` subscriptions took
about 300 ms. `ConvexReactClient.watchQuery` took about 4 ms against the same
server. The binding subscribes through `client.client` (`BaseConvexClient`)
instead and dispatches by query token the way `ConvexReactClient` does
(`watchQuery` in `packages/reatom-convex/src/reatomConvex.ts`). With `onUpdate`,
the mount scenario took 268 ms.

Paginated queries still go through `ConvexClient.onPaginatedUpdate_experimental`
because the paginated query client is not exported. That's fine for the few
paginated lists an app usually has.

## Limits

- The stable @reatom/jsx runs use the runtime adapter above. Only `next` uses
  a native automatic runtime, from a preview rather than a release.
- One machine, one browser. Treat the ratios as more meaningful than the
  absolute times.
- The official pagination column measures the stable `usePaginatedQuery`.
  It keeps pages in React state. The binding uses the core paginated query
  client, the same one `usePaginatedQuery_experimental` uses.
- Anything at or under 0.2 ms is within a few timer ticks.
