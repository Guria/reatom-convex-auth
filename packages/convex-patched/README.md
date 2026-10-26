# convex-patched

`convex@1.48.0` with two changes to `BaseConvexClient`, as
[`convex.patch`](convex.patch) against the published ESM build. The benchmark
uses it to measure what the native Reatom client's two protocol-level wins are
worth inside the SDK, with convex/react and the binding unchanged.

1. **Batched query set edits.** `subscribe` and `unsubscribe` queue their
   `ModifyQuerySet` and send everything queued in one microtask as one
   message. LocalSyncState already numbers the edits consecutively, so the
   merged message spans the first base version to the last new version. The
   queue is sent before an auth pause and dropped on reconnect, where
   `LocalSyncState.restart()` resends the whole query set. Edits made while
   paused keep the SDK path: `resume()` sends them.
2. **Per-query transitions.** While no optimistic update is pending, a
   transition updates only the results of the queries it names, and drops
   the results of queries unsubscribed since the last transition. A mutation
   response changes nothing. With optimistic updates pending, and on the
   first transition after a reconnect, the SDK path rebuilds every result and
   replays the updates.

The SDK sends one `ModifyQuerySet` per subscription and rebuilds and diffs its
whole result map on every transition, so mounting N queries against a server
that answers each message costs O(N²).

```ts
import { patchedConvex, patchedConvexFile } from 'convex-patched'

const root = patchedConvex() // .var/convex-patched, rebuilt when the patch changes
const { ConvexClient } = await import(patchedConvexFile(root, 'browser/index.js'))
```

`patchedConvex()` copies the installed `convex` package's ESM build to
`.var/convex-patched/node_modules/convex` and applies the patch, so resolving
`convex/*` from `.var/convex-patched/package.json` finds the copy. The bench
resolves `convex-patched/browser` and `convex-patched/react` that way; their
types are `convex/browser` and `convex/react`.

The tests run the patched `ConvexClient` against `convex-fake-server`. All but
the batching test also pass on the stock SDK.

To change the patch, edit a copy of the two files under
`node_modules/convex/dist/esm/browser/sync/` and regenerate `convex.patch` with
`diff -u` against the originals, `a/` and `b/` prefixed paths relative to the
package root.
