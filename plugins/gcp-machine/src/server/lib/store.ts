import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { resourceSchema, type Resource } from "../../shared/schema.ts";

const bindingSchema = z.object({ resource: resourceSchema, hostId: z.string().nullable() });
export class Store {
  private readonly db;
  constructor(bb: BbPluginApi) {
    this.db = bb.storage.database();
    bb.storage.migrate(this.db, [
      "CREATE TABLE binding (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL)",
      "CREATE TABLE activity (host_id TEXT PRIMARY KEY, at INTEGER NOT NULL)",
      "CREATE TABLE power_request (key TEXT PRIMARY KEY, action TEXT NOT NULL, request_id TEXT NOT NULL)",
    ]);
  }
  binding() {
    const row = this.db.prepare("SELECT value FROM binding WHERE id = 1").get() as
      | { value: string }
      | undefined;
    return row ? bindingSchema.parse(JSON.parse(row.value)) : null;
  }
  reserve(resource: Resource) {
    const existing = this.binding();
    if (existing && existing.resource.key !== resource.key)
      throw new Error(
        "This VM already has a GCP machine registration. Use that machine instead of adding another.",
      );
    if (!existing)
      this.db
        .prepare("INSERT INTO binding (id, value) VALUES (1, ?)")
        .run(JSON.stringify({ resource, hostId: null }));
    return existing?.resource ?? resource;
  }
  attach(key: string, hostId: string) {
    const binding = this.binding();
    if (!binding || binding.resource.key !== key)
      throw new Error("The GCP enrollment was cancelled.");
    this.db
      .prepare("UPDATE binding SET value = ? WHERE id = 1")
      .run(JSON.stringify({ ...binding, hostId }));
  }
  release(key: string) {
    const binding = this.binding();
    if (binding?.resource.key !== key) return;
    this.db.prepare("DELETE FROM binding WHERE id = 1").run();
    this.db.prepare("DELETE FROM power_request WHERE key = ?").run(key);
    if (binding.hostId)
      this.db.prepare("DELETE FROM activity WHERE host_id = ?").run(binding.hostId);
  }
  touch(hostId: string, at: number) {
    this.db
      .prepare(
        "INSERT INTO activity (host_id, at) VALUES (?, ?) ON CONFLICT(host_id) DO UPDATE SET at = MAX(at, excluded.at)",
      )
      .run(hostId, at);
  }
  lastActivity(hostId: string): number | null {
    return (
      (
        this.db.prepare("SELECT at FROM activity WHERE host_id = ?").get(hostId) as
          | { at: number }
          | undefined
      )?.at ?? null
    );
  }
  powerRequest(key: string, action: "start" | "stop", newId: string) {
    const row = this.db
      .prepare("SELECT action, request_id FROM power_request WHERE key = ?")
      .get(key) as { action: string; request_id: string } | undefined;
    if (row) {
      if (row.action !== action)
        throw new Error(`An unresolved ${row.action} operation must finish before ${action}.`);
      return row.request_id;
    }
    this.db
      .prepare("INSERT INTO power_request (key, action, request_id) VALUES (?, ?, ?)")
      .run(key, action, newId);
    return newId;
  }
  pendingPower(key: string) {
    return this.db
      .prepare("SELECT action, request_id FROM power_request WHERE key = ?")
      .get(key) as { action: "start" | "stop"; request_id: string } | undefined;
  }
  finishPower(key: string) {
    this.db.prepare("DELETE FROM power_request WHERE key = ?").run(key);
  }
}
