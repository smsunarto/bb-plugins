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
  writeAtomic(path, doc.toString(), 0o600);
}

export function setConfigPort(path: string, port: number): void {
  updateConfigFile(path, (doc) => doc.set("port", port));
}

/** Rotating the key writes fresh plaintext; the core re-hashes on next start.
    Never compare the file's value — it is expected to be a bcrypt hash. */
export function setConfigManagementKey(path: string, key: string): void {
  updateConfigFile(path, (doc) => doc.setIn(["remote-management", "secret-key"], key));
}

/** Reassert every field owned by the plugin while preserving provider blocks
    and other core-managed configuration. The local API key is mandatory but
    additional proxy access keys remain user-managed. */
export function reconcileConfigFile(path: string, options: InitialConfig): void {
  updateConfigFile(path, (doc) => {
    const value = doc.toJS() as Record<string, unknown>;
    const existingKeys = Array.isArray(value["api-keys"])
      ? value["api-keys"].filter((entry): entry is string => typeof entry === "string")
      : [];
    const apiKeys = existingKeys.includes(options.localApiKey)
      ? existingKeys
      : [options.localApiKey, ...existingKeys];

    doc.set("host", "127.0.0.1");
    doc.set("port", options.port);
    doc.setIn(["remote-management", "allow-remote"], false);
    // The core hashes this plaintext value at startup. Reasserting it on load
    // keeps settings changed while the plugin was disabled in sync.
    doc.setIn(["remote-management", "secret-key"], options.managementKey);
    doc.set("auth-dir", options.authDir);
    doc.set("api-keys", apiKeys);
    doc.set("usage-statistics-enabled", true);
  });
}

export function readConfigPort(path: string): number | null {
  const raw = readTextOr(path);
  if (raw === null) return null;
  const port = parseDocument(raw).get("port");
  return typeof port === "number" ? port : null;
}
