# config-schema

The service config surface in one place. `src/fields.ts` holds the field table,
and `src/config.ts` exposes the `Config` type plus `validateConfig`, which
checks incoming config against that same table.

`generated/schema.json` is built, not written by hand: `bun run gen` reads the field table
and rewrites it. Run that after every change to the table and commit the result,
so editor completion and the deploy check stay in step with the validator.
