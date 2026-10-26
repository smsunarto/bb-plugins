# Third-party notices

The preview card derives from bb's built-in inline-vis plugin, last synced
with `desktop-v0.44.0` (commit
`0baa605b32a00619c1d7e3f32be6553ebcf8244a`). Published pages, their agent
prompts, and `html_preview` port T3 Code (pingdotgg/t3code `cc0b86d`).

## BB inline-vis and component registry

Copyright (c) 2026 Michael Yong

The upstream plugin and the registry items vendored into
`src/app/components/ui/` and `src/app/lib/` are available under the MIT
License:

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

## T3 Code

Copyright (c) 2026 T3 Tools Inc.

The ported page contract (`src/shared/html-render.ts`), page preparation
(`src/server/lib/prepare.ts`), headless preview, and the tool descriptions in
`instructions/tools/html_render.md` and `html_preview.md` are available under
the MIT License, whose text appears above.

## Mediabunny

The built `dist/app.js` bundles unmodified code from
[Mediabunny](https://github.com/Vanilagy/mediabunny) 1.61.5, copyright (c)
Vanilagy, under the Mozilla Public License 2.0. Its source is available at
<https://github.com/Vanilagy/mediabunny>, and the license text at
<https://mozilla.org/MPL/2.0/>.

## Video.js

`vendor/video-player.ts`, and through it the built `dist/app.js`, bundles
unmodified code from [Video.js](https://github.com/videojs/video.js)
(`@videojs/html` 10.1.0), copyright 2025-present Video.js contributors,
under the Apache License 2.0. The license text is at
<https://www.apache.org/licenses/LICENSE-2.0>.
