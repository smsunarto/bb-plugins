import { describe, expect, test } from "vitest";
import { normalizeIconName } from "../contract/icon.ts";
import { iconTag } from "../contract/rpc.ts";
import { NOTICE } from "./store.ts";
import { captainHost, newCaptain, type CaptainHost } from "./test-host.ts";

/** The smallest valid PNG: one transparent pixel. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_URL = `data:image/png;base64,${PNG.toString("base64")}`;

/** The same PNG with its header claiming `width` x `height`: only the header is read. */
function pngSized(width: number, height: number): Buffer {
  const bytes = Buffer.from(PNG);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

async function iconHost() {
  const host = await captainHost();
  const captainId = await newCaptain(host);
  const cli = (argv: string[]) =>
    host.harness.behavior.runCli(["icon", ...argv, "--json"], { threadId: captainId });
  const icons = (keys: string[] = [captainId]) =>
    host.callRpc("icons", { keys }) as Promise<Record<string, unknown>>;
  const setIcon = (icon: unknown) => host.callRpc("setIcon", { captainId, icon });
  return { host, captainId, cli, icons, setIcon };
}

const results = (stdout: string) =>
  (JSON.parse(stdout) as { results: { state: string; icon: unknown }[] }).results;
const invalidated = (host: CaptainHost) =>
  host.harness.inspection.experimental_rpcInvalidations.flat();

describe("a Captain's sidebar icon", () => {
  test("is the default glyph until set; every other key gets null, never a missing entry", async () => {
    const { host, captainId, icons } = await iconHost();
    host.addThread({ id: "thr_other" });
    // bb's keyed read fails the whole batch when a key is missing from the answer.
    expect(await icons([captainId, "thr_other", "thr_missing"])).toEqual({
      [captainId]: { kind: "default" },
      thr_other: null,
      thr_missing: null,
    });
  });

  test("`bb captain icon` stores a bb icon name in bb's PascalCase, and says it was not checked", async () => {
    const { cli, icons, captainId } = await iconHost();
    const set = await cli(["star"]);
    expect(set.exitCode).toBe(0);
    expect(results(set.stdout)[0]).toMatchObject({
      state: "set",
      icon: { kind: "icon", name: "Star" },
    });
    expect(set.stderr).toContain("not checked against bb's icon set");
    expect(await icons()).toEqual({ [captainId]: { kind: "icon", name: "Star" } });

    await cli(["ai-brain-01"]);
    expect(await icons()).toEqual({ [captainId]: { kind: "icon", name: "AiBrain01" } });

    const shown = await cli([]);
    expect(results(shown.stdout)[0]).toMatchObject({
      state: "current",
      icon: { name: "AiBrain01" },
    });

    const bad = await cli(["9lives"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("is not an icon name");
    expect(await icons()).toEqual({ [captainId]: { kind: "icon", name: "AiBrain01" } });
  });

  test("reads names as bb spells them", () => {
    expect(normalizeIconName("target")).toBe("Target");
    expect(normalizeIconName("ai_brain_01")).toBe("AiBrain01");
    expect(normalizeIconName("aiBrain01")).toBe("AiBrain01");
    expect(normalizeIconName("SHIP-WHEEL")).toBe("ShipWheel");
    expect(normalizeIconName("9lives")).toBeNull();
  });

  test("the CLI sets names only, and refuses a value that looks like a file", async () => {
    const { cli, icons, captainId } = await iconHost();
    await cli(["Target"]);
    for (const value of ["./crest.png", "crest.png", "/tmp/crest", ".crest"]) {
      const refused = await cli([value]);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("looks like a file; the CLI sets icon names only");
    }
    expect(await icons()).toEqual({ [captainId]: { kind: "icon", name: "Target" } });
  });

  test("clearing it, from the CLI or settings, returns to the default glyph", async () => {
    const { cli, icons, setIcon, captainId } = await iconHost();
    await cli(["Star"]);
    const cleared = await cli(["--clear"]);
    expect(cleared.exitCode).toBe(0);
    expect(results(cleared.stdout)[0]).toMatchObject({
      state: "cleared",
      icon: { kind: "default" },
    });
    expect(await icons()).toEqual({ [captainId]: { kind: "default" } });

    await setIcon({ kind: "icon", name: "Brain" });
    expect(await setIcon(null)).toEqual({ kind: "default" });
    expect(await icons()).toEqual({ [captainId]: { kind: "default" } });

    const both = await cli(["Star", "--clear"]);
    expect(both.exitCode).toBe(1);
  });

  test("settings stores the PNG it made, and refuses any other image", async () => {
    const { host, setIcon, icons, captainId } = await iconHost();
    const before = invalidated(host).length;
    expect(await setIcon({ kind: "image", src: PNG_URL })).toEqual({ kind: "image", src: PNG_URL });
    expect(invalidated(host).slice(before)).toContain(iconTag(captainId));

    const png = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;
    await expect(setIcon({ kind: "image", src: png(Buffer.from("hello")) })).rejects.toThrow(
      /not a complete PNG/u,
    );
    // Cut short: no closing IEND chunk.
    await expect(setIcon({ kind: "image", src: png(PNG.subarray(0, -12)) })).rejects.toThrow(
      /not a complete PNG/u,
    );
    await expect(setIcon({ kind: "image", src: png(pngSized(97, 96)) })).rejects.toThrow(
      /97x96 px; the most is 96x96/u,
    );
    // Just over 16 KB, still inside the contract's data URL length.
    const big = Buffer.concat([PNG, Buffer.alloc(16 * 1024 + 1 - PNG.length)]);
    await expect(setIcon({ kind: "image", src: png(big) })).rejects.toThrow(/the most is 16 KB/u);
    // Any other type fails the contract before it reaches the check.
    for (const type of ["jpeg", "gif", "webp", "svg+xml"]) {
      await expect(
        setIcon({ kind: "image", src: `data:image/${type};base64,${PNG.toString("base64")}` }),
      ).rejects.toThrow();
    }
    expect(await icons()).toEqual({ [captainId]: { kind: "image", src: PNG_URL } });
  });

  test("a stored row that fails the contract reads as the default glyph, not an error", async () => {
    const { host, icons, captainId } = await iconHost();
    const svg = `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`;
    host.server.store.setCaptainIcon(captainId, { kind: "image", src: svg } as never, 0);
    expect(await icons()).toEqual({ [captainId]: { kind: "default" } });
    host.server.store.setCaptainIcon(captainId, { kind: "icon", name: "not a name" } as never, 0);
    expect(await icons()).toEqual({ [captainId]: { kind: "default" } });
    expect(await host.callRpc("captainIcons", {})).toEqual({
      captains: [{ threadId: captainId, name: "Plugins", icon: { kind: "default" } }],
    });
  });

  test("settings stores canonical base64 for the validated PNG bytes", async () => {
    const { setIcon, icons, captainId } = await iconHost();
    const canonical = { kind: "image", src: PNG_URL };
    expect(await setIcon({ ...canonical, src: PNG_URL.replace(/=+$/u, "") })).toEqual(canonical);
    expect(await icons()).toEqual({ [captainId]: canonical });
  });

  test("settings lists each live Captain with its name and icon", async () => {
    const { host, setIcon, captainId } = await iconHost();
    await setIcon({ kind: "icon", name: "Brain" });
    expect(await host.callRpc("captainIcons", {})).toEqual({
      captains: [{ threadId: captainId, name: "Plugins", icon: { kind: "icon", name: "Brain" } }],
    });
  });

  test("survives a plugin reload: the reloaded plugin's icons read serves it", async () => {
    const { host, cli, icons, captainId } = await iconHost();
    await cli(["Brain"]);
    await host.reload();
    expect(await icons()).toEqual({ [captainId]: { kind: "icon", name: "Brain" } });
  });

  test("new and archive refresh the icon reads; an archived Captain reads null and loses its row", async () => {
    const host = await captainHost();
    const captainId = await newCaptain(host);
    expect(invalidated(host)).toContain(iconTag(captainId));
    await host.harness.behavior.runCli(["icon", "Star", "--captain", captainId]);
    const before = invalidated(host).length;
    await host.harness.behavior.runCli(["archive", "--captain", captainId]);
    expect(invalidated(host).slice(before)).toContain(iconTag(captainId));
    expect(await host.callRpc("icons", { keys: [captainId] })).toEqual({ [captainId]: null });
    // The row is gone, not just hidden: the store reads the default for it.
    expect(host.server.store.captainIcon(captainId)).toEqual({ kind: "default" });
  });
});

describe('the retired " Captain" title suffix', () => {
  /** A Captain as one started before the change: titled "Plugins Captain", never checked. */
  async function legacyCaptain(host: CaptainHost) {
    const captainId = await newCaptain(host);
    const key = NOTICE.titleSuffix(captainId);
    host.server.store.releaseNotice(key, host.server.store.noticeSentAt(key) ?? 0);
    host.updateThread(captainId, { title: "Plugins Captain" });
    return captainId;
  }

  test("a new Captain is titled with its name alone, and counts as checked", async () => {
    const host = await captainHost();
    const captainId = await newCaptain(host);
    expect(host.threads.get(captainId)?.title).toBe("Plugins");
    // A user who adds the suffix to a new Captain keeps it across a reload.
    host.updateThread(captainId, { title: "Plugins Captain" });
    await host.reload();
    await host.server.titlesReady;
    expect(host.threads.get(captainId)?.title).toBe("Plugins Captain");
  });

  test('an existing Captain still titled "<name> Captain" is renamed once on load', async () => {
    const host = await captainHost();
    const captainId = await legacyCaptain(host);
    await host.reload();
    await host.server.titlesReady;
    expect(host.threads.get(captainId)?.title).toBe("Plugins");

    // Checked once: a user who puts the suffix back keeps it.
    host.updateThread(captainId, { title: "Plugins Captain" });
    await host.reload();
    await host.server.titlesReady;
    expect(host.threads.get(captainId)?.title).toBe("Plugins Captain");
  });

  test("a title the user changed is left alone", async () => {
    const host = await captainHost();
    const captainId = await legacyCaptain(host);
    host.updateThread(captainId, { title: "Flagship" });
    await host.reload();
    await host.server.titlesReady;
    expect(host.threads.get(captainId)?.title).toBe("Flagship");
  });
});
