# Installed Plugin Mentions

Type `#` and a plugin name, ID, or description in the composer. Select a result to attach an installed-plugin reference for your agent. `#plugins` browses every enabled, running plugin.

Only installed plugins are searched. There is no Community lookup, `@` provider, CLI, or installation action. Availability is checked again when sending; removed or disabled plugins produce an actionable error.

Derived from [brsbl/bb-plugins Plugin Finder](https://github.com/brsbl/bb-plugins/tree/main/plugins/at-plugin), upstream version 0.1.3. Retains upstream installed-plugin matching, bounded references, icon selection, and SDK read deadlines. Upstream declares `UNLICENSED`; this local fork preserves that designation.
