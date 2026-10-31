# Changelog

## [0.3.0](https://github.com/smsunarto/bb-plugins/compare/gitbutler/v0.2.0...gitbutler/v0.3.0) (2026-10-31)


### Features

* **branding:** give every plugin a distinct BB-style icon ([e6a07fe](https://github.com/smsunarto/bb-plugins/commit/e6a07fe24cfd954203fc3007c3e9817de4b9376e))
* **gitbutler:** list workspace branches in the thread Info panel ([45dbc78](https://github.com/smsunarto/bb-plugins/commit/45dbc7881700d067308224d62d7e93d23faee3d3))
* **gitbutler:** read branch files and Git LFS objects by range ([9681dec](https://github.com/smsunarto/bb-plugins/commit/9681decf9cfdfc7e3853243c9a7be62d9f41f3a1))
* **plugins:** adopt BB 0.48 SDK APIs ([7fcbe74](https://github.com/smsunarto/bb-plugins/commit/7fcbe74366553e460c2992080af34533c7642649))
* **plugins:** replace plugin icons with Lucide via better-icons ([765f389](https://github.com/smsunarto/bb-plugins/commit/765f38988bcf8107889ec51890377f85c00dcdf3))
* **storybook:** catalog custom components across browser plugins ([1345a92](https://github.com/smsunarto/bb-plugins/commit/1345a926b6b281ae7ab0c6d7fcc6f1807130d77b))
* **storybook:** populate realistic review and workflow scenarios ([b58f4e7](https://github.com/smsunarto/bb-plugins/commit/b58f4e7b9865f3997da18c886de76aac7652db20))


### Bug Fixes

* **code-review:** share from the calling checkout by default ([7fdcae3](https://github.com/smsunarto/bb-plugins/commit/7fdcae39d93331ee84c1744acee2ff5ccb250516))
* **gtd-sidebar,gitbutler:** resolve core from the local workspace ([e89b7cc](https://github.com/smsunarto/bb-plugins/commit/e89b7ccbb3ba90c11b1e1e99fe9b8f9e6b7e6a4f))
* **machines:** use neutral Boat icons and stable ID colors ([29ca753](https://github.com/smsunarto/bb-plugins/commit/29ca7537feaf11e984be20a96a868be218be98c1))
* **storybook:** size component previews to content ([471d888](https://github.com/smsunarto/bb-plugins/commit/471d888914696829ee59ff1a84701fe2354fef90))


### Performance Improvements

* **code-review:** load branch cards from their checkout ([413b563](https://github.com/smsunarto/bb-plugins/commit/413b563d3fc5bc8814698d9c196c2f89f2ca1f4d))

## [0.2.0](https://github.com/smsunarto/bb-plugins/compare/gitbutler/v0.1.0...gitbutler/v0.2.0) (2026-10-21)


### Features

* **gitbutler:** add a GitButler workspace panel ([748ca8f](https://github.com/smsunarto/bb-plugins/commit/748ca8f55c2ac40a0e910431ddbb1e183f8e2679))
* **gitbutler:** add a View in GitButler header button and open the tab once ([e4984d8](https://github.com/smsunarto/bb-plugins/commit/e4984d8dd6d781339846a4158fa00482cd958554))
* **gitbutler:** add Pull and Delete, and polish the workspace panel ([5449e29](https://github.com/smsunarto/bb-plugins/commit/5449e2948ceb078ee5c8e65d9c602da7f8c40180))
* **gitbutler:** Create PR hands the branch to a subthread ([d9089fc](https://github.com/smsunarto/bb-plugins/commit/d9089fc4dba8763a1d6199d99dba3c5401f0c1d2))
* **gitbutler:** draw the last board at once, prefetch diffs, scope post-write refresh ([f16663a](https://github.com/smsunarto/bb-plugins/commit/f16663a1e61f3ff6f14f83fbad77f9835d00d440))
* **gitbutler:** draw the workspace as GitButler desktop's stack lane ([cd3badc](https://github.com/smsunarto/bb-plugins/commit/cd3badc896c57e5abecc5f956551dcff24cfca6e))
* **gitbutler:** expose unpublished branches and their diffs to other plugins ([c95bd6d](https://github.com/smsunarto/bb-plugins/commit/c95bd6d43bbc816ab3c9e0d0537a8cf55dcf44df))
* **gitbutler:** hand workspace conflicts to a resolver subthread ([6fac33e](https://github.com/smsunarto/bb-plugins/commit/6fac33ed8961df1d71130dcf256bc356067770d6))
* **gitbutler:** land pulls a branch behind the target first ([b73eec3](https://github.com/smsunarto/bb-plugins/commit/b73eec325b69a791f938a6711a552be92090c2f4))
* **gitbutler:** land squashes the branch into one commit ([0aa5892](https://github.com/smsunarto/bb-plugins/commit/0aa5892207a085a7f26eda4206b30375b6f88cb5))
* **gitbutler:** list the most recently committed stack first ([83b0388](https://github.com/smsunarto/bb-plugins/commit/83b038867ccb5eb228367a0f12d46b420542fdbd))
* **gitbutler:** make changed-file lists work like GitButler desktop ([643cf80](https://github.com/smsunarto/bb-plugins/commit/643cf808cb7dacfda57ac571c940e8a0a92cffca))
* **gitbutler:** operate on isolated checkouts ([45b0f3a](https://github.com/smsunarto/bb-plugins/commit/45b0f3aa245afbec3804bf260906941b5aea8eb8))
* **gitbutler:** polish the board, keep it cached, and close workflow gaps ([3c67f4e](https://github.com/smsunarto/bb-plugins/commit/3c67f4e184c8672fdba6f07735e73acece12b04d))
* **gitbutler:** push, create PRs, land, and rename from branch cards ([956ffff](https://github.com/smsunarto/bb-plugins/commit/956ffffc3cdb476962ab95455992ba16ffa57fc4))
* **gitbutler:** render diffs with Pierre and rebuild the panel on shadcn ([5fbcd77](https://github.com/smsunarto/bb-plugins/commit/5fbcd77cc0a399dfe80660d57a2eb5a3a647d8df))
* **gitbutler:** show a commit as collapsible per-file diff cards ([e198be2](https://github.com/smsunarto/bb-plugins/commit/e198be2489bef7c2d6cf41c80b974482dbf971bd))
* **gitbutler:** show branch status as a chip beside the name ([c1e720f](https://github.com/smsunarto/bb-plugins/commit/c1e720fbca2627dd4bf3d9f4cc75459b9a2c1a46))
* **gitbutler:** show branches from isolated checkouts ([1fad9ea](https://github.com/smsunarto/bb-plugins/commit/1fad9eab0d38b7b0d47a5ec6a63b0c71ba9d047a))
* **gitbutler:** show the repository's branches on every machine ([f7fdf14](https://github.com/smsunarto/bb-plugins/commit/f7fdf149be394f96be09ab7b71e827bbe459121f))
* **gitbutler:** start chats in the selected checkout ([77e6ad9](https://github.com/smsunarto/bb-plugins/commit/77e6ad9a54edb0e97801ce6cc516aaef42a4db58))


### Bug Fixes

* **gitbutler:** make the panel readable, reachable, and recoverable ([3ec39df](https://github.com/smsunarto/bb-plugins/commit/3ec39dfb24189a59c0f78cb71ffd6f20a8b1d306))
* **gitbutler:** match bb's diff header and drop the commit body ([0d22f42](https://github.com/smsunarto/bb-plugins/commit/0d22f425b77319d3f69c1c6974f54735198a8c1d))
* **gitbutler:** name the machine when its host is offline ([51faf3d](https://github.com/smsunarto/bb-plugins/commit/51faf3dd6b2d45361de410973fc4e1c207b1c253))
* **gitbutler:** render bb's own diff-file header instead of Pierre's ([33c00da](https://github.com/smsunarto/bb-plugins/commit/33c00da5f3678bfd2ed1b0ce04e7d3a8e582dd86))
* **gitbutler:** require bb 0.43.0 for experimental_Icon ([f2f92ed](https://github.com/smsunarto/bb-plugins/commit/f2f92ed9169af24475ef6427824943dadf7f8819))
* **gitbutler:** reserve the scrollbar gutter so rows stop shifting ([872e49d](https://github.com/smsunarto/bb-plugins/commit/872e49d6f19bd70b94cbc8dbec7d898504a82d47))
* **gitbutler:** scope diff navigation and cache to workspace ([1aeb6c5](https://github.com/smsunarto/bb-plugins/commit/1aeb6c556cfb47cd582538806c0bf14f3b213b7f))
* **gitbutler:** serialize PR subthread requests ([95635da](https://github.com/smsunarto/bb-plugins/commit/95635da3edb1f62a67b43a1ea560116e2e9b8102))
* **gitbutler:** show clipboard failures and allow retry ([e426164](https://github.com/smsunarto/bb-plugins/commit/e4261647eb5c033f145f1a774494740b3aa59245))
* **gitbutler:** use published core APIs and declare Radix runtime dependency ([d7b5330](https://github.com/smsunarto/bb-plugins/commit/d7b5330560f49703616261d40f15421fc7276bab))
* **gtd-sidebar,gitbutler:** give every machine its own globe color ([3d93d16](https://github.com/smsunarto/bb-plugins/commit/3d93d16201d1ad0fb265419f430ae7968edfd3d2))
* **plugins:** finish the bb-kit migration ([9f1f691](https://github.com/smsunarto/bb-plugins/commit/9f1f69137627fc52bd427af377a0c26e479e1d9f))
* **scott-engineering:** stop Arena rewrites repeating card labels ([69a5eb8](https://github.com/smsunarto/bb-plugins/commit/69a5eb8eaafc43c3d44c61e05bcc24ea6c6d2776))


### Performance Improvements

* **gitbutler:** keep query results across panel mounts ([5493b34](https://github.com/smsunarto/bb-plugins/commit/5493b34b1df093894068be7856ca6bd66286b14b))
* **gitbutler:** push board changes from a host .git watch, memoize host reads ([a7a3d46](https://github.com/smsunarto/bb-plugins/commit/a7a3d468a57ddc80ea54c78571d30eb69d1caf23))
* **gitbutler:** virtualize commit diffs and stop re-rendering cards per keypress ([ffe2703](https://github.com/smsunarto/bb-plugins/commit/ffe2703970f7ea2b30b98a70389bd43dd2853e07))
