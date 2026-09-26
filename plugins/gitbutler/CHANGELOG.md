# Changelog

## [0.2.0](https://github.com/smsunarto/bb-plugins/compare/gitbutler/v0.1.0...gitbutler/v0.2.0) (2026-09-26)


### Features

* **bb-kit:** enable plugin telemetry by default with settings opt-out ([abd398b](https://github.com/smsunarto/bb-plugins/commit/abd398b361a19044b486bfec212bb9020f6dbaba))
* **bb-kit:** support core and plugin dev workflows ([3e2ac94](https://github.com/smsunarto/bb-plugins/commit/3e2ac94a0408d6256f3ccc1e97c3f87858c25299))
* **gitbutler:** add a GitButler workspace panel ([748ca8f](https://github.com/smsunarto/bb-plugins/commit/748ca8f55c2ac40a0e910431ddbb1e183f8e2679))
* **gitbutler:** add workflow panel ([c768d2a](https://github.com/smsunarto/bb-plugins/commit/c768d2ae1ffb9616ed2397cd4f25bfb6cf561964))
* **gitbutler:** render diffs with Pierre and rebuild the panel on shadcn ([5fbcd77](https://github.com/smsunarto/bb-plugins/commit/5fbcd77cc0a399dfe80660d57a2eb5a3a647d8df))
* **gitbutler:** show a commit as collapsible per-file diff cards ([e198be2](https://github.com/smsunarto/bb-plugins/commit/e198be2489bef7c2d6cf41c80b974482dbf971bd))
* **plugins:** wire Sentry telemetry into gitbutler, nanocodex, notify ([fbc94a8](https://github.com/smsunarto/bb-plugins/commit/fbc94a8f99b37e6f4f0c8748506a5e700bc880fc))
* **sentry:** split plugin telemetry projects ([e6ffff9](https://github.com/smsunarto/bb-plugins/commit/e6ffff9495c140bb8334af1ab916405c5ffc492f))


### Bug Fixes

* **gitbutler:** make the panel readable, reachable, and recoverable ([3ec39df](https://github.com/smsunarto/bb-plugins/commit/3ec39dfb24189a59c0f78cb71ffd6f20a8b1d306))
* **gitbutler:** match bb's diff header and drop the commit body ([0d22f42](https://github.com/smsunarto/bb-plugins/commit/0d22f425b77319d3f69c1c6974f54735198a8c1d))
* **gitbutler:** render bb's own diff-file header instead of Pierre's ([33c00da](https://github.com/smsunarto/bb-plugins/commit/33c00da5f3678bfd2ed1b0ce04e7d3a8e582dd86))
* **gitbutler:** require bb 0.43.0 for experimental_Icon ([f2f92ed](https://github.com/smsunarto/bb-plugins/commit/f2f92ed9169af24475ef6427824943dadf7f8819))
* **gitbutler:** reserve the scrollbar gutter so rows stop shifting ([872e49d](https://github.com/smsunarto/bb-plugins/commit/872e49d6f19bd70b94cbc8dbec7d898504a82d47))
* **gitbutler:** support bb 0.41 ([dd2e216](https://github.com/smsunarto/bb-plugins/commit/dd2e216c1eb821fb650cde48f49dfcfd661498ae))


### Performance Improvements

* **gitbutler:** keep query results across panel mounts ([5493b34](https://github.com/smsunarto/bb-plugins/commit/5493b34b1df093894068be7856ca6bd66286b14b))
