import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile, dataKey, evaluate, formatDiagnostics, initialState, parseDataFile, toMarkdown } from "./index";

function galleryFile(path: string): string {
  return readFileSync(new URL(`../gallery/${path}`, import.meta.url), "utf8");
}

/** A gallery example as `bb genui render` prints it, with the files it Loads. */
function markdown(source: string): string {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  const files = [...source.matchAll(/Load\("([^"]+)"\)/g)].map((match) => match[1]);
  const data = new Map(files.map((path) => [dataKey({ path, raw: false }), parseDataFile(path, galleryFile(path))]));
  return toMarkdown(evaluate(result.program, initialState(result.program, data), data).roots);
}

describe("toMarkdown: Provenance", () => {
  it("renders a wrong-branch install: the verdict and the mismatch first, then each stage with the wrong fact and both values", () => {
    const out = markdown(galleryFile("Provenance.ui"));
    const [head, summary, stages] = out.split("\n\n");
    expect(head).toBe("🔴 **Installed build is not the requested one**\n- expected branch feat/399 · installed main (wrong from Checkout on)");
    expect(summary).toBe("5 stages · 6m 17s · requested: branch `feat/399` ✗, device `Sam's iPhone 15 Pro` ✓");
    expect(stages).toContain("1. ⚠️ **Checkout** — 2s\n   branch `main` ✗ expected `feat/399` · sha `1a68a02` · host `build-mini`");
    expect(stages).toContain("3. ✅ **Transfer to dev-laptop** — 19s\n   digest `7c41f0d29b8e`");
    expect(stages).toContain("device `Sam's iPhone 15 Pro` ✓ · UDID `00008130-0011223344556677`");
    expect(stages).toContain("   Evidence: `data/provenance/devicectl-install.json`");
  });

  it("renders a chain that stops: unknown after the last receipt, the stages after it without one, no ✓ on a target", () => {
    const out = markdown(galleryFile("Provenance-no-receipt.ui"));
    expect(out.startsWith("🟠 **Unknown after Transfer to dev-laptop: no receipt**\n- device Sam's iPhone 15 Pro not confirmed: only Install on iPhone names it, without a receipt\n- No receipt: Install on iPhone (timed out) · Launch")).toBe(true);
    expect(out).toContain("requested: branch `feat/399` ✓, device `Sam's iPhone 15 Pro` (not confirmed)");
    expect(out).toContain("3. ✅ **Transfer to dev-laptop** — 21s · last receipt");
    expect(out).toContain("4. ❔ **Install on iPhone** — no receipt · timed out · 1m 01s\n   build `4712` · host `dev-laptop` · device `Sam's iPhone 15 Pro`\n");
    expect(out).toContain("   Evidence: `data/provenance/install-timeout.log`\n5. ❔ **Launch** — no receipt");
  });

  it("renders a matching deploy with its links and evidence", () => {
    const out = markdown(galleryFile("Provenance-deploy.ui"));
    expect(out.split("\n\n").slice(0, 2)).toEqual(["🟢 **Deployed revision matches source**\n- sha 44f1d74 at all 4 stages", "4 stages · 1m 10s (3 of 4 timed)"]);
    expect(out).toContain("4. ✅ **Probe live URL** — 1s\n   sha `44f1d74` · URL [orbit.example.com](https://orbit.example.com/) · http `200`");
    expect(out).toContain(
      "   Evidence: `data/provenance/live-probe.txt` · The live page at 393 px: `data/provenance/live-home.jpg` · [orbit.example.com/](https://orbit.example.com/)",
    );
  });

  it("renders failures, a running chain, values with backticks, and says what is wrong with unusable input", () => {
    expect(markdown(`Provenance([{name: "Build", status: "done"}, {name: "Install", status: "failed", detail: "ERROR: The developer disk image could not be mounted"}, {name: "Launch"}])`)).toBe(
      "🔴 **Install failed**\n\n3 stages · 2 with a receipt\n\n1. ✅ **Build**\n2. ❌ **Install** — failed\n   ERROR: The developer disk image could not be mounted\n3. ⚪ **Launch** — not reached",
    );
    expect(markdown(`Provenance([{name: "Deploy", status: "running", facts: {note: "a \`tick\`"}}])`)).toBe(
      "🔵 **Deploy: in progress**\n\n1 stage\n\n1. 🔄 **Deploy** — running\n   note `` a `tick` ``",
    );
    expect(markdown(`Provenance([])`)).toBe("**Provenance** · no stages yet");
    expect(markdown(`Provenance([1, 2])`)).toMatch(/^_\(Provenance needs a list of stages/);
  });
});
