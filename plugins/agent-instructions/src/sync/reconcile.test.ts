import { describe, expect, test } from "bun:test";
import { isSafeSyncPath, sha256Bytes, type FileDigest } from "./paths.ts";
import { planSync } from "./reconcile.ts";

const d = (text: string, executable = false): FileDigest => ({
  sha256: sha256Bytes(text),
  executable,
  size: Buffer.byteLength(text, "utf8"),
});

describe("isSafeSyncPath", () => {
  test("accepts valid paths under synced roots and rejects traversal/junk", () => {
    expect(isSafeSyncPath("instructions/shared.md")).toBe(true);
    expect(isSafeSyncPath("rules/rule_1.md")).toBe(true);
    expect(isSafeSyncPath("skills/dev/SKILL.md")).toBe(true);
    expect(isSafeSyncPath("skills/dev/.disabled")).toBe(true);
    expect(isSafeSyncPath("conflicts/dev-mac-20261126-000000/skills/dev/SKILL.md")).toBe(true);

    expect(isSafeSyncPath("other/file.md")).toBe(false);
    expect(isSafeSyncPath("skills")).toBe(false);
    expect(isSafeSyncPath("skills/../etc/passwd")).toBe(false);
    expect(isSafeSyncPath("/skills/dev/SKILL.md")).toBe(false);
    expect(isSafeSyncPath("skills/dev\\SKILL.md")).toBe(false);
    expect(isSafeSyncPath("skills/dev/.DS_Store")).toBe(false);
    expect(isSafeSyncPath("skills/dev/file.swp")).toBe(false);
    expect(isSafeSyncPath("skills/dev/bad\x00name")).toBe(false);
  });
});

describe("planSync (3-way reconciliation)", () => {
  const meta = { hostSlug: "dev-mac", timestamp: "20261126-043000" };

  test("cold start pushes server files, pulls host-only files, and conflicts on divergence", () => {
    const plan = planSync({
      ...meta,
      base: {},
      server: {
        "instructions/shared.md": d("server shared"),
        "skills/a/SKILL.md": d("same"),
        "rules/r1.md": d("server v1"),
      },
      host: {
        "skills/a/SKILL.md": d("same"),
        "rules/r1.md": d("host v1"),
        "skills/b/SKILL.md": d("host only"),
      },
    });
    expect(plan.pushWrites).toEqual([
      { path: "instructions/shared.md", expectedHostSha256: null },
      { path: "rules/r1.md", expectedHostSha256: d("host v1").sha256 },
    ]);
    expect(plan.pullWrites).toEqual(["skills/b/SKILL.md"]);
    expect(plan.conflicts).toEqual([
      {
        path: "rules/r1.md",
        conflictPath: expect.stringMatching(
          /^conflicts\/dev-mac-20261126-043000-[0-9a-f]{6}\/rules\/r1\.md$/,
        ),
        kind: "modify-modify",
      },
    ]);
  });

  test("server-only changes push; host-only changes pull", () => {
    const base = {
      "instructions/a.md": d("v1"),
      "instructions/b.md": d("v1"),
      "instructions/c.md": d("v1"),
      "instructions/d.md": d("v1"),
    };
    const plan = planSync({
      ...meta,
      base,
      server: {
        "instructions/a.md": d("server v2"),
        "instructions/b.md": d("v1"),
        // c deleted on server
        "instructions/d.md": d("v1"),
      },
      host: {
        "instructions/a.md": d("v1"),
        "instructions/b.md": d("host v2"),
        "instructions/c.md": d("v1"),
        // d deleted on host
      },
    });
    expect(plan.pushWrites).toEqual([
      { path: "instructions/a.md", expectedHostSha256: d("v1").sha256 },
    ]);
    expect(plan.pushDeletes).toEqual([
      { path: "instructions/c.md", expectedHostSha256: d("v1").sha256 },
    ]);
    expect(plan.pullWrites).toEqual(["instructions/b.md"]);
    expect(plan.pullDeletes).toEqual(["instructions/d.md"]);
    expect(plan.conflicts).toEqual([]);
  });

  test("handles server-delete vs host-modify and server-modify vs host-delete safely", () => {
    const base = {
      "rules/r1.md": d("v1"),
      "rules/r2.md": d("v1"),
    };
    const plan = planSync({
      ...meta,
      base,
      server: {
        // r1 deleted on server
        "rules/r2.md": d("server v2"),
      },
      host: {
        "rules/r1.md": d("host edited"),
        // r2 deleted on host
      },
    });
    expect(plan.conflicts).toEqual([
      {
        path: "rules/r1.md",
        conflictPath: expect.stringMatching(
          /^conflicts\/dev-mac-20261126-043000-[0-9a-f]{6}\/rules\/r1\.md$/,
        ),
        kind: "server-delete-host-modify",
      },
    ]);
    expect(plan.pushDeletes).toEqual([
      { path: "rules/r1.md", expectedHostSha256: d("host edited").sha256 },
    ]);
    expect(plan.pushWrites).toEqual([{ path: "rules/r2.md", expectedHostSha256: null }]);
    expect(plan.restoredOnHost).toEqual(["rules/r2.md"]);
  });

  test("detects executable bit changes as edits", () => {
    const base = { "skills/s/run.sh": d("#!/bin/sh\n", false) };
    const plan = planSync({
      ...meta,
      base,
      server: base,
      host: { "skills/s/run.sh": d("#!/bin/sh\n", true) },
    });
    expect(plan.pullWrites).toEqual(["skills/s/run.sh"]);
  });
});
