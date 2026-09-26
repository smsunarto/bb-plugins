# @bb-plugins/codex-inference

The Codex transport behind GTD Sidebar's thread naming: one plain-text prompt
through the host's Codex login, with bb's retry codes on failure.

`src/vendor/provider-codex/` is an unmodified copy of bb's Codex provider
(`plugins/provider-codex`), MIT, Copyright (c) 2026 Michael Yong. Change behavior
in the plugin that calls it, never in the copy, so a resync stays a copy.

| Upstream   | Value                                                                        |
| ---------- | ---------------------------------------------------------------------------- |
| Repository | <https://github.com/get-bb/bb>                                               |
| Tag        | `desktop-v0.44.0`                                                            |
| Commit     | `0baa605b32a00619c1d7e3f32be6553ebcf8244a`                                   |
| Files      | `plugins/provider-codex/src/codex-home.ts`, `plugins/provider-codex/src/ai/` |

To resync, replace the copy from a bb checkout and rerun this package's
typecheck and tests (the upstream tests come with the copy):

```sh
rm -rf src/vendor/provider-codex && mkdir -p src/vendor/provider-codex
git -C ~/git/bb archive <tag> plugins/provider-codex/src/codex-home.ts plugins/provider-codex/src/ai \
  | tar -x -C src/vendor/provider-codex --strip-components=2
```

Then update the tag and commit above and in GTD Sidebar's `THIRD_PARTY_NOTICES.md`.
