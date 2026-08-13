# Changesets

Add one changeset for every user-visible package change:

```sh
bun run changeset
```

On `main`, the release workflow keeps one version PR up to date. Merging that
PR publishes each changed scoped package and its unscoped mirror, then creates
GitHub Releases with tags in the form `<plugin-id>/v<version>`.

`dotfiles` and `pr-walkthrough` are private and are never versioned or
published by Changesets.
