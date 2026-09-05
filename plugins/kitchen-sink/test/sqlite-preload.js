import { Database } from "bun:sqlite";
import { mock } from "bun:test";

class TestDatabase extends Database {
  #open = true;

  get open() {
    return this.#open;
  }

  pragma(source) {
    return this.query(`PRAGMA ${source}`).all();
  }

  prepare(...args) {
    const statement = super.prepare(...args);
    const get = statement.get.bind(statement);
    statement.get = (...bindings) => get(...bindings) ?? undefined;
    return statement;
  }

  close() {
    super.close();
    this.#open = false;
  }
}

mock.module("better-sqlite3", () => ({ default: TestDatabase }));
