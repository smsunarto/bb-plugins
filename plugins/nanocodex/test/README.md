# NanoCodex tests

The suite tests the direct JavaScript binding and its native durability boundary.

- `src/host/bridge/entry.conformance.test.ts` runs the SDK lifecycle and grammar suite. It also checks reply-before-notification ordering and exact request settlement.
- `src/host/session.test.ts` checks resume, exact checkpoint fork, fork-promotion recovery, native compact, steer, and interrupt.
- `src/host/storage.test.ts` checks subscription compare-and-swap, file permissions, durability fencing, and fork seeds.
- `src/host/binding.test.ts` checks one embedded module, one subscription handle, device login, and explicit tool wiring.
- `src/host/parallel-web.test.ts` checks the bounded `web__run` adapter and its Parallel SDK requests.
- `artifact-relocation.test.ts` imports only a copied `host.js` under Node 22.
- Colocated bridge, server declaration, and auth tests cover event projection, SDK declaration, and auth parsing.
- The remaining root tests cover cross-runtime artifacts and package-wide boundaries.
