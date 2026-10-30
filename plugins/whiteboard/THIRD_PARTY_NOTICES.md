# Third-party notices

This plugin's own code is [MIT](LICENSE). It also ships code and assets from the
projects below, under their own terms.

## dev.fast Whiteboard (MIT)

- Source: `https://github.com/devdotfast/whiteboard`, `packages/review` and its
  workspace packages `json`, `local-vcs`, `review-protocol`, `trace-core`
  (five files), and `trace-protocol`.
- Upstream commit: `4ecc570` (`chore(review-desktop): bump version to 0.1.3`).
- Derived code, modified and maintained in this repository:
  - `src/shared/review/`, `src/shared/review-protocol/`, `src/shared/json/`,
    `src/shared/trace-protocol/`, `src/shared/error-message.ts` (model, protocol
    and the block and legacy-review fixtures)
  - `src/shared/node/review/`, `src/shared/node/local-vcs/`, `src/shared/node/fs/`
    (git, worktree and checkout helpers run on the bb host)
  - `src/server/lib/review/` (the engine: store, local data, progress, lenses)
  - `src/app/review/` (the Whiteboard canvas, Home and Diff views)
  - `instructions/scratchpad.md` and parts of the other `instructions/` prompts

```
MIT License

Copyright (c) 2026 dev.fast

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

## `@xyflow/react` 12.10.2 (MIT)

`src/app/review/xyflow.css` is the package stylesheet, with every rule confined
to `.review-canvas-root`. Copyright (c) 2019-2025 webkid GmbH.

## `libavoid-js` (LGPL-2.1-or-later), through `@mr_mint/elkjs-libavoid` 0.5.0 (MIT)

`src/app/lib/libavoid-wasm.ts` embeds `libavoid.wasm` from
`@mr_mint/elkjs-libavoid@0.5.0` as base64, unmodified (its sha256 is recorded in
the module). The WebAssembly binary is built from `libavoid-js`
(`https://github.com/Aksem/libavoid-js`, LGPL-2.1-or-later), which compiles the
Adaptagrams libavoid library. The corresponding source is available from that
repository. The software map uses it for edge routing.

## `elkjs` 0.11.1 (EPL-2.0)

Bundled into `dist/app.js` for software-map layout. Source:
`https://github.com/kieler/elkjs`.

## `shiki` 4.4.3 (MIT)

Bundled into `dist/app.js` to highlight code blocks and markdown fences, with
the TextMate grammars it ships, each under its upstream license. Source:
`https://github.com/shikijs/shiki`. Grammar licenses:
`https://github.com/shikijs/textmate-grammars-themes`.
