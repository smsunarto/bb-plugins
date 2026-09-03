import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  prepareSentryRelease,
  requireSentryUploadCredentials,
  uploadSentryRelease,
} from "./sentry-release.ts";
import { PLUGIN_TELEMETRY as dotfilesTelemetry } from "../plugins/dotfiles/shared/telemetry.ts";
import { PLUGIN_TELEMETRY as ampTelemetry } from "../plugins/amp/shared/telemetry.ts";
import { PLUGIN_TELEMETRY as nanocodexTelemetry } from "../plugins/nanocodex/shared/telemetry.ts";
import { PLUGIN_TELEMETRY as notifyTelemetry } from "../plugins/notify/shared/telemetry.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SENTRY_CLI = join(ROOT, "node_modules", ".bin", "sentry-cli");

describe("Sentry release artifacts", () => {
  test("injects matching Debug IDs, restamps host metadata, and stages private maps", () => {
    const fixture = createPluginFixture();
    try {
      const prepared = prepareSentryRelease(fixture.pluginDir, SENTRY_CLI);
      try {
        expect(prepared.release).toBe("bb-plugin-amp@1.2.3");
        expect(prepared.files.map((path) => basename(path)).sort()).toEqual([
          "app.js",
          "app.js.map",
          "host.js",
          "host.js.map",
          "server.js",
          "server.js.map",
        ]);
        for (const name of ["app", "host", "server"]) {
          const bundle = readFileSync(join(prepared.stageDir, `${name}.js`), "utf8");
          const map = JSON.parse(
            readFileSync(join(prepared.stageDir, `${name}.js.map`), "utf8"),
          ) as Record<string, unknown>;
          const bundleId = /\/\/# debugId=([0-9a-f-]+)/iu.exec(bundle)?.[1];
          expect(bundleId).toMatch(/^[0-9a-f-]{36}$/iu);
          expect(map.debugId ?? map.debug_id).toBe(bundleId);
          expect(map).not.toHaveProperty("sourcesContent");
        }
        const host = join(fixture.pluginDir, "dist", "host.js");
        const meta = JSON.parse(
          readFileSync(join(fixture.pluginDir, "dist", "host.meta.json"), "utf8"),
        ) as { artifactDigest: string };
        expect(meta.artifactDigest).toBe(sha256(host));
        expect(prepared.artifactDigest).toBe(meta.artifactDigest);
      } finally {
        prepared.cleanup();
      }

      const before = artifactHashes(fixture.pluginDir);
      const repeated = prepareSentryRelease(fixture.pluginDir, SENTRY_CLI);
      repeated.cleanup();
      expect(artifactHashes(fixture.pluginDir)).toEqual(before);
    } finally {
      fixture.cleanup();
    }
  });

  test("stages only the server pair for plugins without app or host bundles", () => {
    const fixture = createPluginFixture({ app: false, host: false });
    try {
      const prepared = prepareSentryRelease(fixture.pluginDir, SENTRY_CLI);
      try {
        expect(prepared.release).toBe("bb-plugin-amp@1.2.3");
        expect(prepared.artifactDigest).toBeUndefined();
        expect(prepared.files.map((path) => basename(path)).sort()).toEqual([
          "server.js",
          "server.js.map",
        ]);
      } finally {
        prepared.cleanup();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test("requires every upload credential before artifact preparation", () => {
    expect(() => requireSentryUploadCredentials({})).toThrow(
      /SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT/u,
    );
    expect(() =>
      requireSentryUploadCredentials({
        SENTRY_AUTH_TOKEN: "token",
        SENTRY_ORG: "org",
      }),
    ).toThrow(/SENTRY_PROJECT/u);
    expect(
      requireSentryUploadCredentials({
        SENTRY_AUTH_TOKEN: " token ",
        SENTRY_ORG: " org ",
        SENTRY_PROJECT: " project ",
      }),
    ).toEqual({ SENTRY_AUTH_TOKEN: "token", SENTRY_ORG: "org", SENTRY_PROJECT: "project" });
  });

  test("rejects artifact metadata that drifts from the plugin manifest", () => {
    const wrongVersion = createPluginFixture({ manifestVersion: "1.2.4" });
    try {
      expect(() =>
        prepareSentryRelease(wrongVersion.pluginDir, join(wrongVersion.pluginDir, "missing-cli")),
      ).toThrow(/server\.meta\.json version 1\.2\.3 does not match package version 1\.2\.4/u);
    } finally {
      wrongVersion.cleanup();
    }

    const wrongName = createPluginFixture({ manifestName: "@smsunarto/bb-plugin-other" });
    try {
      expect(() =>
        prepareSentryRelease(wrongName.pluginDir, join(wrongName.pluginDir, "missing-cli")),
      ).toThrow(/server\.meta\.json plugin amp does not match package plugin other/u);
    } finally {
      wrongName.cleanup();
    }
  });

  test("rejects a staged map that cannot resolve to a TypeScript source", () => {
    const fixture = createPluginFixture();
    const mapPath = join(fixture.pluginDir, "dist", "host.js.map");
    const map = JSON.parse(readFileSync(mapPath, "utf8")) as Record<string, unknown>;
    map.sources = ["../src/not-the-entry.js"];
    writeFileSync(mapPath, JSON.stringify(map));
    try {
      expect(() => prepareSentryRelease(fixture.pluginDir, SENTRY_CLI)).toThrow(
        /host\.js\.map cannot resolve any position to a TypeScript source/u,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test("uploads the private stage with release-safe CLI flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-sentry-upload-test-"));
    const capturePath = join(dir, "capture.json");
    const cliPath = join(dir, "sentry-cli");
    writeFileSync(
      cliPath,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ argv: process.argv.slice(2), hasToken: Boolean(process.env.SENTRY_AUTH_TOKEN), org: process.env.SENTRY_ORG, project: process.env.SENTRY_PROJECT }));\n`,
    );
    chmodSync(cliPath, 0o755);
    try {
      uploadSentryRelease(
        {
          release: "bb-plugin-amp@1.2.3",
          stageDir: "/private/stage",
          artifactDigest: "digest",
          files: [],
          cleanup() {},
        },
        { SENTRY_AUTH_TOKEN: "private", SENTRY_ORG: "org", SENTRY_PROJECT: "project" },
        cliPath,
      );
      const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
        argv: string[];
        hasToken: boolean;
        org: string;
        project: string;
      };
      expect(capture.argv).toEqual([
        "sourcemaps",
        "upload",
        "/private/stage",
        "--release",
        "bb-plugin-amp@1.2.3",
        "--no-rewrite",
        "--validate",
        "--strict",
        "--wait",
      ]);
      expect(capture).toMatchObject({ hasToken: true, org: "org", project: "project" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("the release workflow uploads plugin maps after build and before publish", () => {
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "release.yaml"), "utf8");
  const build = workflow.indexOf("name: Build released package");
  const upload = workflow.indexOf("name: Upload plugin source maps");
  const publish = workflow.indexOf("name: Publish package");
  expect(build).toBeGreaterThan(-1);
  expect(upload).toBeGreaterThan(build);
  expect(publish).toBeGreaterThan(upload);
  expect(workflow).toContain("SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}");
  expect(workflow).toContain("SENTRY_ORG: ${{ vars.SENTRY_ORG }}");
  expect(workflow).not.toContain("SENTRY_PROJECT: ${{ vars.SENTRY_PROJECT }}");
  for (const plugin of ["amp", "dotfiles", "nanocodex", "notify"]) {
    expect(workflow.slice(upload, publish)).toContain(`plugins/${plugin}`);
    expect(workflow.slice(upload, publish)).toContain(`SENTRY_PROJECT=bb-plugin-${plugin}`);
  }
  expect(workflow.slice(upload, publish)).not.toContain("plugins/gitbutler");
});

test("telemetry identities match their plugin manifests", () => {
  const plugins = [
    ["amp", ampTelemetry],
    ["dotfiles", dotfilesTelemetry],
    ["nanocodex", nanocodexTelemetry],
    ["notify", notifyTelemetry],
  ] as const;
  for (const [plugin, telemetry] of plugins) {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "plugins", plugin, "package.json"), "utf8"),
    ) as { name: string; version: string };
    expect(telemetry.pluginId).toBe(plugin);
    expect(String(telemetry.pluginVersion)).toBe(manifest.version);
    expect(telemetry.dsn).toMatch(/^https:\/\/.+@.+\.sentry\.io\/[0-9]+$/u);
    expect(manifest.name).toBe(`@smsunarto/bb-plugin-${plugin}`);
  }
  expect(new Set(plugins.map(([, telemetry]) => telemetry.dsn)).size).toBe(plugins.length);
});

test("Amp's npm allowlist keeps source maps out of both published package names", () => {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "plugins", "amp", "package.json"), "utf8"),
  ) as {
    files: string[];
  };
  expect(manifest.files.some((path) => path === "dist/" || path.endsWith(".map"))).toBe(false);
});

function createPluginFixture(
  options: Readonly<{
    manifestName?: string;
    manifestVersion?: string;
    app?: boolean;
    host?: boolean;
  }> = {},
): { pluginDir: string; cleanup(): void } {
  const pluginDir = mkdtempSync(join(tmpdir(), "bb-sentry-release-test-"));
  const distDir = join(pluginDir, "dist");
  mkdirSync(distDir);
  const bundles = [
    ...(options.app === false ? [] : ["app"]),
    ...(options.host === false ? [] : ["host"]),
    "server",
  ];
  for (const name of bundles) {
    writeFileSync(
      join(distDir, `${name}.js`),
      `function ${name}(){return ${JSON.stringify(name)}}\nconsole.log(${name}())\n//# sourceMappingURL=${name}.js.map\n`,
    );
    writeFileSync(
      join(distDir, `${name}.js.map`),
      JSON.stringify({
        version: 3,
        sources: [
          name === "app"
            ? "../app/app.tsx"
            : name === "host"
              ? "../src/bridge/entry.ts"
              : "../src/server.ts",
        ],
        sourcesContent: [`export const ${name} = ${JSON.stringify(name)};`],
        names: [],
        mappings: "AAAA;AACA",
      }),
    );
    writeFileSync(
      join(distDir, `${name}.meta.json`),
      JSON.stringify({
        artifactFormatVersion: 1,
        pluginId: "amp",
        pluginVersion: "1.2.3",
        ...(name === "host" ? { artifactDigest: "before-injection" } : {}),
      }),
    );
  }
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify({
      name: options.manifestName ?? "@smsunarto/bb-plugin-amp",
      version: options.manifestVersion ?? "1.2.3",
    }),
  );
  return {
    pluginDir,
    cleanup: () => rmSync(pluginDir, { recursive: true, force: true }),
  };
}

function artifactHashes(pluginDir: string): Record<string, string> {
  return Object.fromEntries(
    ["app.js", "app.js.map", "host.js", "host.js.map", "server.js", "server.js.map"].map((name) => [
      name,
      sha256(join(pluginDir, "dist", name)),
    ]),
  );
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
