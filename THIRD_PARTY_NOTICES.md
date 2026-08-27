# Third-party notices

This repository's own code is [MIT](LICENSE). It also contains code and assets from
the projects below, under their own terms, which follow.

This file covers the **whole repository tree**, published or not. Each published
plugin also carries its own `plugins/<id>/THIRD_PARTY_NOTICES.md`, scoped to what
that package's npm tarball actually ships — its bundled `dist/` output and its
`assets/` artwork. The per-plugin files are narrower on purpose; they do not replace
this one, and neither replaces a licence that travels with a dependency.

---

## bb — `get-bb/bb`

Three separate bodies of code arrive from bb, all under the MIT licence:

| What                                                                                                                                         | Where                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| The whole **GTD Sidebar** plugin, forked from `examples/plugins/t3sidebar` at commit `f13c2d35f96540012b305f3b555839b30e1b6163` (2026-08-07) | `plugins/gtd-sidebar/`                      |
| Provider brand-mark **geometry**, lifted from bb's own icon components                                                                       | `plugins/gtd-sidebar/lib/provider-marks.ts` |
| shadcn/ui-derived components, vendored through bb's own plugin component registry and marked `/* shadcn/ui-derived */`                       | `plugins/**/components/ui/`                 |

```
MIT License

Copyright (c) 2026 Michael Yong

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Source: <https://github.com/get-bb/bb>

---

## Trademarks and brand marks

Two files carry third-party brand artwork. **No licence above grants trademark
rights**, and none is claimed here. Both are used only to identify the product a
user has chosen to install, which is nominative use.

| Mark                                                 | Where                                                                                                                                                                                                           | Owner                   |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Amp                                                  | `plugins/amp/assets/*.svg` and `plugins/amp/src/amp-brand.ts`, used for plugin branding and rendered in the Orb banner                                                                                          | Sourcegraph             |
| OpenAI, Claude, Cursor, Grok, opencode, Pi, oh-my-pi | `plugins/gtd-sidebar/lib/provider-marks.ts`                                                                                                                                                                     | their respective owners |

In bb provider chrome, a host-served logo always takes precedence over vendored
geometry and is rendered as a muted silhouette. The Amp Orb banner uses the
vendored Amp mark as an Amp-red status accent.

---

## `@ampcode/sdk`

`plugins/amp` depends on `@ampcode/sdk`, published by Sourcegraph under the **Amp
Commercial License**, and bundles it into `dist/host.js`. That code is
Sourcegraph's and stays under the Amp Commercial License, not MIT; the licence
permits the redistribution `@smsunarto/bb-plugin-amp` performs.

`plugins/amp/vendor/ampcode-cli-stub` is a local, empty stand-in for
`@ampcode/cli` written for this repository. It contains none of Sourcegraph's
code; it exists so `@ampcode/sdk` falls through to the `AMP_CLI_PATH` the plugin
configures, instead of resolving a bundled CLI.

---

## `agentation`

`plugins/agentation` bundles `agentation` into `dist/app.js`, from a **modified
copy** kept at `plugins/agentation/vendor/agentation`. The changes are recorded
in `plugins/agentation/vendor/agentation.patch` and explained in that
directory's README; upstream's own `LICENSE` and `README.md` travel with the
copy unchanged.

That package uses the [**PolyForm Shield License 1.0.0**](https://polyformproject.org/licenses/shield/1.0.0/),
not MIT. It permits use, modification, and redistribution, but not use in a
product or service that competes with the software or another product from its
authors. A distribution must include a copy of that licence; it is included both
beside the vendored copy and in `plugins/agentation/THIRD_PARTY_NOTICES.md`.

Source: <https://github.com/benjitaylor/agentation>

---

## CLIProxyAPI

`plugins/agent-proxy` **downloads and runs** CLIProxyAPI
(<https://github.com/router-for-me/CLIProxyAPI>) at install time. No CLIProxyAPI
source or binary is vendored in this repository, so its licence applies to what
lands on the user's machine, not to anything distributed here.

---

## Fonts

The documentation screenshot renderer loads **Inter** and **IBM Plex Mono** from
the `@fontsource-variable/inter` and `@fontsource/ibm-plex-mono` development
dependencies. Both fonts use the SIL Open Font License 1.1. Their binaries are
not committed to this repository or shipped in a plugin tarball.

Sources: <https://github.com/rsms/inter>, <https://github.com/IBM/plex>
