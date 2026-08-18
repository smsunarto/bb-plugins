# Simplicity outranks the inherited safety estate

bb-kit 0.1 accumulated heavy correctness machinery: compatibility transactions,
declaration hashes, build provenance, a fixed `verify` tool sequence
(`docs/bb-kit-design-principles.md`). Decided 2026-08-17: in the clean rewrite,
simplicity wins. No safety mechanism is carried over by default; each must
re-earn its place from an observed incident, and the preferred form is a design
that makes the invalid state unrepresentable, not a checker command that a user
must remember to run. The design-principles document is demoted from active
guidance to historical evidence.
