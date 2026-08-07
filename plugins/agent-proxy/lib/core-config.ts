import { Document, parseDocument } from "yaml";
import { readTextOr, writeAtomic } from "./fsx.ts";

export interface InitialConfig {
  port: number;
  managementKey: string;
  localApiKey: string;
  authDir: string;
}

/** First-run config.yaml. After this the file is co-owned: the core bcrypt-
    hashes secret-key in place at startup, and management-API writes persist
    provider credentials into it — so the plugin never regenerates the file,
    only surgically updates keys via updateConfigFile while the core is
    stopped. */
export function renderInitialConfig(options: InitialConfig): string {
  const doc = new Document({
    host: "127.0.0.1",
    port: options.port,
    "remote-management": {
      "allow-remote": false,
      "secret-key": options.managementKey,
    },
    "auth-dir": options.authDir,
    "api-keys": [options.localApiKey],
    "usage-statistics-enabled": true,
  });
  doc.commentBefore =
    " Managed by bb-plugin-agent-proxy.\n" +
    " The core rewrites secret-key to a bcrypt hash on startup; the plugin\n" +
    " keeps the plaintext in its own secret store. Provider credentials added\n" +
    " through the management API are persisted here by the core itself.";
  return doc.toString();
}

/** Surgical read-modify-write that preserves the core's own edits (hashed
    secret-key, provider blocks) and comments. Callers must hold the core
    stopped for keys the core reads only at startup. */
export function updateConfigFile(path: string, mutate: (doc: Document) => void): void {
  const raw = readTextOr(path);
  if (raw === null) throw new Error(`config file missing: ${path}`);
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new Error(`config file is not valid YAML: ${doc.errors[0]!.message}`);
  }
  mutate(doc);
  writeAtomic(path, doc.toString());
}

export function setConfigPort(path: string, port: number): void {
  updateConfigFile(path, (doc) => doc.set("port", port));
}

/** Rotating the key writes fresh plaintext; the core re-hashes on next start.
    Never compare the file's value — it is expected to be a bcrypt hash. */
export function setConfigManagementKey(path: string, key: string): void {
  updateConfigFile(path, (doc) => doc.setIn(["remote-management", "secret-key"], key));
}

export function readConfigPort(path: string): number | null {
  const raw = readTextOr(path);
  if (raw === null) return null;
  const port = parseDocument(raw).get("port");
  return typeof port === "number" ? port : null;
}
