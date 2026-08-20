# Third-party notices — GTD Sidebar

The plugin's own code is MIT, Copyright (c) 2026 Scott Sunarto. See [LICENSE](LICENSE).

This package also ships code and artwork from the projects below, under their own
terms. Every entry is MIT licensed; the licence text is given once at the end and
applies to each copyright notice listed here.

---

## bb — `get-bb/bb`

MIT License, Copyright (c) 2026 Michael Yong.

| What                                                                                                                         | Where it ships                                  |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| The whole plugin, forked from `examples/plugins/t3sidebar` at commit `f13c2d35f96540012b305f3b555839b30e1b6163` (2026-08-07) | `dist/app.js`, `dist/server.js`, `dist/app.css` |
| Provider brand-mark geometry, lifted from bb's own icon components                                                           | `dist/app.js`                                   |
| shadcn/ui-derived components, vendored through bb's plugin component registry                                                | `dist/app.js`                                   |

Source: <https://github.com/get-bb/bb>

---

## shadcn/ui

MIT License, Copyright (c) 2023 shadcn.

The select and icon components under `components/ui/` are derived from shadcn/ui and
are compiled into `dist/app.js`.

Source: <https://github.com/shadcn-ui/ui>

---

## Hugeicons Free Icons

MIT License, Copyright (c) 2025 Hugeicons.

Covers `@hugeicons/react` and the free icon artwork of `@hugeicons/core-free-icons`.
The React component and the icon paths it draws are compiled into `dist/app.js`. The
plugin icon and logos in `assets/icon.svg`, `assets/logo.svg` and `assets/logo-dark.svg`
are Hugeicons free artwork.

Source: <https://github.com/hugeicons/hugeicons-react>

---

## clsx

MIT License, Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com).

Compiled into `dist/app.js`.

Source: <https://github.com/lukeed/clsx>

---

## tailwind-merge

MIT License, Copyright (c) 2021 Dany Castillo.

Compiled into `dist/app.js`.

Source: <https://github.com/dcastil/tailwind-merge>

---

## zod

MIT License, Copyright (c) 2025 Colin McDonnell.

Compiled into `dist/server.js`.

Source: <https://github.com/colinhacks/zod>

---

## Not shipped here

React, `@radix-ui/react-select`, `@radix-ui/react-context-menu` and `@get-bb/plugin-sdk`
are **not** bundled in this package. The bb app provides them at run time, so their
licences travel with bb, not with this plugin.

---

## Trademarks and brand marks

The provider glyphs drawn from `lib/provider-marks.ts` depict third-party brands:
OpenAI, Claude, Pi, Cursor, Grok Build, Hermes Agent, opencode and oh-my-pi. Each mark
belongs to its owner.

**No licence above grants trademark rights**, and none is claimed here. The marks
identify the agent a user has chosen to run, which is nominative use. A host-served
logo always takes precedence over the vendored geometry and is drawn as a muted
silhouette rather than in brand color.

---

## MIT License

The following text applies to every entry above, together with that entry's own
copyright notice.

```
MIT License

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
