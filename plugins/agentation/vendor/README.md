# Vendored `agentation`

`agentation/` is npm `agentation@3.0.2` with `agentation.patch` applied to
`dist/index.js` and `dist/index.mjs`. Source maps are dropped; nothing else in
the package is changed, and its `LICENSE` (PolyForm Shield 1.0.0) travels with
the copy, as that licence requires of a modified redistribution.

## Why it is vendored rather than patched

Upstream gates React component detection on its own bundle's `NODE_ENV` and
recognises only React 18's fiber markers. bb bundles every plugin frontend as
production and mounts React 19, so the stock package disables inspection on a
page it could inspect. The patch keys the check on the host page instead and
adds React 19's `__reactContainer$` root marker.

Bun applies `patchedDependencies` in this workspace only. bb builds a `git:`
install itself, after an `npm install` that knows nothing about that field — so
a registry dependency would ship unpatched, and the toolbar would silently lose
component detection for everyone who installs from a release tag. A `file:`
dependency is the one form both package managers resolve the same way.

## Re-vendoring a new upstream release

```sh
npm pack agentation@<version>            # or fetch the tarball another way
tar xf agentation-<version>.tgz
cd package && git apply ../agentation.patch   # rewrite the hunks if they moved
rm -f dist/*.map
```

Copy `package.json`, `LICENSE`, `README.md`, and `dist/` over `agentation/`,
refresh `agentation.patch` from the diff you actually applied, and run
`bun run --filter '@smsunarto/bb-plugin-agentation' build` before committing.
