import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { normalizeIconName } from "../contract/icon.ts";
import { iconTag } from "../contract/rpc.ts";
import { imageSize, sniffImageType } from "./icon.ts";
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
  const cli = (argv: string[], cwd?: string) =>
    host.harness.behavior.runCli(["icon", ...argv, "--json"], {
      threadId: captainId,
      ...(cwd === undefined ? {} : { cwd }),
    });
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

  test("`bb captain icon <path>` reads an image from the calling machine as a data URL", async () => {
    const { host, cli, icons, captainId } = await iconHost();
    writeFileSync(join(host.root, "crest.png"), PNG);
    const set = await cli(["./crest.png"], host.root);
    expect(set.exitCode).toBe(0);
    expect(results(set.stdout)[0]).toMatchObject({ icon: { kind: "image", bytes: PNG.length } });
    expect(set.stderr ?? "").not.toContain("not checked");
    expect(await icons()).toEqual({ [captainId]: { kind: "image", src: PNG_URL } });
  });

  test("a bare word names a file in the working directory when one is there, else an icon", async () => {
    const { host, cli, icons, captainId } = await iconHost();
    writeFileSync(join(host.root, "crest"), PNG);
    expect((await cli(["crest"], host.root)).exitCode).toBe(0);
    expect(await icons()).toEqual({ [captainId]: { kind: "image", src: PNG_URL } });
    expect((await cli(["target"], host.root)).exitCode).toBe(0);
    expect(await icons()).toEqual({ [captainId]: { kind: "icon", name: "Target" } });
  });

  test.each([
    [
      "an SVG",
      "logo.svg",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      "SVG is not stored",
    ],
    ["text", "notes.txt", Buffer.from("not a picture"), "is not a PNG, JPEG, GIF or WebP image"],
    [
      "an image over 16 KB",
      "big.png",
      Buffer.concat([PNG, Buffer.alloc(16 * 1024)]),
      "the most is 16 KB",
    ],
    ["an image over 96 px", "wide.png", pngSized(8000, 8000), "8000x8000 px; the most is 96x96"],
  ])("the CLI refuses %s and keeps the icon it had", async (_, file, bytes, reason) => {
    const { host, cli, icons, captainId } = await iconHost();
    await cli(["Target"]);
    writeFileSync(join(host.root, file), bytes);
    const refused = await cli([join(host.root, file)]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(reason);
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

  test("settings stores an uploaded image by its real type, with the CLI's limits", async () => {
    const { host, setIcon, icons, captainId } = await iconHost();
    const before = invalidated(host).length;
    // Labelled JPEG, but the bytes are a PNG: stored as what it is.
    const relabelled = `data:image/jpeg;base64,${PNG.toString("base64")}`;
    expect(await setIcon({ kind: "image", src: relabelled })).toEqual({
      kind: "image",
      src: PNG_URL,
    });
    expect(invalidated(host).slice(before)).toContain(iconTag(captainId));

    const dataUrl = (bytes: Buffer, type = "png") =>
      `data:image/${type};base64,${bytes.toString("base64")}`;
    await expect(setIcon({ kind: "image", src: dataUrl(Buffer.from("hello")) })).rejects.toThrow(
      /not a PNG/u,
    );
    await expect(setIcon({ kind: "image", src: dataUrl(pngSized(97, 96)) })).rejects.toThrow(
      /97x96 px/u,
    );
    await expect(
      setIcon({ kind: "image", src: dataUrl(Buffer.from("<svg/>"), "svg+xml") }),
    ).rejects.toThrow();
    expect(await icons()).toEqual({ [captainId]: { kind: "image", src: PNG_URL } });
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

  test("sniffs only raster types, and reads each one's size from its header", () => {
    expect(sniffImageType(PNG)).toBe("png");
    expect(
      sniffImageType(Buffer.from('<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"/>')),
    ).toBeNull();
    expect(imageSize("png", pngSized(40, 30))).toEqual({ width: 40, height: 30 });

    const gif = Buffer.from("GIF89a\x20\x00\x10\x00", "latin1");
    expect(sniffImageType(gif)).toBe("gif");
    expect(imageSize("gif", gif)).toEqual({ width: 32, height: 16 });

    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "latin1");
    webp.write("WEBPVP8X", 8, "latin1");
    webp.writeUIntLE(63, 24, 3);
    webp.writeUIntLE(47, 27, 3);
    expect(sniffImageType(webp)).toBe("webp");
    expect(imageSize("webp", webp)).toEqual({ width: 64, height: 48 });

    // SOI, an APP0 segment, then a baseline frame of 24 x 12.
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x0c,
      0x00, 0x18, 0x03,
    ]);
    expect(sniffImageType(jpeg)).toBe("jpeg");
    expect(imageSize("jpeg", jpeg)).toEqual({ width: 24, height: 12 });
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
