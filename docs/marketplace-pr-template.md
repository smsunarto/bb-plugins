# Marketplace submission PR template

For submitting a plugin from this repo to
[get-bb/marketplace](https://github.com/get-bb/marketplace). One PR per plugin —
each entry is its own `entries/<id>.json` file, so separate PRs stay
conflict-free and can be reviewed and merged independently.

The listing PR carries no code: it adds one entry file plus (optionally) one
icon file. The plugin itself stays here and is installed from a
`plugins/<id>` subdir at a `<id>/vX.Y.Z` tag.

The account that opens the PR is recorded in `author.github` and gates every
later change to that entry, so open these from `smsunarto`.

## Entry file

`entries/<plugin-id>.json` in the marketplace fork. The `id` must equal the
filename and the id bb derives from our package name
(`@smsunarto/bb-plugin-<x>` → `<x>`).

```json
{
  "id": "<plugin-id>",
  "displayName": "<Product Name>",
  "description": "<One concrete sentence: what it adds and what the user gets.>",
  "icon": { "url": "./icons/<plugin-id>-<sha256-first-8>.svg" },
  "tags": ["<tag>", "<tag>"],
  "author": {
    "name": "Scott Sunarto",
    "github": "smsunarto",
    "url": "https://github.com/smsunarto"
  },
  "source": {
    "git": {
      "url": "https://github.com/smsunarto/bb-plugins.git",
      "subdir": "plugins/<plugin-id>",
      "range": "^<X.Y.Z>",
      "tagPrefix": "<plugin-id>/"
    }
  }
}
```

Those seven keys are the whole contract: the entry schema is
`additionalProperties: false` and has **no `engines` field**, so compatibility
lives only in the plugin's own `package.json` and bb enforces it at install.
Adding `engines` to an entry fails CI. Keep the description factual; no
"powerful", "easy", or "best". Max 10 lowercase hyphenated tags.

Icons are hashed by content so caches can't go stale:

```sh
shasum -a 256 plugins/<plugin-id>/assets/icon.svg   # take the first 8 chars
```

## Hero image

The entry schema is `additionalProperties: false` with no screenshot field —
`icon` is the only image a listing carries. The hero belongs in the PR body,
where it does the reviewing work: it shows the surface being listed without
anyone installing the plugin first.

Hot-link it from this repo; never commit a screenshot to the marketplace fork
(the diff must stay `entries/` + `icons/`). Pin the URL to the **released
commit sha**, not `main`, so the image in the PR always matches the code being
reviewed:

```
https://raw.githubusercontent.com/smsunarto/bb-plugins/<sha>/plugins/<plugin-id>/docs/media/hero.png
```

The tag form (`.../bb-plugins/<plugin-id>/v<X.Y.Z>/plugins/...`) also resolves
despite the slash in the ref — both were verified against
`agent-proxy/v0.2.1`. The sha is still preferable: unambiguous, and immune to a
retag.

Reuse the plugin README's `alt` text verbatim. Each plugin ships its own hero
at `plugins/<plugin-id>/docs/media/hero.png` (regenerate with
`bun run screenshots`); the root `docs/media/hero.png` is the repo-wide
composite and doesn't belong in a single-plugin PR. `notify`'s hero is a
620px-wide notification rather than a full-app capture — set `width="620"` for
that one, matching its README.

## PR body

Copy from the rule down, fill every angle-bracket slot, delete nothing.

---

**Title:** `Add plugin entry: <plugin-id>`

### What it does

<Two or three sentences. What surface it adds to bb, what problem it solves,
who it's for. Link the plugin README.>

Docs: https://github.com/smsunarto/bb-plugins/tree/main/plugins/<plugin-id>

<img src="https://raw.githubusercontent.com/smsunarto/bb-plugins/<released-commit-sha>/plugins/<plugin-id>/docs/media/hero.png" alt="<the alt text from the plugin README>" width="100%" />

### Source release

|                               |                                                        |
| ----------------------------- | ------------------------------------------------------ |
| Repository                    | `https://github.com/smsunarto/bb-plugins.git` (public) |
| Subdir                        | `plugins/<plugin-id>`                                  |
| Tag prefix                    | `<plugin-id>/`                                         |
| Released tag                  | `<plugin-id>/v<X.Y.Z>` (commit `<short-sha>`)          |
| Entry range                   | `^<X.Y.Z>`                                             |
| Engines (from `package.json`) | `bb <range>`, `bbPluginSdk <range>`                    |

Multi-plugin repo: releases are tagged per plugin via Changesets, so
`tagPrefix` scopes the semver range to this plugin's tags only. The tag is
annotated, pushed, and never moved.

### Plugin checks

Run from the repo root at the released commit:

- [ ] `bun run build` — plugin builds
- [ ] `bun run typecheck` — clean
- [ ] `bun test` — <N> passing
- [ ] `bun run lint` — clean
- [ ] `bun run icons:check` — branding assets intact
- [ ] `bun run compatibility:check` — declared bb/SDK ranges still hold
- [ ] Installed from the tag into a clean bb <version> instance and exercised
      <the main surface> end to end

### Marketplace checks

Run in the marketplace fork:

- [ ] `npm ci && npm run build` — entry validates, `dist/marketplace.json` composes
- [ ] `npm run check` — release source resolves (`git ls-remote` finds the tag)
- [ ] `id` matches the filename and the id derived from `@smsunarto/bb-plugin-<plugin-id>`
- [ ] No existing entry claims this `id`
- [ ] Icon is <format>, <size> KB, no scripts or remote refs in the SVG
- [ ] Diff touches only `entries/<plugin-id>.json` and `icons/<file>`

### Permissions and external services

<Delete the lines that don't apply; be specific rather than reassuring.>

- Network: <hosts it contacts, or "none">
- Filesystem: <paths outside the bb data dir, or "none">
- Processes: <binaries it spawns, or "none">
- Credentials: <what it reads, where from, whether it ever leaves the machine>
- Platform: <macOS-only / cross-platform>
- Third-party services: <name + what data goes there, or "none">

### Notes for reviewers

<Anything non-obvious: a bundled binary, a background service, a bb version
constraint, prior art it forks. Otherwise delete.>

---

## Per-plugin values

Ready to submit (public, released, id unclaimed upstream):

| Plugin       | Entry id      | displayName  | Latest tag           | Range    |
| ------------ | ------------- | ------------ | -------------------- | -------- |
| Agent Proxy  | `agent-proxy` | Agent Proxy  | `agent-proxy/v0.2.1` | `^0.2.1` |
| Amp          | `amp`         | Amp          | `amp/v0.4.0`         | `^0.4.0` |
| GitHub Stack | `gh-stack`    | GitHub Stack | `gh-stack/v0.2.1`    | `^0.2.1` |
| Monokai      | `monokai`     | bb Monokai   | `monokai/v0.3.0`     | `^0.3.0` |
| Notify       | `notify`      | Notify       | `notify/v0.2.1`      | `^0.2.1` |

All five share `subdir: plugins/<id>`, `tagPrefix: <id>/`, and declare
`bb >=0.40.0 <1.0.0` / `bbPluginSdk >=0.4.21` in their own manifests. Re-read
the tag and the manifest before filling a PR — the table is a snapshot, not the
source of truth.

Not submittable as-is:

- **agentation** — `entries/agentation.json` upstream is already taken by
  Phosphor's `@phosphorco/bb-plugin-agentation`. Entry ids are unique per
  manifest, so ours needs a different id (and package name) or a conversation
  with the maintainers first.
- **gtd-sidebar** (was `t3sidebar`) — renamed out of the upstream collision with
  Sawyer Hood's entry; submittable once a `gtd-sidebar/vX.Y.Z` tag exists. Ours
  is a fork of bb's own example, which makes a distinct id the right answer
  regardless.
- **dotfiles**, **pr-walkthrough** — `private: true`; pr-walkthrough still
  declares itself work in progress.

## Workflow

```sh
gh repo fork get-bb/marketplace --clone=false
git clone https://github.com/smsunarto/marketplace.git /tmp/bb-marketplace
cd /tmp/bb-marketplace
git remote add upstream https://github.com/get-bb/marketplace.git
git fetch upstream main
git switch -c submit-<plugin-id> upstream/main
# add entries/<plugin-id>.json + icons/<plugin-id>-<hash>.svg
npm ci && npm run build && npm run check
git add entries/<plugin-id>.json icons/<plugin-id>-<hash>.svg
git commit -m "Add plugin entry: <plugin-id>"
git push -u origin submit-<plugin-id>
gh pr create --repo get-bb/marketplace --base main \
  --head smsunarto:submit-<plugin-id> \
  --title "Add plugin entry: <plugin-id>" --body-file pr-body.md
```

Expect `Validate` to sit at `action_required` rather than running: fork PRs
from a first-time contributor need a maintainer to approve the workflow. Local
`npm run check` runs the identical command, so say so in the PR body and let the
reviewer trigger CI.

After merge, a compatible release needs no new PR: tag `<plugin-id>/vX.Y.Z`
inside the entry's range and bb surfaces it via `bb plugin outdated`. Changing
the source, id, branding, description, or range does need a new reviewed PR.
