#!/usr/bin/env node
// The bin target has to be a tracked file, not the tsc output.
//
// Bun links a workspace bin only when the target exists at install time, and
// `dist/` is generated and git-ignored. Pointing `bin` straight at
// `dist/cli.js` therefore produced no `node_modules/.bin/bb-kit` on a clean
// checkout: the one `bun install --frozen-lockfile` that CI and the release
// job run saw no file to link, and building the framework afterwards does not
// add the link because Bun links bins during install only. A second install
// created it, which is why `bb-kit build` passed on a developed checkout and
// failed in CI with "bb-kit: command not found".
//
// This file is committed, so the link always exists; it resolves `dist/cli.js`
// at run time, by which point `build:framework` has emitted it.
import "../dist/cli.js";
