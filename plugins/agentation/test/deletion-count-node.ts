import Database from "better-sqlite3";

import { runDeletionCountContract } from "./deletion-count-contract.ts";

process.stdout.write(JSON.stringify(runDeletionCountContract(Database)));
