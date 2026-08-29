# Releasing plugins

Release Please keeps one release pull request open for each publishable plugin.
Merging one release pull request creates that plugin's `<plugin-id>/v<version>`
tag and GitHub Release. The release workflow then publishes the scoped npm
package and its unscoped mirror.

## Declare a release

Release Please reads Conventional Commits that touch a plugin directory:

- `fix(<plugin-id>): ...` creates a patch release.
- `feat(<plugin-id>): ...` creates a minor release.
- Add `!` or a `BREAKING CHANGE:` footer for a major release.
- `chore`, `docs`, `test`, and root-only changes create no plugin release.

The scope helps readers, but the changed path selects the plugin. A commit that
touches several publishable plugin directories can update several independent
release pull requests.

## Migration floor

`release-please-config.json` sets `bootstrap-sha` to the migration cutover.
This prevents commits already handled by Changesets from appearing in the
initial changelogs. Release Please ignores this floor after it can find the
new release history, so it does not replay those first commits later.

The migration includes one `fix(amp)` commit after the floor. It preserves the
pending bb 0.40 patch as Amp 0.4.2. NanoCodex already has a `feat(nanocodex)`
commit after the floor, so its first Release Please pull request starts at
0.1.0.

## Retry behavior

The npm publisher runs after every successful Release Please pass. It publishes
only package versions whose matching GitHub Release and tag already exist.
Both the scoped package and its mirror are checked before publication, so a
failed or partially visible npm publish converges on the next workflow run.
