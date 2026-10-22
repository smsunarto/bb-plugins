# Refactoring

A behavior-preserving change to structure: the structure changes and the behavior does not. A cleanup that turns up a missing feature or a real bug usually goes better split out, with the structural change shipped first against the pinned behavior. A redesign is fine too, but name it and treat it as a [Feature](feature.md).

What tends to work:

1. Pin the current behavior before moving anything: a characterization test, a snapshot, or an equivalence harness. Type checks and lint are not a pin.
2. Name the structure the code is missing (`model-the-domain`). Boring code can stay when its shape is already clear and local. A good reshape deletes branches or invalid states rather than adding indirection.
3. Name the target shape: the module layout, types, and call graph you would build today (`foundational-thinking`, `redesign-from-first-principles`).
4. Subtract first. Delete dead code, collapse one-caller wrappers, and drop redundant validators before introducing the new shape (`subtract-before-you-add`, `grug-brain`).
5. Move in small steps that keep the pin green. For an API reshape, migrate every caller and delete the old API in the same wave, with no compatibility shims (`migrate-callers-then-delete-legacy-apis`). Check renames against the actual files, since they miss usages in strings, prose, and back-references.
6. Prove the behavior is unchanged on the real artifact (`prove-it-works`). For larger reshapes, diff old and new outputs, replay a recorded baseline, or smoke-test the matching surface.
7. Check that the change earns its place: it should lower reader load somewhere (`minimize-reader-load`). If it doesn't, revert it.
8. Order the commits as subtraction, then reshape, then follow-on cleanup, each green on its own (`sequence-verifiable-units`).

A good reply covers the structure that changed, the pin you held it to, the equivalence proof, the reader-load change, and what you reverted.
