# reatom-base

The Reatom build `mise run bench --matched` runs as `base`, in place of the
stable release. Nothing imports this package; the benchmark resolves
`@reatom/core`, `@reatom/react` and `@reatom/jsx` from its directory.

It installs the pkg.pr.new preview of `v1001` at `906602e`. Those three
packages have the same sources as `aee4f572`, the commit `reatom-next`
branches from, so `--matched` measures only that branch's change.
