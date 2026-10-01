import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { poolToken } from "../src/server/lib/credentials.ts";

test("credential paths accept real account IDs and reject traversal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-bar-secrets-"));
  const accounts = join(dir, "plugins/account-pool/secrets/accounts");
  try {
    await mkdir(join(accounts, "account-.."), { recursive: true });
    const data = JSON.stringify({ kind: "oauth", accessToken: "fixture-token", expiresAt: null });
    await writeFile(join(accounts, "account-valid_id.json"), data);
    await writeFile(join(accounts, "escape.json"), data);
    expect(await poolToken(dir, "valid_id")).toBe("fixture-token");
    expect(await poolToken(dir, "../escape")).toBeNull();
    expect(await poolToken(dir, "valid_id/../../escape")).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
