import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile, evaluate, initialState } from "./index";
import { chainSummary, evidenceOf, readProvenance, sameValue, shortValue, stageStatus, stageVerb, type Provenance } from "./provenance";
import type { Value } from "./types";

function read(stages: Value, expected?: Value): Provenance {
  const result = readProvenance(stages, expected);
  if (!result.ok) throw new Error(result.error);
  return result.provenance;
}

function gallery(name: string): Value {
  return JSON.parse(readFileSync(new URL(`../gallery/data/provenance/${name}`, import.meta.url), "utf8")) as Value;
}

/** The stages a gallery example writes inline. */
function inlineStages(example: string): Value {
  const { program } = compile(readFileSync(new URL(`../gallery/${example}`, import.meta.url), "utf8"));
  if (program === null) throw new Error(`${example} does not compile`);
  return evaluate(program, initialState(program)).roots[0].props.stages ?? null;
}

const REQUESTED = { branch: "feat/399", device: "Sam's iPhone 15 Pro" };

describe("readProvenance: the iPhone install chain from the gallery", () => {
  const chain = read(gallery("iphone-install.json"), REQUESTED);

  it("says the installed build is not the requested one, and where it went wrong", () => {
    expect(chain.verdict.tone).toBe("bad");
    expect(chain.verdict.title).toBe("Installed build is not the requested one");
    expect(chain.verdict.lines[0]).toEqual({ text: "expected branch feat/399 · installed main (wrong from Checkout on)", tone: "bad" });
  });

  it("flags the branch on every stage that has it, and confirms the device", () => {
    const branch = chain.stages.map((stage) => stage.facts.find((fact) => fact.key === "branch")?.check?.kind ?? null);
    expect(branch).toEqual(["expected", "expected", null, "expected", null]);
    const device = chain.stages[3].facts.find((fact) => fact.key === "device");
    expect(device).toMatchObject({ confirmed: true, check: null });
    expect(chain.expected.map((fact) => [fact.key, fact.confirmed])).toEqual([
      ["branch", false],
      ["device", true],
    ]);
  });

  it("confirms the sha, build and digest across stages", () => {
    const install = chain.stages[3];
    expect(install.facts.filter((fact) => fact.identity).every((fact) => fact.key === "branch" || fact.confirmed)).toBe(true);
    expect(install.facts.find((fact) => fact.key === "sha")?.short).toBe("1a68a02");
  });

  it("sums the durations and reads every stage's receipt", () => {
    expect(chain.stages.map((stage) => stage.receipt)).toEqual(["receipt", "receipt", "receipt", "receipt", "receipt"]);
    expect(chain.totalMs).toBe((2 + 254 + 19 + 96 + 6) * 1000);
    expect(chainSummary(chain)).toBe("5 stages · 6m 17s");
  });
});

describe("readProvenance: a website deploy that matches", () => {
  const chain = read(inlineStages("Provenance-deploy.ui"));

  it("says the deployed revision matches the source", () => {
    expect(chain.verdict).toMatchObject({ tone: "good", title: "Deployed revision matches source", lines: [{ text: "sha 44f1d74 at all 4 stages", tone: "good" }] });
    expect(chain.mismatches).toEqual([]);
  });

  it("does not compare hosts or URLs, which change by design", () => {
    const urls = chain.stages.flatMap((stage) => stage.facts.filter((fact) => fact.key === "url"));
    expect(urls.length).toBeGreaterThan(1);
    expect(urls.every((fact) => fact.check === null && !fact.confirmed)).toBe(true);
  });
});

describe("readProvenance: a chain that stops without an install receipt", () => {
  const chain = read(gallery("iphone-no-receipt.json"), REQUESTED);

  it("says what is unknown after the last receipt", () => {
    expect(chain.verdict.tone).toBe("warn");
    expect(chain.verdict.title).toBe("Unknown after Transfer to dev-laptop: no receipt");
    expect(chain.verdict.lines.map((line) => line.text)).toEqual([
      "device Sam's iPhone 15 Pro not confirmed: only Install on iPhone names it, without a receipt",
      "No receipt: Install on iPhone (timed out) · Launch",
    ]);
  });

  it("marks the last stage with a receipt and the ones after it", () => {
    expect(chain.lastReceipt).toBe(2);
    expect(chain.stages.map((stage) => [stage.last, stage.receipt])).toEqual([
      [false, "receipt"],
      [false, "receipt"],
      [true, "receipt"],
      [false, "none"],
      [false, "none"],
    ]);
    // The install log is shown, but a timeout is no receipt.
    expect(chain.stages[3].evidence.length).toBeGreaterThan(0);
    expect(chainSummary(chain)).toMatch(/^5 stages · 3 with a receipt · /);
  });
});

describe("readProvenance: checks", () => {
  it("flags a sha that changes between stages, with both values", () => {
    const chain = read([
      { name: "Build on build-mini", status: "done", facts: { sha: "1a68a022fefb4c26ded1dbc0a1aa99d06ab79f87", build: "2811" } },
      { name: "Install on iPhone", status: "done", facts: { commit: "d62fbf3", build: 2811 } },
    ]);
    expect(chain.verdict.title).toBe("Installed build doesn't match the source");
    expect(chain.verdict.lines[0].text).toBe("sha changed: built 1a68a02 · installed d62fbf3");
    expect(chain.stages[1].facts.map((fact) => [fact.key, fact.check?.kind ?? null, fact.confirmed])).toEqual([
      ["sha", "changed", false],
      ["build", null, true],
    ]);
  });

  it("names the stage a later change departs from", () => {
    const chain = read([
      { name: "Commit", status: "done", facts: { sha: "1a68a02" } },
      { name: "Build", status: "done", facts: { digest: "sha256:aaaaaaaaaaaaaaaaaaaa" } },
      { name: "Deploy", status: "done", facts: { digest: "sha256:bbbbbbbbbbbbbbbbbbbb" } },
    ]);
    expect(chain.verdict.title).toBe("Deployed revision doesn't match Build");
    expect(chain.verdict.lines[0].text).toBe("digest changed: built aaaaaaaaaaaa · deployed bbbbbbbbbbbb");
  });

  it("flags a pending stage that targets the wrong device before it runs", () => {
    const chain = read(
      [
        { name: "Build", status: "done", facts: { build: "2811" } },
        { name: "Install on iPhone", status: "pending", facts: { device: "Test iPhone 12" } },
      ],
      { device: "Sam's iPhone 15 Pro" },
    );
    expect(chain.verdict).toMatchObject({ tone: "bad", title: "Install on iPhone: device isn't the requested one" });
  });

  it("puts a failure first", () => {
    const chain = read([
      { name: "Build", status: "done" },
      { name: "Install", status: "failed", detail: "ERROR: The developer disk image could not be mounted" },
      { name: "Launch", status: "pending" },
    ]);
    expect(chain.verdict).toMatchObject({ tone: "bad", title: "Install failed" });
    expect(chain.stages[2].receipt).toBe("not-reached");
  });

  it("says a running chain is in progress and the rest is waiting", () => {
    const chain = read([{ name: "Build", status: "running" }, { name: "Deploy", status: "queued" }]);
    expect(chain.verdict).toMatchObject({ tone: "info", title: "Build: in progress" });
    expect(chain.stages[1]).toMatchObject({ receipt: "waiting", note: "queued" });
  });

  it("never calls an unconfirmed request matched", () => {
    const chain = read([{ name: "Build", status: "done", facts: { build: "2811" } }, { name: "Install", status: "done", facts: { build: "2811" } }], { device: "Sam's iPhone 15 Pro" });
    expect(chain.verdict).toMatchObject({ tone: "warn", title: "Installed build: device not confirmed" });
    expect(chain.verdict.lines[0].text).toBe("device not confirmed: no stage reports it (expected Sam's iPhone 15 Pro)");
  });

  it("says the request is met when every expected fact is confirmed", () => {
    const chain = read([{ name: "Install", status: "done", facts: { branch: "refs/heads/feat/399", device: "Sam’s iPhone" } }], { branch: "feat/399", device: "sam's iphone" });
    expect(chain.verdict).toMatchObject({ tone: "good", title: "Installed build is the requested one" });
    expect(chain.verdict.lines.map((line) => line.text)).toEqual(["branch refs/heads/feat/399 at Install", "device Sam’s iPhone at Install"]);
  });

  it("is honest when nothing could be compared", () => {
    const chain = read([{ name: "Build", status: "done" }, { name: "Deploy", status: "done", facts: { url: "https://orbit.example.com" } }]);
    expect(chain.verdict).toMatchObject({ tone: "good", title: "All 2 stages done" });
    expect(chain.verdict.lines[0].text).toMatch(/nothing was compared/);
  });

  it("says when no stage reported anything", () => {
    expect(read(["Build", "Install"]).verdict).toMatchObject({ tone: "warn", title: "No receipts: none of the 2 stages reported an outcome" });
  });
});

describe("readProvenance: input", () => {
  it("refuses what is not a list of stages, and too long a chain", () => {
    expect(readProvenance({ stages: [] })).toMatchObject({ ok: false });
    expect(readProvenance("Build")).toMatchObject({ ok: false });
    expect(readProvenance([1, 2])).toMatchObject({ ok: false });
    expect(readProvenance(Array.from({ length: 41 }, (_, index) => `Stage ${index}`))).toMatchObject({ ok: false, error: expect.stringMatching(/up to 40/) });
  });

  it("reads an empty chain, names, aliases, times and key/value fact lists", () => {
    expect(read([]).verdict.title).toBe("No stages");
    const [stage] = read([
      {
        stage: "Upload to App Store Connect",
        state: "SUCCEEDED",
        startedAt: "2026-10-09T21:40:00Z",
        completedAt: "2026-10-09T21:46:11Z",
        facts: [
          { key: "CFBundleVersion", value: 4712 },
          { name: "bundleId", value: "com.example.orbit" },
          { label: "dirty", value: false },
        ],
      },
    ]).stages;
    expect(stage).toMatchObject({ name: "Upload to App Store Connect", status: "done", ms: 371_000, verb: "uploaded", at: Date.parse("2026-10-09T21:46:11Z") });
    expect(stage.facts.map((fact) => [fact.label, fact.value])).toEqual([
      ["build", "4712"],
      ["bundle", "com.example.orbit"],
      ["dirty", "no"],
    ]);
  });

  it("keeps the first of two spellings of one fact", () => {
    const [stage] = read([{ name: "Build", status: "done", facts: { sha: "1a68a02", commit: "d62fbf3" } }]).stages;
    expect(stage.facts).toHaveLength(1);
    expect(stage.facts[0].value).toBe("1a68a02");
  });
});

describe("helpers", () => {
  it("reads status words, keeping what is not one", () => {
    expect(stageStatus("Timed out")).toEqual({ status: "unknown", note: "timed out" });
    expect(stageStatus("in_progress")).toEqual({ status: "running", note: null });
    expect(stageStatus("waiting for phone")).toEqual({ status: "unknown", note: "waiting for phone" });
    expect(stageStatus(undefined)).toEqual({ status: "unknown", note: null });
    expect(stageStatus(true)).toEqual({ status: "done", note: null });
  });

  it("matches short and full shas, branches with refs, and words loosely", () => {
    expect(sameValue("sha", "1a68a02", "1a68a022fefb4c26ded1dbc0a1aa99d06ab79f87")).toBe(true);
    expect(sameValue("sha", "1a68", "1a68a022fefb")).toBe(false);
    expect(sameValue("digest", "sha256:0f3c9a1b2c4d5e6f7a8b", "0F3C9A1B2C4D5E6F7A8B")).toBe(true);
    expect(sameValue("branch", "origin/main", "refs/heads/main")).toBe(true);
    expect(sameValue("branch", "Main", "main")).toBe(false);
    expect(sameValue("device", "Sam’s iPhone", "sam's  iphone")).toBe(true);
    expect(shortValue("sha", "1a68a022fefb4c26")).toBe("1a68a02");
    expect(shortValue("sha", "HEAD")).toBe("HEAD");
  });

  it("reads evidence: links, images, files at a line, notes; Windows paths too", () => {
    expect(evidenceOf("https://orbit.example.com/")).toEqual({ kind: "url", url: "https://orbit.example.com/", label: null });
    expect(evidenceOf("$BB_THREAD_STORAGE/launch.png")).toEqual({ kind: "image", src: "$BB_THREAD_STORAGE/launch.png", label: null });
    expect(evidenceOf("logs/install.log:42")).toEqual({ kind: "file", path: "logs/install.log", line: 42, label: null });
    expect(evidenceOf("C:\\builds\\orbit\\install.log")).toMatchObject({ kind: "file", path: "C:\\builds\\orbit\\install.log" });
    expect(evidenceOf("devicectl printed no job ID")).toEqual({ kind: "text", text: "devicectl printed no job ID", label: null });
  });

  it("finds the verb in a stage's name", () => {
    expect(["Checkout", "Build on build-mini", "Transfer to dev-laptop", "Reinstall on iPhone", "Launch", "Probe live URL", "wrangler deploy", "Smoke test"].map(stageVerb)).toEqual([
      "checked out",
      "built",
      "transferred",
      "installed",
      "launched",
      "live",
      "deployed",
      "live",
    ]);
    expect(stageVerb("Review")).toBeNull();
  });
});
