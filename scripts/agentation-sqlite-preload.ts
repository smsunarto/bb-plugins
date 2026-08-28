import { Database } from "bun:sqlite";
import { mock } from "bun:test";

class AgentationTestDatabase extends Database {
  constructor(filename: string) {
    super(filename, { strict: true });
  }
}

mock.module("better-sqlite3", () => ({
  default: AgentationTestDatabase,
}));
