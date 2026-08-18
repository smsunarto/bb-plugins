# Context Map

## Contexts

- [bb-kit](./packages/bb-kit/CONTEXT.md) — the framework a bb plugin is
  written in

## Relationships

- **bb-kit → plugins**: each plugin under `plugins/` adopts bb-kit's
  language as it migrates (dotfiles first); until then a plugin keeps its
  own local vocabulary.
