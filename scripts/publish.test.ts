// The publish gate decides whether a tarball can be installed at all, so the
// checks that matter get a test each — most of all the one that reads the
// manifest's bb.* paths back out of the packed file list.
import { describe, expect, mock, test } from "bun:test";
import {
  ALLOWED_LICENSES,
  bbTargets,
  mirrorPackageName,
  nonRegistryProtocol,
  npmViewFailureIsMissing,
  packedPaths,
  publishPackageVersion,
  publishProblems,
  type RegistryVersionState,
} from "./publish";
import { derivePluginId, workspacePlugins } from "./plugin-package";
import { join } from "node:path";
import type { PluginManifest } from "./plugin-package";

/** A manifest and a packed file list that the gate accepts. */
function healthy(): { manifest: PluginManifest; paths: string[] } {
  return {
    manifest: {
      name: "@smsunarto/bb-plugin-example",
      version: "1.0.0",
      description: "An example plugin.",
      repository: { type: "git", url: "git+https://example.invalid/x.git" },
      author: "Scott Sunarto",
      license: "MIT",
      publishConfig: { access: "public" },
      files: ["dist/", "assets/", "skills/", "LICENSE"],
      bb: {
        server: "./dist/server.js",
        app: "./dist/app.js",
        skills: ["skills"],
        branding: {
          icon: "./assets/icon.svg",
          logo: { light: "./assets/logo.svg", dark: "./assets/logo-dark.svg" },
        },
      },
    },
    paths: [
      "LICENSE",
      "README.md",
      "package.json",
      "assets/icon.svg",
      "assets/logo.svg",
      "assets/logo-dark.svg",
      "dist/server.js",
      "dist/server.meta.json",
      "dist/app.js",
      "dist/app.meta.json",
      "skills/example/SKILL.md",
    ],
  };
}

describe("publishProblems", () => {
  test("accepts a package whose bb.* paths all survive into the tarball", () => {
    const { manifest, paths } = healthy();
    expect(publishProblems(manifest, paths)).toEqual([]);
  });

  // The bug this gate exists for: `bb.server` pointed at a source file the
  // `files` allowlist never shipped, so every tarball packed clean and
  // installed nowhere.
  test("rejects a bb.server that the files allowlist leaves out", () => {
    const { manifest, paths } = healthy();
    manifest.bb!.server = "./server.ts";

    const problems = publishProblems(manifest, paths);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("bb.server");
    expect(problems[0]).toContain("./server.ts");
    expect(problems[0]).toContain("files");
  });

  test("rejects missing branding, theme, and skills targets", () => {
    const { manifest, paths } = healthy();
    manifest.bb!.themes = [{ id: "example", css: "./themes/example.css" }];

    const problems = publishProblems(
      manifest,
      paths.filter((path) => path !== "assets/logo-dark.svg" && !path.startsWith("skills/")),
    );

    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toContain("bb.branding.logo.dark");
    expect(problems.join("\n")).toContain('bb.themes["example"].css');
    expect(problems.join("\n")).toContain("bb.skills");
  });

  test("accepts a host icon name, which is not a path in the package", () => {
    const { manifest, paths } = healthy();
    manifest.bb!.branding!.icon = "Bell";
    expect(publishProblems(manifest, paths)).toEqual([]);
  });

  test("requires the fixed dist files an npm install reads", () => {
    const { manifest, paths } = healthy();
    const problems = publishProblems(
      manifest,
      paths.filter((path) => path !== "dist/app.meta.json"),
    );
    expect(problems).toEqual([
      "the tarball has no dist/app.meta.json, which bb requires of an npm plugin",
    ]);
  });

  test("rejects dependencies the registry cannot serve", () => {
    const { manifest, paths } = healthy();
    manifest.dependencies = {
      good: "^1.2.3",
      aliased: "npm:other@^1",
      linked: "workspace:*",
      local: "file:../thing",
      cloned: "git+https://example.invalid/x.git",
      shorthand: "owner/repo#main",
    };
    manifest.peerDependencies = { peer: "link:../peer" };
    // devDependencies never reach an installer, so they are not checked.
    manifest.devDependencies = { tooling: "workspace:*" };

    const problems = publishProblems(manifest, paths);
    expect(problems).toHaveLength(5);
    expect(problems.join("\n")).not.toContain("dependencies.good");
    expect(problems.join("\n")).not.toContain("dependencies.aliased");
    expect(problems.join("\n")).not.toContain("devDependencies");
    expect(problems.join("\n")).toContain("peerDependencies.peer");
  });

  test("rejects a private manifest and missing publish metadata", () => {
    const { manifest, paths } = healthy();
    manifest.private = true;
    delete manifest.description;
    delete manifest.repository;
    delete manifest.author;
    delete manifest.publishConfig;

    const problems = publishProblems(manifest, paths).join("\n");
    expect(problems).toContain('"private": true');
    expect(problems).toContain("no description");
    expect(problems).toContain("no repository");
    expect(problems).toContain("no author");
    expect(problems).toContain("publishConfig.access");
  });

  test("accepts the allowlisted licence expressions and nothing else", () => {
    const { manifest, paths } = healthy();
    for (const license of ALLOWED_LICENSES) {
      manifest.license = license;
      expect(publishProblems(manifest, [...paths, "THIRD_PARTY_NOTICES.md"])).toEqual([]);
    }
    manifest.license = "Apache-2.0";
    expect(publishProblems(manifest, paths).join("\n")).toContain("Apache-2.0");
  });

  test("a licence beyond MIT has to ship the terms it adds", () => {
    const { manifest, paths } = healthy();
    manifest.license = "MIT AND PolyForm-Shield-1.0.0";
    expect(publishProblems(manifest, paths)).toEqual([
      'licence "MIT AND PolyForm-Shield-1.0.0" adds terms beyond MIT, but the tarball carries no THIRD_PARTY_NOTICES.md stating them',
    ]);
  });

  test("keeps rejecting forbidden paths and a tarball with no LICENSE", () => {
    const { manifest, paths } = healthy();
    const problems = publishProblems(manifest, [
      ...paths.filter((path) => path !== "LICENSE"),
      "assets/font.woff2",
      "dist/app.js.map",
      "skills/.env",
      "skills/x/__pycache__/y.pyc",
      "node_modules/dep/index.js",
    ]).join("\n");
    expect(problems).toContain("assets/font.woff2");
    expect(problems).toContain("dist/app.js.map");
    expect(problems).toContain("skills/.env");
    expect(problems).toContain("__pycache__");
    expect(problems).toContain("node_modules");
    expect(problems).toContain("no LICENSE");
  });
});

describe("bbTargets", () => {
  test("strips a trailing /* from a skills root the way bb does", () => {
    const targets = bbTargets({
      name: "@smsunarto/bb-plugin-example",
      bb: { server: "./dist/server.js", skills: ["skills/*"] },
    });
    expect(targets).toContainEqual({
      label: "bb.skills",
      entry: "skills/*",
      tree: true,
    });
    // Explicitly: the "/*" must not be looked for as a literal file name.
    expect(
      publishProblems(
        {
          name: "@smsunarto/bb-plugin-example",
          license: "MIT",
          files: ["dist/"],
          description: "x",
          repository: "x",
          author: "x",
          publishConfig: { access: "public" },
          bb: { server: "./dist/server.js", skills: ["skills/*"] },
        },
        ["LICENSE", "dist/server.js", "dist/server.meta.json", "skills/a/SKILL.md"],
      ),
    ).toEqual([]);
  });
});

describe("nonRegistryProtocol", () => {
  test("names the protocol of a spec npm cannot resolve from the registry", () => {
    expect(nonRegistryProtocol("^1.2.3")).toBeNull();
    expect(nonRegistryProtocol("latest")).toBeNull();
    expect(nonRegistryProtocol(">=1.0.0 <2.0.0")).toBeNull();
    expect(nonRegistryProtocol("npm:other@^1")).toBeNull();
    expect(nonRegistryProtocol("workspace:*")).toBe("workspace");
    expect(nonRegistryProtocol("file:./vendor/stub")).toBe("file");
    expect(nonRegistryProtocol("link:../peer")).toBe("link");
    expect(nonRegistryProtocol("portal:../peer")).toBe("portal");
    expect(nonRegistryProtocol("git+ssh://git@host/x.git")).toBe("git+ssh");
    expect(nonRegistryProtocol("github:owner/repo")).toBe("github");
    expect(nonRegistryProtocol("../sibling")).toBe("path");
    expect(nonRegistryProtocol("owner/repo")).toBe("github shorthand");
  });
});

// Every plugin ships under two registry names so the short one cannot be
// squatted. The mirror is only safe because both names collapse to one plugin
// id — if that ever stopped being true, the mirror would install a SECOND
// plugin rather than the same one, so the id equality is the real assertion.
describe("mirrorPackageName", () => {
  test("a scoped name mirrors to its unscoped twin", () => {
    expect(mirrorPackageName("@smsunarto/bb-plugin-notify")).toBe("bb-plugin-notify");
    expect(mirrorPackageName("@smsunarto/bb-plugin-gh-stack")).toBe("bb-plugin-gh-stack");
  });

  test("an already-unscoped name has no mirror, so it publishes once", () => {
    expect(mirrorPackageName("bb-plugin-notify")).toBeNull();
  });

  for (const plugin of workspacePlugins(join(import.meta.dir, ".."))) {
    test(`${plugin.directory} mirrors to a name bb reads as the same plugin`, () => {
      const mirror = mirrorPackageName(plugin.name);
      expect(mirror).toBe(`bb-plugin-${plugin.directory}`);
      expect(derivePluginId(mirror as string)).toBe(plugin.id);
    });
  }
});

describe("publishPackageVersion", () => {
  test("waits for a successful publish to become readable", async () => {
    const states: RegistryVersionState[] = [
      { kind: "missing" },
      { kind: "missing" },
      { kind: "published" },
    ];
    let probeIndex = 0;
    const probe = mock(
      (): RegistryVersionState => states[probeIndex++] ?? { kind: "published" },
    );
    const publish = mock(() => {});
    const sleep = mock(async (_milliseconds: number) => {});

    const result = await publishPackageVersion({
      packageVersion: "bb-plugin-agent-proxy@0.2.4",
      probe,
      publish,
      sleep,
      retryDelays: [0, 1],
    });

    expect(result).toEqual({ kind: "published" });
    expect(probe.mock.calls).toHaveLength(3);
    expect(publish.mock.calls).toHaveLength(1);
    expect(sleep.mock.calls).toEqual([[0], [1]]);
  });

  test("reconciles a duplicate publish after delayed registry visibility", async () => {
    const states: RegistryVersionState[] = [
      { kind: "missing" },
      { kind: "missing" },
      { kind: "published" },
    ];
    let probeIndex = 0;
    const probe = mock(
      (): RegistryVersionState => states[probeIndex++] ?? { kind: "published" },
    );
    const publish = mock(() => {
      throw new Error("npm error code E403: version already published");
    });
    const sleep = mock(async (_milliseconds: number) => {});

    const result = await publishPackageVersion({
      packageVersion: "bb-plugin-agent-proxy@0.2.4",
      probe,
      publish,
      sleep,
      retryDelays: [0, 1],
    });

    expect(result).toEqual({ kind: "reconciled" });
    expect(probe.mock.calls).toHaveLength(3);
    expect(publish.mock.calls).toHaveLength(1);
    expect(sleep.mock.calls).toEqual([[0], [1]]);
  });

  test("does not publish when the registry probe itself fails", async () => {
    const registryError = new Error("npm error code E500");
    const probe = mock((): RegistryVersionState => {
      throw registryError;
    });
    const publish = mock(() => {});
    const sleep = mock(async (_milliseconds: number) => {});

    await expect(
      publishPackageVersion({
        packageVersion: "bb-plugin-agent-proxy@0.2.4",
        probe,
        publish,
        sleep,
        retryDelays: [0],
      }),
    ).rejects.toBe(registryError);
    expect(publish.mock.calls).toHaveLength(0);
    expect(sleep.mock.calls).toHaveLength(0);
  });
});

describe("npmViewFailureIsMissing", () => {
  test("treats only npm E404 as an unpublished version", () => {
    expect(npmViewFailureIsMissing("npm error code E404")).toBeTrue();
    expect(npmViewFailureIsMissing("npm error code E403")).toBeFalse();
    expect(npmViewFailureIsMissing("npm error code E500")).toBeFalse();
  });
});

// `bun pm pack` has no --json, so the gate parses its prose. If that parse
// ever silently returns nothing, every "must not ship" check below it passes
// vacuously — so the failure modes matter more than the happy path.
describe("packedPaths", () => {
  const real = [
    "bun pack v1.3.14 (0d9b296a)",
    "",
    "packed 2.1KB package.json",
    "packed 1.1KB LICENSE",
    "packed 510B server.ts",
    "packed 18.45KB themes/bb-monokai.css",
    "",
    "smsunarto-bb-plugin-monokai-0.1.0.tgz",
    "",
    "Total files: 4",
    "Unpacked size: 38.83KB",
  ].join("\n");

  test("reads the paths out of real `bun pm pack --dry-run` output", () => {
    expect(packedPaths(real)).toEqual([
      "package.json",
      "LICENSE",
      "server.ts",
      "themes/bb-monokai.css",
    ]);
  });

  test("keeps the tarball name and size lines out of the file list", () => {
    expect(packedPaths(real)).not.toContain("smsunarto-bb-plugin-monokai-0.1.0.tgz");
  });

  test("throws when the count disagrees with bun's own total", () => {
    const truncated = real.replace("packed 510B server.ts\n", "");
    expect(() => packedPaths(truncated)).toThrow(/parsed 3 packed paths but/);
  });

  test("throws rather than returning nothing when the format changes", () => {
    expect(() => packedPaths("bun pack v2\n\nsome new format\n")).toThrow(/Total files/);
  });
});
