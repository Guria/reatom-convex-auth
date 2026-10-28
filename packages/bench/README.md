# Benchmark: convex/react vs @reatomized/convex

```bash
mise run bench          # print the report
mise run bench --write  # also save it to RESULTS.md
mise run bench --items 50 --iterations 1 --warmup 0  # quick check that it runs
```

[RESULTS.md](RESULTS.md) holds the latest numbers. This page explains how they
are measured and what they say.

## How it runs

Three columns run the same scenarios on one page:

- `convex/react`: `ConvexReactClient` with `useQuery`, `usePaginatedQuery` and
  `useMutation` (`official.tsx`).
- `@reatom/react`: [`@reatomized/convex`](https://www.npmjs.com/package/@reatomized/convex)
  rendered by `reatomComponent` (`reatom.tsx`).
- `@reatom/jsx`: the same models rendered by @reatom/jsx, real DOM nodes with
  no virtual DOM (`reatomJsx.tsx`).

Both Reatom columns share their models (`reatomModels.ts`); the two React
columns share the root that counts commits (`reactView.tsx`).

`run.ts` builds `index.html` in production mode, with React's profiling build
so `<Profiler>` can count commits, and serves it with cross-origin isolation
for 5µs timers. Playwright drives `window.bench` from `main.tsx`. Each
iteration runs every scenario for every column, rotating which column goes
first, and every run gets a fresh server, client and container. Warmup
iterations are dropped.

A scenario ends when a DOM condition holds, such as 1000 elements with
`data-v="1"`. `completion.ts` scans the container once, then checks only the
nodes each mutation record names, so the check costs the same for a renderer
that commits once and one that patches 1000 nodes separately.

The server is `packages/convex-fake-server`, running in the page. It speaks
Convex's websocket protocol and answers on later macrotasks, so the clients do
their normal work: JSON parsing, query set versions, optimistic layers. Every
scenario runs against two response shapes, alternating which goes first:

- per-message: one transition for each query-set message. A client that sends
  one message per subscription gets up to 1000 transitions for 1000 queries.
- coalesced: one transition after a burst of query-set messages.

Neither is a claim about how a deployed Convex backend groups its responses.

@reatom/jsx's `jsx-runtime` entry exports only the classic `h`/`hf`, so
`run.ts` resolves `@reatom/jsx/jsx-runtime` to `reatomJsxRuntime.ts`, a small
automatic runtime over them.

Bundle sizes come from minified builds of `size/*.tsx`. Each Convex app is the
same small app over `size/app.ts` or its convex/react equivalent: client,
auth, connection state, a skippable query, an optimistic mutation and a
paginated query. Its Convex share is its size over a baseline with the same
view layer and no Convex.

## What the numbers say

From [RESULTS.md](RESULTS.md), 1000 components where a scenario mounts many.

- **Mounting 1000 queries with per-message responses: 54 ms for convex/react,
  13 ms with @reatom/react, 6.3 ms with @reatom/jsx.** convex/browser sends a
  query-set message per subscription and gets 1001 transitions back.
  @reatomized/convex batches the changes of one microtask into one message, so
  the server answers twice.
- **With coalesced responses that batching no longer matters.** Mount is 11.5
  ms for convex/react, 13.6 ms (1.18×) with @reatom/react and 6.0 ms (0.52×)
  with @reatom/jsx.
- **Unmount is faster in both Reatom columns:** 0.24× and 0.09× per-message,
  0.48× and 0.20× coalesced.
- **@reatom/react is slower when many components update at once.** Update all
  1.3–1.6×, shared mount and shared update 1.4–1.6×, about 1–3 ms over 1000
  components. @reatom/jsx is 0.3–0.6× on the same rows, so the cost is in
  `reatomComponent`, not the client.
- **Single queries, mutations, optimistic updates and pagination stay within
  0.2 ms in every column.** @reatom/jsx is 1.7–1.8× on the 100-item list,
  0.08–0.16 ms more, because reactive array children rebuild the list.
- **Fewer renders.** Both Reatom columns render each item twice on mount,
  against three times for `useQuery`, and @reatom/react commits twice where
  convex/react commits three or four times.
- **Bundle.** The Convex share is 15.9 KiB gzip with @reatom/react and 16.8 KiB
  with @reatom/jsx, against 20.9 KiB for convex/react. The @reatom/jsx app is
  24.9 KiB in total, against 86.7 KiB for the convex/react one, because React
  is gone.

None of this shows on a page with a few dozen queries. The differences matter
when hundreds of subscriptions start, stop or update in one frame.

## Limits

- One machine, one browser. The ratios mean more than the absolute times.
- React runs its profiling build for timing and render counts alike.
- Below 0.3 ms, scheduling and harness overhead dominate.
- The fake server answers in the page, so there is no network latency, and
  the response shapes are synthetic.
