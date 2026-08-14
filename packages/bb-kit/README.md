# bb-kit

Typed operations and frontend server-state helpers for bb plugins.

This package implements the narrow runtime from
[`docs/bb-plugin-framework-spec.md`](../../docs/bb-plugin-framework-spec.md).
It intentionally wraps only application operations, TanStack Query options,
and realtime invalidation. All other plugin capabilities use bb's native SDK.

```ts
const operations = defineOperationCatalog({
  get: {
    identity: "approvals.get",
    wireMethod: "approvals_get",
    operation: getApproval,
  },
});

registerOperations(bb, operations, {
  get: approvalService.get,
});
```

Use `operationQueryOptions` and `operationMutationOptions` with native TanStack
Query hooks. Realtime helpers validate ephemeral signals and only invalidate
authoritative queries.
