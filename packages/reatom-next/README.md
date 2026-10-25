# reatom-next

The Reatom build `mise run bench` runs as `next`, next to the stable one in
`packages/bench`. Nothing imports this package; the benchmark resolves
`@reatom/core`, `@reatom/react` and `@reatom/jsx` from its directory.

To compare another build, change those three `dependencies` in
`package.json`, for example to pkg.pr.new previews:

```json
"@reatom/core": "https://pkg.pr.new/reatom/reatom/@reatom/core@<sha>",
"@reatom/react": "https://pkg.pr.new/reatom/reatom/@reatom/react@<sha>",
"@reatom/jsx": "https://pkg.pr.new/reatom/reatom/@reatom/jsx@<sha>"
```

`mise run bench` reinstalls on the next run. The report header shows the
version each build bundled, plus the URL for URL dependencies.
