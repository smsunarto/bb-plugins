import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { treeSha } from "./tree.ts";
import { publish, type PublishSource } from "./publish.ts";

const PLUGIN = "agent-instructions";
const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    // Published trees are read-only; let rm clear them.
    spawnSync("chmod", ["-R", "u+w", dir]);
    await rm(dir, { recursive: true, force: true });
  }
});

async function dataDir() {
  const dir = await mkdtemp(join(tmpdir(), "publish-"));
  cleanup.push(dir);
  return dir;
}

type File = { path: string; executable: boolean; bytes: Uint8Array };
const file = (path: string, content: string | Uint8Array, executable = false): File => ({
  path,
  executable,
  bytes: typeof content === "string" ? Buffer.from(content) : content,
});
const skillMd = (name: string, body = "") =>
  file("SKILL.md", `---\nname: ${name}\ndescription: The ${name} skill.\n---\n${body}`);

/** A catalog with these skills and docs; a doc starting with "off:" is disabled. */
function catalog(skills: Record<string, File[]>, docs: string[] = []): PublishSource {
  return {
    publishable: () =>
      Object.entries(skills)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, files]) => ({
          name,
          treeSha: treeSha(
            files.map((f) => ({
              path: f.path,
              executable: f.executable,
              bytes: f.bytes,
              sha256: createHash("sha256").update(f.bytes).digest("hex"),
            })),
          ),
        })),
    skillFiles: (name) => skills[name] ?? [],
    docs: () =>
      docs.map((body) => ({ body: body.replace(/^off:/, ""), enabled: !body.startsWith("off:") })),
  };
}

const BLOB = new Uint8Array([0, 255, 1, 254, 2]);
const v1 = () =>
  catalog(
    {
      probe: [
        skillMd("probe", "Run `scripts/run.sh`.\n"),
        file("scripts/run.sh", "#!/bin/sh\necho ok\n", true),
        file("assets/blob.bin", BLOB),
      ],
      dev: [skillMd("dev")],
    },
    ["Global A", "off:Hidden", "Global B"],
  );

/** Every path under `dir` with its type and permission bits, for comparing whole trees. */
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string) {
    for (const name of (await readdir(current)).sort()) {
      const path = join(current, name);
      const info = await lstat(path);
      const kind = info.isSymbolicLink()
        ? `-> ${await readlink(path)}`
        : info.isDirectory()
          ? "dir"
          : "file";
      out.push(`${relative(dir, path)} ${kind} ${(info.mode & 0o777).toString(8)}`);
      if (info.isDirectory()) await walk(path);
    }
  }
  await walk(dir);
  return out;
}

const asRoot = process.getuid?.() === 0;
/** macOS disks usually ignore case; Linux ones usually do not. */
const CASE_INSENSITIVE = (() => {
  const dir = mkdtempSync(join(tmpdir(), "publish-case-"));
  writeFileSync(join(dir, "Case"), "");
  const result = existsSync(join(dir, "case"));
  rmSync(dir, { recursive: true });
  return result;
})();

describe("publish", () => {
  test("delivers each skill through a relative link to a read-only tree, and global text as AGENTS.md", async () => {
    const dir = await dataDir();
    const report = await publish(dir, PLUGIN, v1());
    expect(report.linked.toSorted()).toEqual(["dev", "probe"]);
    expect(report.agentsMd).toBe("linked");
    expect(report.conflicts).toEqual([]);

    const probe = join(dir, "skills/probe");
    expect((await lstat(probe)).isSymbolicLink()).toBe(true);
    expect(isAbsolute(await readlink(probe))).toBe(false);
    expect(await readFile(join(probe, "SKILL.md"), "utf8")).toContain("name: probe");
    expect(new Uint8Array(await readFile(join(probe, "assets/blob.bin")))).toEqual(BLOB);
    expect((await stat(join(probe, "scripts/run.sh"))).mode & 0o777).toBe(0o555);
    expect((await stat(join(probe, "SKILL.md"))).mode & 0o777).toBe(0o444);
    if (!asRoot) {
      await expect(writeFile(join(probe, "SKILL.md"), "edited")).rejects.toThrow();
      await expect(writeFile(join(probe, "new.md"), "added")).rejects.toThrow();
    }
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("Global A\n\nGlobal B\n");

    const again = await publish(dir, PLUGIN, v1());
    expect(again).toMatchObject({
      linked: [],
      relinked: [],
      unlinked: [],
      unchanged: 2,
      agentsMd: "unchanged",
      removed: 0,
    });
  });

  test("an edit moves the link and removes the copy it replaced", async () => {
    const dir = await dataDir();
    await publish(dir, PLUGIN, v1());
    const oldProbe = await realpath(join(dir, "skills/probe"));
    const oldText = await realpath(join(dir, "AGENTS.md"));

    const v2 = catalog({ probe: [skillMd("probe", "Edited.\n")], dev: [skillMd("dev")] }, [
      "Global C",
    ]);
    const report = await publish(dir, PLUGIN, v2);
    expect(report).toMatchObject({
      relinked: ["probe"],
      unchanged: 1,
      agentsMd: "relinked",
      removed: 2,
    });
    expect(await readFile(join(dir, "skills/probe/SKILL.md"), "utf8")).toContain("Edited.");
    expect(existsSync(join(dir, "skills/probe/scripts/run.sh"))).toBe(false);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("Global C\n");
    expect(existsSync(oldProbe)).toBe(false);
    expect(existsSync(oldText)).toBe(false);
  });

  test("a skill that changes while it is being published is never built under its old hash", async () => {
    const dir = await dataDir();
    const good = v1();
    const changed: PublishSource = {
      publishable: good.publishable,
      docs: good.docs,
      skillFiles: (name) =>
        name === "probe" ? [skillMd("probe", "Newer.\n")] : good.skillFiles(name),
    };
    const report = await publish(dir, PLUGIN, changed);
    expect(report.deferred).toEqual(["probe"]);
    expect(report.failed).toEqual([]);
    await publish(dir, PLUGIN, good);
    expect(await readFile(join(dir, "skills/probe/SKILL.md"), "utf8")).toContain("scripts/run.sh");
  });

  test("a skill or doc that leaves the catalog loses its link", async () => {
    const dir = await dataDir();
    await publish(dir, PLUGIN, v1());
    const report = await publish(dir, PLUGIN, catalog({ dev: [skillMd("dev")] }, ["off:Hidden"]));
    expect(report).toMatchObject({ unlinked: ["probe"], unchanged: 1, agentsMd: "unlinked" });
    expect(existsSync(join(dir, "skills/probe"))).toBe(false);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(await readFile(join(dir, "skills/dev/SKILL.md"), "utf8")).toContain("name: dev");
  });

  test("entries the plugin did not make are left alone, and a clash is reported", async () => {
    const dir = await dataDir();
    const outside = await dataDir();
    await mkdir(join(dir, "skills/probe"), { recursive: true });
    await writeFile(join(dir, "skills/probe/SKILL.md"), "mine");
    await mkdir(join(dir, "skills/own"));
    await writeFile(join(dir, "skills/own/SKILL.md"), "also mine");
    await symlink(outside, join(dir, "skills/elsewhere"));
    await writeFile(join(dir, "AGENTS.md"), "hand written");
    const before = await snapshot(dir);

    const source = catalog(
      { probe: [skillMd("probe")], elsewhere: [skillMd("elsewhere")], dev: [skillMd("dev")] },
      ["Global A"],
    );
    const report = await publish(dir, PLUGIN, source);
    expect(report.conflicts.toSorted()).toEqual(["AGENTS.md", "skills/elsewhere", "skills/probe"]);
    expect(report.linked).toEqual(["dev"]);
    expect(report.agentsMd).toBe("conflict");
    const userTier = (await snapshot(dir)).filter(
      (line) => !line.startsWith("plugins") && !line.startsWith("skills/dev"),
    );
    expect(userTier).toEqual(before);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("hand written");
  });

  test("a run that stopped part way through is finished by the next one", async () => {
    const dir = await dataDir();
    const good = v1();
    // Stop while writing probe's second file, after dev is published. Its bytes
    // are read once to check the hash and again to write them.
    const crashing: PublishSource = {
      publishable: good.publishable,
      docs: good.docs,
      skillFiles: (name) => {
        const files = good.skillFiles(name);
        if (name !== "probe") return files;
        return files.map((f, i) => {
          let reads = 0;
          return {
            path: f.path,
            executable: f.executable,
            get bytes(): Uint8Array {
              if (i > 0 && ++reads > 1) throw new Error("stopped");
              return f.bytes;
            },
          };
        });
      },
    };
    // One skill failing does not hold back the others.
    const stopped = await publish(dir, PLUGIN, crashing);
    expect(stopped.failed).toEqual([{ name: "probe", error: "stopped" }]);
    expect(stopped.linked).toEqual(["dev"]);
    expect(stopped.agentsMd).toBe("linked");

    await publish(dir, PLUGIN, good);
    const clean = await dataDir();
    await publish(clean, PLUGIN, good);
    expect(await snapshot(dir)).toEqual(await snapshot(clean));
  });

  test.skipIf(!CASE_INSENSITIVE)(
    "on a case-insensitive disk, a user's differently cased entry is a clash",
    async () => {
      const dir = await dataDir();
      const outside = await dataDir();
      await mkdir(join(dir, "skills/Probe"), { recursive: true });
      await writeFile(join(dir, "skills/Probe/SKILL.md"), "mine");
      await symlink(outside, join(dir, "skills/Dev"));
      const report = await publish(dir, PLUGIN, v1());
      expect(report.conflicts.toSorted()).toEqual(["skills/dev", "skills/probe"]);
      expect(await readlink(join(dir, "skills/Dev"))).toBe(outside);
      expect(await readFile(join(dir, "skills/Probe/SKILL.md"), "utf8")).toBe("mine");
    },
  );
});
