# Third-party notices

`@smsunarto/bb-plugin-amp` is published as bundles. The build inlines its
dependencies into `dist/server.js`, `dist/host.js`, and `dist/app.css`, and
the package also ships third-party icon artwork in `assets/`. This file lists
every third-party work the package distributes, with the required notices.

The plugin's own code is MIT — see [LICENSE](LICENSE).

Not listed here, because this package does **not** ship their code: React and
the bb plugin SDK, which the bb host supplies at run time through its plugin
runtime shim; and the Amp CLI itself, which the plugin locates on your machine
through `AMP_CLI_PATH` and never bundles.

## MIT

| Work                                    | Copyright                          | Where it is used                        |
| --------------------------------------- | ---------------------------------- | --------------------------------------- |
| [`zod`](https://zod.dev)                | Copyright (c) 2025 Colin McDonnell | `dist/server.js` and `dist/host.js`     |
| [Tailwind CSS](https://tailwindcss.com) | Copyright (c) Tailwind Labs, Inc.  | Generated utility CSS in `dist/app.css` |

Each of the works above is distributed under the MIT License:

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

## Amp

| Work                                                         | Copyright          | Where it is used                                                                                                                                     |
| ------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@ampcode/sdk`](https://www.npmjs.com/package/@ampcode/sdk) | © Sourcegraph Inc. | The Amp execution layer of `dist/host.js`                                                                                                            |
| Amp logo mark                                                | © Sourcegraph Inc. | `assets/icon.svg`, `assets/logo.svg`, `assets/logo-dark.svg`, and `dist/app.js` |

The following is reproduced from the licence file distributed with
`@ampcode/sdk`:

> © Sourcegraph Inc. All rights reserved. Use of Amp is subject to Amp's
> [Terms of Service](https://ampcode.com/terms), or separate Amp terms that you
> have signed with Sourcegraph Inc.

"Amp" and the Amp logo are marks of Sourcegraph Inc. This plugin is not
affiliated with or endorsed by Sourcegraph Inc.
