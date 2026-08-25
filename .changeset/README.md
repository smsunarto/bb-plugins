# Changesets

Add one changeset for every user-visible package change:

```sh
bun run changeset
```

Each changeset must target one package. On `main`, the release workflow keeps
one version PR per changed package. Merging one PR publishes only that scoped
package and its unscoped mirror. The workflow also creates a GitHub Release
with a `<plugin-id>/v<version>` tag.

`dotfiles` and `pr-walkthrough` are private and are never versioned or
published by Changesets.
