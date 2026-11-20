import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ICON_IMAGE_MAX_BYTES } from "../contract/icon.ts";
import { iconTag } from "../contract/rpc.ts";
import { sniffImageType } from "./icon.ts";
import { NOTICE } from "./store.ts";
import { captainHost, newCaptain, type CaptainHost } from "./test-host.ts";

/** The smallest valid PNG: one transparent pixel. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_URL = `data:image/png;base64,${PNG.toString("base64")}`;

async function iconHost() {
  const host = await captainHost();
  const captainId = await newCaptain(host);
  const cli = (argv: string[], cwd?: string) =>
    host.harness.behavior.runCli(["icon", ...argv, "--json"], {
      threadId: captainId,
      ...(cwd === undefined ? {} : { cwd }),
    });
  const icons = (keys: string[] = [captainId]) =>
    host.harness.behavior.callRpc("icons", { keys }) as Promise<Record<string, unknown>>;
  const setIcon = (icon: unknown) => host.harness.behavior.callRpc("setIcon", { captainId, icon });
  return { host, captainId, cli, icons, setIcon };
}

const results = (stdout: string) =>
  (JSON.parse(stdout) as { results: { state: string; icon: unknown }[] }).results;

describe("a Captain's sidebar icon", () => {
  test("is the default glyph until set; threads that are not live Captains get no entry", async () => {
    const { host, captainId, icons } = await iconHost();
    host.addThread({ id: "thr_other" });
    expect(await icons([captainId, "thr_other", "thr_missing"])).toEqual({
      [captainId]: { kind: "default" },
    });
  });

  test("`bb captain icon` stores a bb icon name, written as lucide exports it", async () => {
    const { cli, icons, captainId } = await iconHost();
    const set = await cli(["ship-wheel"]);
    expect(set.exitCode).toBe(0);
    expect(results(set.stdout)[0]).toMatchObject({
      state: "set",
      icon: { kind: "icon", name: "ShipWheel" },
    });
    expect(await icons()).toEqual({ [captainId]: { kind: "icon", name: "ShipWheel" } });

    const shown = await cli([]);
    expect(results(shown.stdout)[0]).toMatchObject({
      state: "current",
      icon: { name: "ShipWheel" },
    });

    const bad = await cli(["9lives"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("is not an icon name");
    expect(await icons()).toEqual({ [captainId]: { kind: "icon", name: "ShipWheel" } });
  });

  test("`bb captain icon <path>` reads an image from the calling machine as a data URL", async () => {
    const { host, cli, icons, captainId } = await iconHost();
    writeFileSync(join(host.root, "crest.png"), PNG);
    const set = await cli(["./crest.png"], host.root);
    expect(set.exitCode).toBe(0);
    expect(results(set.stdout)[0]).toMatchObject({ icon: { kind: "image", bytes: PNG.length } });
    expect(await icons()).toEqual({ [captainId]: { kind: "image", src: PNG_URL } });

    writeFileSync(join(host.root, "notes.txt"), "not a picture");
    const text = await cli([join(host.root, "notes.txt")]);
    expect(text.exitCode).toBe(1);
    expect(text.stderr).toContain("is not a PNG, JPEG, GIF, WebP or SVG image");

    writeFileSync(
      join(host.root, "huge.png"),
      Buffer.concat([PNG, Buffer.alloc(ICON_IMAGE_MAX_BYTES)]),
    );
    const huge = await cli([join(host.root, "huge.png")]);
    expect(huge.exitCode).toBe(1);
    expect(huge.stderr).toContain("the most is 128 KB");
    expect(await icons()).toEqual({ [captainId]: { kind: "image", src: PNG_URL } });
  });

  test("clearing it, from the CLI or settings, returns to the default glyph", async () => {
    const { cli, icons, setIcon, captainId } = await iconHost();
    await cli(["Anchor"]);
    const cleared = await cli(["--clear"]);
    expect(cleared.exitCode).toBe(0);
    expect(results(cleared.stdout)[0]).toMatchObject({
      state: "cleared",
      icon: { kind: "default" },
    });
    expect(await icons()).toEqual({ [captainId]: { kind: "default" } });

    await setIcon({ kind: "icon", name: "Crown" });
    expect(await setIcon(null)).toEqual({ kind: "default" });
    expect(await icons()).toEqual({ [captainId]: { kind: "default" } });

    const both = await cli(["Anchor", "--clear"]);
    expect(both.exitCode).toBe(1);
  });

  test("settings stores an uploaded image by its real type, and refuses one that is not an image", async () => {
    const { host, setIcon, icons, captainId } = await iconHost();
    const before = host.harness.inspection.experimental_rpcInvalidations.flat().length;
    // Labelled JPEG, but the bytes are a PNG: stored as what it is.
    const relabelled = `data:image/jpeg;base64,${PNG.toString("base64")}`;
    expect(await setIcon({ kind: "image", src: relabelled })).toEqual({
      kind: "image",
      src: PNG_URL,
    });
    expect(host.harness.inspection.experimental_rpcInvalidations.flat().slice(before)).toContain(
      iconTag(captainId),
    );
    const notImage = `data:image/png;base64,${Buffer.from("hello").toString("base64")}`;
    await expect(setIcon({ kind: "image", src: notImage })).rejects.toThrow(/not a PNG/u);
    expect(await icons()).toEqual({ [captainId]: { kind: "image", src: PNG_URL } });
  });

  test("settings lists each live Captain with its name and icon", async () => {
    const { host, setIcon, captainId } = await iconHost();
    await setIcon({ kind: "icon", name: "Crown" });
    expect(await host.harness.behavior.callRpc("captainIcons", {})).toEqual({
      captains: [{ threadId: captainId, name: "Plugins", icon: { kind: "icon", name: "Crown" } }],
    });
  });

  test("survives a plugin reload: the reloaded instance reads it from data.db", async () => {
    const { host, cli, captainId } = await iconHost();
    await cli(["Crown"]);
    await host.reload();
    expect(host.server.store.captainIcon(captainId)).toEqual({ kind: "icon", name: "Crown" });
  });

  test("an archived Captain loses its entry", async () => {
    const { host, cli, icons, captainId } = await iconHost();
    await cli(["Crown"]);
    await host.harness.behavior.runCli(["archive", "--captain", captainId]);
    expect(await icons()).toEqual({});
  });

  test("sniffs only image types an <img> draws", () => {
    expect(sniffImageType(PNG)).toBe("png");
    expect(sniffImageType(Buffer.from('<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"/>'))).toBe(
      "svg+xml",
    );
    expect(sniffImageType(Buffer.from("<html><svg/></html>"))).toBeNull();
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

  test("a new Captain is titled with its name alone", async () => {
    const host = await captainHost();
    const captainId = await newCaptain(host);
    expect(host.threads.get(captainId)?.title).toBe("Plugins");
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
