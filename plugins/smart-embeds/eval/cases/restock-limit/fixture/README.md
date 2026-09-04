# inventory-api

Stock keeping for the warehouse tools. Items live in an in-memory store, every
handler returns `{ status, body }`, and `src/router.ts` maps a method and path
onto the matching handler.

Stock moves through four operations: restock adds units, reserve holds units for
an order, release puts a hold back, and price adjusts the sell price. Each one
writes an audit record so the warehouse can reconcile a count later.
