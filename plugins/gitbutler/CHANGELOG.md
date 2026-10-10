# Changelog

## [0.2.0](https://github.com/smsunarto/bb-plugins/compare/gitbutler/v0.1.0...gitbutler/v0.2.0) (2026-10-10)


### Features

* **bb-kit:** support core and plugin dev workflows ([3e2ac94](https://github.com/smsunarto/bb-plugins/commit/3e2ac94a0408d6256f3ccc1e97c3f87858c25299))
* **gitbutler:** add a GitButler workspace panel ([748ca8f](https://github.com/smsunarto/bb-plugins/commit/748ca8f55c2ac40a0e910431ddbb1e183f8e2679))
* **gitbutler:** add a View in GitButler header button and open the tab once ([e4984d8](https://github.com/smsunarto/bb-plugins/commit/e4984d8dd6d781339846a4158fa00482cd958554))
* **gitbutler:** add Pull and Delete, and polish the workspace panel ([5449e29](https://github.com/smsunarto/bb-plugins/commit/5449e2948ceb078ee5c8e65d9c602da7f8c40180))
* **gitbutler:** Create PR hands the branch to a subthread ([d9089fc](https://github.com/smsunarto/bb-plugins/commit/d9089fc4dba8763a1d6199d99dba3c5401f0c1d2))
* **gitbutler:** draw the last board at once, prefetch diffs, scope post-write refresh ([f16663a](https://github.com/smsunarto/bb-plugins/commit/f16663a1e61f3ff6f14f83fbad77f9835d00d440))
* **gitbutler:** draw the workspace as GitButler desktop's stack lane ([cd3badc](https://github.com/smsunarto/bb-plugins/commit/cd3badc896c57e5abecc5f956551dcff24cfca6e))
* **gitbutler:** hand workspace conflicts to a resolver subthread ([6fac33e](https://github.com/smsunarto/bb-plugins/commit/6fac33ed8961df1d71130dcf256bc356067770d6))
* **gitbutler:** land pulls a branch behind the target first ([b73eec3](https://github.com/smsunarto/bb-plugins/commit/b73eec325b69a791f938a6711a552be92090c2f4))
* **gitbutler:** land squashes the branch into one commit ([0aa5892](https://github.com/smsunarto/bb-plugins/commit/0aa5892207a085a7f26eda4206b30375b6f88cb5))
* **gitbutler:** list the most recently committed stack first ([83b0388](https://github.com/smsunarto/bb-plugins/commit/83b038867ccb5eb228367a0f12d46b420542fdbd))
* **gitbutler:** make changed-file lists work like GitButler desktop ([643cf80](https://github.com/smsunarto/bb-plugins/commit/643cf808cb7dacfda57ac571c940e8a0a92cffca))
* **gitbutler:** polish the board, keep it cached, and close workflow gaps ([3c67f4e](https://github.com/smsunarto/bb-plugins/commit/3c67f4e184c8672fdba6f07735e73acece12b04d))
* **gitbutler:** push, create PRs, land, and rename from branch cards ([956ffff](https://github.com/smsunarto/bb-plugins/commit/956ffffc3cdb476962ab95455992ba16ffa57fc4))
* **gitbutler:** render diffs with Pierre and rebuild the panel on shadcn ([5fbcd77](https://github.com/smsunarto/bb-plugins/commit/5fbcd77cc0a399dfe80660d57a2eb5a3a647d8df))
* **gitbutler:** show a commit as collapsible per-file diff cards ([e198be2](https://github.com/smsunarto/bb-plugins/commit/e198be2489bef7c2d6cf41c80b974482dbf971bd))
* **gitbutler:** show branch status as a chip beside the name ([c1e720f](https://github.com/smsunarto/bb-plugins/commit/c1e720fbca2627dd4bf3d9f4cc75459b9a2c1a46))
* **gitbutler:** show the repository's branches on every machine ([f7fdf14](https://github.com/smsunarto/bb-plugins/commit/f7fdf149be394f96be09ab7b71e827bbe459121f))


### Bug Fixes

* **gitbutler:** make the panel readable, reachable, and recoverable ([3ec39df](https://github.com/smsunarto/bb-plugins/commit/3ec39dfb24189a59c0f78cb71ffd6f20a8b1d306))
* **gitbutler:** match bb's diff header and drop the commit body ([0d22f42](https://github.com/smsunarto/bb-plugins/commit/0d22f425b77319d3f69c1c6974f54735198a8c1d))
* **gitbutler:** name the machine when its host is offline ([51faf3d](https://github.com/smsunarto/bb-plugins/commit/51faf3dd6b2d45361de410973fc4e1c207b1c253))
* **gitbutler:** render bb's own diff-file header instead of Pierre's ([33c00da](https://github.com/smsunarto/bb-plugins/commit/33c00da5f3678bfd2ed1b0ce04e7d3a8e582dd86))
* **gitbutler:** require bb 0.43.0 for experimental_Icon ([f2f92ed](https://github.com/smsunarto/bb-plugins/commit/f2f92ed9169af24475ef6427824943dadf7f8819))
* **gitbutler:** reserve the scrollbar gutter so rows stop shifting ([872e49d](https://github.com/smsunarto/bb-plugins/commit/872e49d6f19bd70b94cbc8dbec7d898504a82d47))
* **plugins:** finish the bb-kit migration ([9f1f691](https://github.com/smsunarto/bb-plugins/commit/9f1f69137627fc52bd427af377a0c26e479e1d9f))


### Performance Improvements

* **gitbutler:** keep query results across panel mounts ([5493b34](https://github.com/smsunarto/bb-plugins/commit/5493b34b1df093894068be7856ca6bd66286b14b))
