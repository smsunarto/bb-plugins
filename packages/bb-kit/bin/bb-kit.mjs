#!/usr/bin/env node
// The bin target has to be a tracked file, not the tsc output.
//
// Bun links a workspace bin only when the target exists at install time,
// and `dist/` is generated and git-ignored — pointing `bin` straight at
// `dist/bin.js` leaves `node_modules/.bin/bb-kit` unlinked on a clean
// checkout, because Bun links bins during install only. This file is
// committed, so the link always exists; it resolves `dist/bin.js` at run
// time, by which point `build` has emitted it.
import "../dist/bin.js";
