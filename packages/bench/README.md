# Benchmark: convex/react vs the Reatom binding

```bash
mise run bench --native --write            # binding vs native, same Reatom build
mise run bench --native --unbatched --write # control: one query-set edit per message
mise run bench --patched --write           # also convex/react and the binding on the patched SDK
mise run bench --artifacts --write         # the fork tarballs in artifacts.lock.json
mise run bench --artifacts --probe-action --write # the same on both core builds of reatom/reatom#1386
mise run bench                    # stable release vs next, print the report
mise run bench --write            # save RESULTS.md and raw samples in RESULTS.json
mise run bench --matched --write  # base vs next, as RESULTS_MATCHED.md/.json
```

[RESULTS.md](RESULTS.md) and [RESULTS_MATCHED.md](RESULTS_MATCHED.md) hold the
latest numbers. This page explains them.

## Native client comparison

`--native` uses only the stable Reatom build. Its five columns are
convex/react, binding/react, native/react, binding/jsx and native/jsx, in the
same page. [RESULTS_NATIVE.md](RESULTS_NATIVE.md) and
[RESULTS_NATIVE_UNBATCHED.md](RESULTS_NATIVE_UNBATCHED.md) include raw sample
companions as JSON. Both response shapes run in each comparison.

Native batching is on by default. Its 1000 distinct subscriptions can use
one query-set message where the SDK clients use 1000. `--unbatched` disables
that optimization; the runner records mount transition counts to make the
message-volume difference explicit. The unbatched run still uses the native
atom graph and its synchronous lifecycle hooks.

`--patched` adds three columns: convex/react and the binding under both
renderers on [`packages/convex-patched`](../convex-patched/README.md), next
to the stock and native columns, in [RESULTS_PATCHED.md](RESULTS_PATCHED.md).
A Vite plugin resolves `convex-patched/browser` and `convex-patched/react`
to the patched copy; the binding itself stays the same module and receives
the patched `ConvexClient`.

`--artifacts` adds the
[Guria/convex-js](https://github.com/Guria/convex-js) builds that
[`artifacts.lock.json`](artifacts.lock.json) pins by commit and tarball
SHA-256, in [RESULTS_ARTIFACTS.md](RESULTS_ARTIFACTS.md):

- TS patch: branch `batched-query-set-transitions`, the two changes of
  `packages/convex-patched` ported to the SDK sources.
- Reatom SDK: branch `reatom-browser-client`, `convex/browser` rewritten on
  `@reatom/core` with its API unchanged.
- Atoms SDK: branch `reatom-native-client`, the sync client's state in atoms,
  exported as `reatomConvexClient`, with the SDK API on top.

convex/react, the binding under both renderers, and the native client run
on each SDK; the Atoms SDK also runs straight through its atoms under both
renderers ("Atoms SDK API"), 19 columns in one page. Copy each tarball
(`npm pack` in the fork) to the lock's `archive` path. `artifacts.ts` checks
its SHA-256, unpacks it once under `.var/bench/artifacts/<sha256>`, and fails
if the unpacked JS changes. A Vite plugin resolves `convex-artifact-<id>/*`
to the unpacked package, and the Reatom build plugin resolves the SDK's own
`@reatom/core` import, so a page still holds one Reatom copy.

`--probe-action` runs the same columns on the two `@reatom/core` builds the
lock's `core` entries pin: the base and head of
[reatom/reatom#1386](https://github.com/reatom/reatom/pull/1386), which stops
copying an action's call log on every call within a tick. It adds a table of
one action called N times in a tick (`actionProbe.ts`): plain, with a
subscriber, with a call hook, and atom writes as a control.
`--probe-abort` runs them on the `--matched` pair instead.

The size apps share their models and renderer within each adapter, with only
the client factory changed. This avoids comparing a smaller native feature
set with a larger binding fixture. The native package's
[report](../reatom-convex-client/README.md) lists the actual missing protocol
and SDK features; equal fixture size does not imply full SDK parity.

## How it runs

`run.ts` builds `index.html` in production mode, with React's profiling build
so `<Profiler>` can count commits, once per Reatom build:

- `stable`: the `@reatom/*` releases this package depends on.
- `next`: what `packages/reatom-next` installs, the pkg.pr.new preview of the
  Reatom branch
  [`perf/abort-listener-shared-reason`](https://github.com/reatom/reatom/compare/v1001...perf/abort-listener-shared-reason).
- `base`, with `--matched` in place of `stable`: what `packages/reatom-base`
  installs, the `v1001` preview whose sources match that branch's base. The
  matched pair differs only by the branch's change.

Reatom keeps global state, so a page never loads two copies. A Vite plugin
resolves every `@reatom/core`, `@reatom/react` and `@reatom/jsx` import, the
binding's and the adapters' included, from the build's package directory. It
records the directories it used and fails on a second copy of a package; the
report header lists the version of each.

The runner opens each build's page in its own browser context, with
cross-origin isolation for 5µs timers. Five columns run the same scenarios:
convex/react (`official.tsx`, in the first build's page), and the binding
rendered by @reatom/react (`reatom.tsx`) and by @reatom/jsx (`reatomJsx.tsx`)
in each build. Every iteration runs each scenario for all five columns and
rotates which column starts. Every run gets a fresh server, client and
container.

A scenario ends when a DOM condition holds, such as 1000 elements with
`data-v="1"`. `completion.ts` scans the container once, then tracks matches
from the nodes each mutation record names, so the check costs the same for a
renderer that commits once and one that patches 1000 nodes separately.

The server is `packages/convex-fake-server`, running in the page. It speaks
Convex's websocket protocol and answers on later macrotasks, so both clients
do their normal work: JSON parsing, query set versions, optimistic layers.
Every scenario runs against two response shapes, alternating which goes
first:

- per-message: one transition for each query-set message, so mounting 1000
  queries brings back up to 1000 transitions. This is a stress case.
- coalesced: one transition after a burst of query-set messages.

Neither is a claim about how a deployed Convex backend groups its responses.
`server.bump()` recomputes every subscribed query inside the timed action;
both clients pay that.

Published @reatom/jsx has only the classic `h`/`hf` runtime; its
`jsx-runtime` entry exports neither `jsx` nor `Fragment`. For a build whose
`jsx-runtime` lacks `jsx`, the plugin resolves it to `reatomJsxRuntime.ts`, a
small adapter over `h`. All three builds here use it.

Bundle sizes come from minified builds of `size/*.tsx`. Each one is the same
small app: client, auth, connection state, a skippable query, an optimistic
mutation and a paginated query. The Reatom apps and their baselines are built
once per Reatom build.

## What the numbers say

The stable build against convex/react, from [RESULTS.md](RESULTS.md). All
three are within a few tenths of a millisecond on single queries, mutations,
optimistic updates and pagination. The gaps show up when 1000 subscriptions
start, stop or update at once, and they depend more on the view layer than on
the binding.

With @reatom/jsx:

- **Close to convex/react on lifecycle.** Per-message mount 1.08×, unmount
  1.19×, update all 1.03×.
- **Faster when many elements read one query.** Mount 0.40×, update 0.35×:
  there is no component layer, so an update writes the bound attributes.
- **Slower on the 100-item list.** Optimistic update 1.9×, confirmed mutation
  2.0×. Reactive array children rebuild the whole list on each change; a
  `reatomLinkedList` is upstream's answer for lists that change often.
- **Smallest bundle.** The whole app is 30.7 KiB gzip against 86.7 KiB for
  convex/react, because React is gone.

With @reatom/react:

- **Mount 1000 queries: 1.25× per-message (+15 ms), 2.1× coalesced (+14 ms).**
  Each query model is several atoms plus a connect action per subscription.
- **Unmount 1000 queries: 2.2× per-message (+10 ms), 3.7× coalesced (+11 ms).**
  Most of it is detaching `abortVar` listeners, see below.
- **Update 1000 queries in one transition: 1.9× (+3 ms).** About 3µs per
  update for `wrap()`, the atom write and recompute, and the component
  notification.
- **Fewer renders.** The binding renders each item twice on mount, against
  three times for `useQuery`, and commits half as often.
- **Bundle: +1.2 KiB gzip** for the Convex part over convex/react's, in an app
  that already ships Reatom. Without Reatom, add its 5.3 KiB.

The same binding runs close to convex/react under @reatom/jsx, so most of the
@reatom/react gap is per-component work in `reatomComponent`, not the binding.

None of this shows on a page with a few dozen queries. It matters only when
hundreds of subscriptions start or stop in one frame.

## The `abortVar` listener patch

`abortVar.subscribe` detaches its listeners with `listenerController.abort()`.
Without a reason, `abort()` builds a `DOMException` with a stack trace, once
per detach, and nothing reads it. `reatomComponent` subscribes every
component, so unmounting 1000 components builds 1000 of them. The branch in
`next` passes one shared reason instead.

From [RESULTS_MATCHED.md](RESULTS_MATCHED.md), base against next:

| @reatom/react unmount, 1000 queries |   base, ms (IQR) |   next, ms (IQR) |
| ----------------------------------- | ---------------: | ---------------: |
| per-message                         | 18.9 (18.0–19.5) | 11.8 (11.7–13.3) |
| coalesced                           | 15.5 (14.9–16.3) | 8.80 (7.15–9.17) |

That is about 7µs per component. A second run with convex/react moved into
the `next` page gave 21.8 → 12.9 ms and 18.3 → 7.96 ms. @reatom/jsx unmount
does not change: it has no per-component `abortVar` subscription. No other
row moves consistently, see [Limits](#limits).

The binding's query subscriptions run their cleanup through
`withSyncConnectHook` (`packages/reatom-convex/src/withSyncConnectHook.ts`)
instead of `withConnectHook`, which subscribes to `abortVar` and spawns a
frame per disconnect. Its comment lists what that trades away.

## The action call log fix

[reatom/reatom#1386](https://github.com/reatom/reatom/pull/1386) appends an
action's call log in place within a tick, unless a middleware such as a
subscriber or a call hook sits on the action. From
[RESULTS_ARTIFACTS_ACTION.md](RESULTS_ARTIFACTS_ACTION.md), base `aee4f572`
against head `9d3c413c`, one action called N times in one tick:

| N    | plain, base | plain, head | subscribed, base | subscribed, head |
| ---- | ----------: | ----------: | ---------------: | ---------------: |
| 1000 |        0.46 |        0.20 |             0.46 |             0.50 |
| 8000 |        45.8 |        1.77 |             44.8 |             48.4 |

Subscribed and hooked actions still copy the log, so they stay quadratic.
None of the 14 app columns moves beyond noise between the two builds: the
binding, the native client and the Reatom SDK rewrite don't call one action
thousands of times in a tick.

This run's raw samples, 850 KB of JSON, exceed the commit hook's size limit,
so only its report is in the repository.

## What the binding avoids

`ConvexClient.onUpdate` from `convex/browser` checks every listener on every
transition. With one transition per new subscription, as in the per-message
workload, N subscriptions cost O(N²). Without React, 1000 `onUpdate`
subscriptions took about 300 ms, against about 4 ms for
`ConvexReactClient.watchQuery`. The binding subscribes through `client.client`
(`BaseConvexClient`) instead and dispatches by query token the way
`ConvexReactClient` does (`watchQuery` in
`packages/reatom-convex/src/reatomConvex.ts`). With `onUpdate`, the mount
scenario took 268 ms.

Paginated queries still go through `ConvexClient.onPaginatedUpdate_experimental`
because the paginated query client is not exported. That's fine for the few
paginated lists an app usually has.

## Limits

- Page placement shifts results by up to about 10%. The Reatom columns in the
  page that also runs convex/react come out faster on some rows. Moving
  convex/react to the other page flipped the build-to-build differences in
  mount, shared mount and first page. Treat differences between builds under
  10% as noise.
- One machine, one browser. Treat the ratios as more meaningful than the
  absolute times.
- React runs its profiling build for timing and render counts alike.
- The official pagination column measures the stable `usePaginatedQuery`,
  which keeps pages in React state. The binding uses the core paginated query
  client, the same one `usePaginatedQuery_experimental` uses.
- Below 0.3 ms, scheduling and harness overhead dominate.
