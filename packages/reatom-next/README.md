# reatom-next

The Reatom build `mise run bench` runs as `next`, next to the stable one in
`packages/bench`, or next to `packages/reatom-base` with `--matched`. Nothing imports this package; the benchmark resolves
`@reatom/core`, `@reatom/react` and `@reatom/jsx` from its directory.

It installs the pkg.pr.new preview of commit `f967994` on the Reatom branch
[`perf/abort-listener-shared-reason`](https://github.com/reatom/reatom/compare/v1001...perf/abort-listener-shared-reason),
which shares one abort reason across `abortVar` listener detaches. To compare another build, change
those three `dependencies` in `package.json` to a release or another preview:

```json
"@reatom/core": "https://pkg.pr.new/@reatom/core@<sha>",
"@reatom/react": "https://pkg.pr.new/@reatom/react@<sha>",
"@reatom/jsx": "https://pkg.pr.new/@reatom/jsx@<sha>"
```

A preview reports the same version as the release it branched from, so the
header names the URL too. A hoisting install may put one of them in the root
`node_modules`; the benchmark still resolves it from here by Node's rules and
fails if a page would bundle two copies.

`mise run bench` reinstalls on the next run. The report header shows the
version each build bundled, plus the URL for URL dependencies.
