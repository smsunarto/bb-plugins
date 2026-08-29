# NanoCodex tests

The suite tests the direct JavaScript binding and its native durability boundary.

- `bridge-conformance.test.ts` runs the SDK lifecycle and grammar suite. It also checks reply-before-notification ordering and exact request settlement.
- `session.test.ts` checks resume, exact checkpoint fork, fork-promotion recovery, native compact, steer, and interrupt.
- `storage.test.ts` checks subscription compare-and-swap, file permissions, durability fencing, and fork seeds.
- `binding.test.ts` checks one embedded module, one subscription handle, and device login.
- `artifact-relocation.test.ts` imports only a copied `host.js` under Node 22.
- `bridge-stream.test.ts`, `declaration.test.ts`, `auth.test.ts`, and the static scans cover event projection, SDK declaration, auth parsing, and the absence of a child process.
