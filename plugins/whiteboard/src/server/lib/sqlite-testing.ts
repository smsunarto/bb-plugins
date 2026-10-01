import BetterSqlite3 from "better-sqlite3";
import { DatabaseSync, installDatabaseOpener } from "./sqlite.ts";

/**
 * Specs only. Importing this module makes every `new DatabaseSync(path)` open
 * its own real better-sqlite3 database at `path`, as `node:sqlite` does.
 * Vendored specs reach it through a `node:sqlite` redirect (vendor map wp1).
 * The plugin never imports it: production borrows bb's handle (`installDatabase`).
 */
installDatabaseOpener((path, options) => new BetterSqlite3(path, options));

export { DatabaseSync };
