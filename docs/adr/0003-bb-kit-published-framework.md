# bb-kit is a published framework that owns the plugin file tree

Decided 2026-08-17: bb-kit is designed for publication — a framework for any
bb plugin author, not a personal toolkit. Consequences of that audience:

- The framework prescribes the plugin file tree; colocation and navigability
  are framework guarantees, not repo conventions.
- All nine workspace plugins migrate to bb-kit eventually. Not now:
  `plugins/dotfiles` is the dogfood; the rest follow after the framework
  proves out.
- Opinionation is not softened for hypothetical external users; publication
  raises the bar on docs and stability, not on configurability.
