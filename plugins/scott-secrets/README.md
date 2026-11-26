# Secrets

Fork of bb's built-in Secrets plugin (`get-bb/bb/plugins/secrets`), published as
`@smsunarto/bb-plugin-scott-secrets` with plugin ID `scott-secrets`.

Forked from [`get-bb/bb/plugins/secrets`](https://github.com/get-bb/bb/tree/desktop-v0.49.0/plugins/secrets)
at `desktop-v0.49.0` (`7b26cae79ec978fafd0a5db0e8517e94f12eb8f4`, 2026-11-06;
latest `plugins/secrets` commit in that release was `6d5597d2851d4cef6d2fa22301d828daa6fbf319`,
2026-11-05).

Last synced with upstream `main` at `b0ddaad731565d7e4de68d824120d802fc78f7d5`
on 2026-11-26 (latest `plugins/secrets` commit `bce7015f188b8b150a65abb9c3e9d31cb756f4d1`,
[#7875](https://github.com/get-bb/bb/pull/7875)).

## Local changes

- Keeps `bb secret request` compatible with bb's built-in Secrets plugin.
- Adds `bb secret sudo -- <argv>` to run commands through `/usr/bin/sudo -S`
  on the thread's host, showing an approval form on the first call in a thread
  and caching the password only in host-worker memory for a configurable window
  (`sudoCacheMinutes`, default 15 minutes).
- Adds `bb secret forget-sudo` to drop the cached password for the current thread.

## Upstream changes held for a newer bb / Plugin SDK

Live bb `0.50.1` runs `@get-bb/plugin-sdk` `0.6.157`. These upstream changes
require a newer SDK and are held until live upgrades:

- [#7796](https://github.com/get-bb/bb/pull/7796) (`343b5e83`): its
  `experimental_sliceUtf16Head` SDK import requires `bbPluginSdk >=0.6.161`;
  `clamp()` in `src/server/shared.ts` adapts the surrogate-pair-safe slice locally.
- [#7875](https://github.com/get-bb/bb/pull/7875) (`bce7015f`): migrating to
  `experimental_BbHttpError` and dropping the CLI error wrapper requires
  `bbPluginSdk >=0.6.173` and server-side `--json` failure envelopes.
