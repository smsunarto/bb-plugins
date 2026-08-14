# bb-kit

Typed operations and frontend server-state helpers for bb plugins.

This package implements the narrow runtime from
[`docs/bb-plugin-framework-spec.md`](../../docs/bb-plugin-framework-spec.md).
It intentionally wraps only application operations, TanStack Query options,
and realtime invalidation. All other plugin capabilities use bb's native SDK.
The [bb-kit design principles](../../docs/bb-kit-design-principles.md) define
the test for adding more framework surface.

```ts
import {
  defineOperation,
  defineOperationCatalog,
  noInput,
  registerOperations,
} from "@bb-kit/core/operations";
import { z } from "zod";

const listApprovals = defineOperation({
  kind: "query",
  input: noInput,
  output: z.array(z.object({ id: z.string() })),
});

const getApproval = defineOperation({
  kind: "query",
  input: z.object({ id: z.string() }),
  exampleInput: { id: "A-1" },
  output: z.object({ id: z.string() }),
});

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

`noInput` is the only no-input schema. Import it directly and do not add an
example. Every other Standard Schema input, including `z.null()`, requires a
finite JSON `exampleInput`.

Use `useOperationRpc(operations)` with `operationQueryOptions` and
`operationMutationOptions`. The RPC hook derives exact methods, inputs, and
outputs from the catalog and keeps bb 0.37's SDK compatibility cast inside
bb-kit. Callers retain native TanStack Query hooks. Realtime helpers validate
ephemeral signals and only invalidate authoritative queries.
