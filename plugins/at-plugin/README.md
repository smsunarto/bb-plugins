# Installed Plugin Mentions

Type `#` and a plugin name, ID, or description in the composer. Select a result to attach an installed-plugin reference for your agent. `#plugins` browses every enabled, running plugin.

Only installed plugins are searched. There is no Community lookup, `@` provider, CLI, or installation action. Availability is checked again when sending; removed or disabled plugins produce an actionable error.

Derived from [brsbl/bb-plugins Plugin Finder](https://github.com/brsbl/bb-plugins/tree/main/plugins/at-plugin), upstream version 0.1.3 (`10f997cf9097b1243c514ac1879cc35e4e80d6be`, 2026-10-01). Last synced with upstream `main` at `3a0401e482a94e3b8a7703101e3f7b92a2f5acdf` on 2026-11-21 (latest `plugins/at-plugin` commit `c754e3cece58ab79fa7f0135392e9b0a34f0b11e`, 2026-10-22; post-0.1.3 upstream commits #525 and #535 only touched a test path string and a docs screenshot absent from this fork). Retains upstream installed-plugin matching, bounded references, icon selection, and SDK read deadlines. Upstream declares `UNLICENSED`; this local fork preserves that designation.
