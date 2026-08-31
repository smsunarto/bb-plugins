import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { inspectAuthSeed } from "./auth-seed.ts";

test("Codex auth seeding is bounded, account-consistent, and never returned in diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanocodex-auth-"));
  const path = join(root, "auth.json");
  const now = 1_800_000_000_000;
  const accountId = "account-123";
  const accessToken = jwt({
    exp: Math.floor(now / 1_000) + 3_600,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  });
  try {
    await writeFile(
      path,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-secret",
          account_id: accountId,
        },
      }),
      { mode: 0o600 },
    );
    await chmod(path, 0o600);
    const ready = await inspectAuthSeed({ NANOCODEX_AUTH_FILE: path }, now);
    assert.equal(ready.state, "ready");
    if (ready.state === "ready") {
      assert.deepEqual(ready.seed, {
        accessToken,
        refreshToken: "refresh-secret",
        accountId,
        fedramp: false,
      });
    }

    await chmod(path, 0o644);
    const broken = await inspectAuthSeed({ NANOCODEX_AUTH_FILE: path }, now);
    assert.equal(broken.state, "broken");
    assert.doesNotMatch(JSON.stringify(broken), /refresh-secret|account-123/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}
