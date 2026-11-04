import { expect, test } from "bun:test";
import type { PublishReport } from "../../catalog/publish.ts";
import type { Rule } from "../../shared/rules.ts";
import { publishFindings } from "./publish.ts";

const report = (conflicts: string[]): PublishReport => ({
  linked: [],
  relinked: [],
  unlinked: [],
  unchanged: 0,
  agentsMd: "unchanged",
  conflicts,
  failed: [],
  deferred: [],
  removed: 0,
});
const codexOn = (host: string): Rule => ({
  id: `rule_${host}`,
  name: "",
  enabled: true,
  instructions: "x".repeat(3000),
  when: { hosts: [host], providers: ["codex"], models: [], projects: [] },
});

test("rules that may pass bb's cap only warn; a clash is a problem", () => {
  const rules = [codexOn("host_mac"), codexOn("host_linux")];
  const clean = publishFindings(report([]), rules);
  expect(clean.problems).toEqual([]);
  expect(clean.warnings).toHaveLength(1);
  expect(clean.warnings[0]).toContain("Rules for codex add up to 6002 characters");
  expect(publishFindings(report(["skills/dev"]), []).problems).toHaveLength(1);
});
