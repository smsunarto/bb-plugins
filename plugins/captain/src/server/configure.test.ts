import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { budget } from "./configure.ts";
import { captainHost, newCaptain, type CaptainHost } from "./test-host.ts";

const MAX = 32_768;
const MARKER = "[… truncated; read the file in the Drive]";

type Overrides = Parameters<typeof makePluginAgentConfigurationContext>[0];

function resolve(host: CaptainHost, overrides: Overrides) {
  return host.harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext(overrides),
  );
}

function driveFile(host: CaptainHost, captainId: string, path: string, text: string) {
  const file = join(host.storageRoot, captainId, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

async function withCaptain() {
  const host = await captainHost();
  const captainId = await newCaptain(host);
  return { host, captainId };
}

const crewOf = (captainId: string, id = "thr_crew", projectId = "proj_plugins"): Overrides => ({
  thread: { id, parentThreadId: captainId },
  project: { id: projectId },
});

describe("configure", () => {
  test("a Captain gets the Captain rules, its CAPTAIN.md, its Drive skills, and the Captain skills", async () => {
    const { host, captainId } = await withCaptain();
    driveFile(host, captainId, "CAPTAIN.md", "Always answer in British English.");
    driveFile(host, captainId, "skills/release/SKILL.md", "# Release");

    const resolved = await resolve(host, {
      thread: { id: captainId },
      pluginMetadata: { captain: { name: "Plugins" } },
    });

    expect(resolved.skills.sort()).toEqual([
      "captain-brief",
      "captain-review-loop",
      "captain-routines",
      "captain-ship",
    ]);
    expect(resolved.instructions).toContain('You are the "Plugins" Captain');
    expect(resolved.instructions).toContain(join(host.storageRoot, captainId));
    expect(resolved.instructions).toContain("Always answer in British English.");
    expect(resolved.instructions).toContain("- skills/release/SKILL.md");
    expect(resolved.instructions).not.toContain("You are crew");
  });

  test("a Captain's direct edit to CAPTAIN.md reaches its next session", async () => {
    const { host, captainId } = await withCaptain();
    const captain = { thread: { id: captainId }, pluginMetadata: { captain: { name: "Plugins" } } };
    driveFile(host, captainId, "CAPTAIN.md", "Rule one.");
    expect((await resolve(host, captain)).instructions).toContain("Rule one.");

    driveFile(host, captainId, "CAPTAIN.md", "Rule two.");
    const next = (await resolve(host, captain)).instructions;
    expect(next).toContain("Rule two.");
    expect(next).not.toContain("Rule one.");
  });

  test("crew with one pending role gets the crew rules, that role's contract and CREW.md", async () => {
    const { host, captainId } = await withCaptain();
    driveFile(host, captainId, "CREW.md", "Run bun test before every report.");
    host.server.registry.setPending(captainId, "BBPLUGINS-1", "implement");

    const resolved = await resolve(host, crewOf(captainId));

    expect(resolved.instructions).toContain('You are crew for the "Plugins" Captain');
    expect(resolved.instructions).toContain("# Role: Implement");
    expect(resolved.instructions).toContain("Run bun test before every report.");
    expect(resolved.instructions).not.toContain("You are the");
    expect(resolved.skills).toEqual([]);
  });

  test("crew gets no role contract while pending roles disagree", async () => {
    const { host, captainId } = await withCaptain();
    host.server.registry.setPending(captainId, "BBPLUGINS-1", "implement");
    host.server.registry.setPending(captainId, "BBPLUGINS-2", "review");

    const resolved = await resolve(host, crewOf(captainId));

    expect(resolved.instructions).toContain('You are crew for the "Plugins" Captain');
    expect(resolved.instructions).not.toContain("# Role:");
    expect(resolved.skills).toEqual([]);
  });

  test("a Review thread gets the review contract and the lenses skill", async () => {
    const { host, captainId } = await withCaptain();
    host.server.store.putCrewRole({
      threadId: "thr_review",
      captainId,
      role: "review",
      reportDueSince: null,
      contractSent: true,
    });

    const resolved = await resolve(host, crewOf(captainId, "thr_review"));

    expect(resolved.skills).toEqual(["captain-review-lenses"]);
    expect(resolved.instructions).toContain("# Role: Review");
  });

  test("a Merge thread's metadata role wins over any other role record", async () => {
    const { host, captainId } = await withCaptain();
    driveFile(host, captainId, "CREW.md", "Never force-push.");
    host.server.store.putCrewRole({
      threadId: "thr_merge",
      captainId,
      role: "review",
      reportDueSince: null,
      contractSent: true,
    });

    const resolved = await resolve(host, {
      ...crewOf(captainId, "thr_merge"),
      pluginMetadata: { role: "merge" },
    });

    expect(resolved.instructions).toContain('You are crew for the "Plugins" Captain');
    expect(resolved.instructions).toContain("Never force-push.");
    expect(resolved.instructions).not.toContain("# Role: Review");
    expect(resolved.skills).toEqual([]);
  });

  test("a thread that is neither a Captain nor crew gets nothing", async () => {
    const { host } = await withCaptain();
    host.addThread({ id: "thr_parent" });

    for (const thread of [
      { id: "thr_plain", parentThreadId: null },
      { id: "thr_child", parentThreadId: "thr_parent" },
    ]) {
      const resolved = await resolve(host, { thread, pluginMetadata: { role: "implement" } });
      expect(resolved).toMatchObject({ instructions: null, skills: [] });
    }
  });

  test("metadata that is not a Captain name is ignored", async () => {
    const { host } = await withCaptain();
    for (const captain of ["Plugins", { name: "" }, { name: 7 }, ["Plugins"]]) {
      const resolved = await resolve(host, {
        thread: { id: "thr_x" },
        pluginMetadata: { captain },
      });
      expect(resolved.instructions).toBeNull();
    }
  });

  test("repos/<KEY>.md reaches only crew in that repo", async () => {
    const { host, captainId } = await withCaptain();
    driveFile(host, captainId, "repos/BBPLUGINS.md", "Lint with bun scripts/lint.ts.");

    const inRepo = await resolve(host, crewOf(captainId, "thr_a", "proj_plugins"));
    const elsewhere = await resolve(host, crewOf(captainId, "thr_b", "proj_other"));

    expect(inRepo.instructions).toContain("Lint with bun scripts/lint.ts.");
    expect(elsewhere.instructions).not.toContain("Lint with bun scripts/lint.ts.");
  });

  test("a Captain whose Drive files are missing still gets its rules", async () => {
    const { host, captainId } = await withCaptain();
    rmSync(join(host.storageRoot, captainId), { recursive: true, force: true });

    const resolved = await resolve(host, {
      thread: { id: captainId },
      pluginMetadata: { captain: { name: "Plugins" } },
    });
    const crew = await resolve(host, crewOf(captainId));

    expect(resolved.instructions).toContain('You are the "Plugins" Captain');
    expect(resolved.instructions).not.toContain("## CAPTAIN.md");
    expect(crew.instructions).toContain('You are crew for the "Plugins" Captain');
  });

  test("an oversized CREW.md is cut at the budget, never the role contract", async () => {
    const { host, captainId } = await withCaptain();
    host.server.registry.setPending(captainId, "BBPLUGINS-1", "review");
    driveFile(host, captainId, "CREW.md", `Start of crew rules.\n${"x".repeat(60_000)}`);
    driveFile(host, captainId, "repos/BBPLUGINS.md", "Repo rule that no longer fits.");

    const text = (await resolve(host, crewOf(captainId))).instructions ?? "";

    expect(text.length).toBeLessThanOrEqual(MAX);
    expect(text.length).toBeGreaterThan(MAX - 100);
    expect(text).toContain("# Role: Review");
    expect(text).toContain("Report `Final: 0 findings` when the change is clean");
    expect(text).toContain("Start of crew rules.");
    expect(text.endsWith(MARKER)).toBe(true);
    expect(text).not.toContain("Repo rule that no longer fits.");
  });
});

describe("budget", () => {
  test("keeps every fixed part, then fits sections in order and marks the cut", () => {
    const out = budget(
      ["RULES", "CONTRACT"],
      [
        { heading: "A.md", body: "a".repeat(30) },
        { heading: "B.md", body: "b".repeat(30) },
      ],
      "[cut]",
      60,
    );

    expect(out).toHaveLength(60);
    expect(out.startsWith("RULES\n\nCONTRACT\n\n## A.md\n\naaa")).toBe(true);
    expect(out.endsWith("\n\n[cut]")).toBe(true);
    expect(out).not.toContain("B.md");
  });

  test("returns everything unmarked when it fits", () => {
    expect(budget(["RULES"], [{ heading: "A.md", body: "a" }], "[cut]", 60)).toBe(
      "RULES\n\n## A.md\n\na",
    );
  });

  test("skips missing and empty sections without a marker", () => {
    expect(
      budget(
        ["RULES"],
        [
          { heading: "A.md", body: null },
          { heading: "B.md", body: "  " },
        ],
        "[cut]",
      ),
    ).toBe("RULES");
  });
});
