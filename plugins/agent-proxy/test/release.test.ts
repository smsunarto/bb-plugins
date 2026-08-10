import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assetName,
  compareVersions,
  normalizeVersion,
  parseChecksums,
  parseRelease,
  pickAsset,
  releaseApiUrl,
} from "../lib/release.ts";

test("assetName maps platform/arch to upstream naming", () => {
  assert.equal(assetName("v7.2.121", "darwin", "arm64"), "CLIProxyAPI_7.2.121_darwin_aarch64.tar.gz");
  assert.equal(assetName("7.2.121", "linux", "x64"), "CLIProxyAPI_7.2.121_linux_amd64.tar.gz");
});

test("assetName rejects unsupported platforms and arches", () => {
  assert.throws(() => assetName("1.0.0", "win32", "x64"), /not supported/);
  assert.throws(() => assetName("1.0.0", "darwin", "ia32" as NodeJS.Architecture), /unsupported architecture/);
});

test("normalizeVersion strips a leading v only", () => {
  assert.equal(normalizeVersion("v6.5.2"), "6.5.2");
  assert.equal(normalizeVersion("6.5.2"), "6.5.2");
});

test("releaseApiUrl targets latest or a pinned tag", () => {
  assert.match(releaseApiUrl(), /releases\/latest$/);
  assert.match(releaseApiUrl("7.1.0"), /releases\/tags\/v7\.1\.0$/);
  assert.match(releaseApiUrl("v7.1.0"), /releases\/tags\/v7\.1\.0$/);
});

test("parseChecksums reads sha256 lines", () => {
  const map = parseChecksums(
    [
      "abc".padEnd(64, "0") + "  CLIProxyAPI_7.2.121_darwin_aarch64.tar.gz",
      "def".padEnd(64, "1") + " *CLIProxyAPI_7.2.121_linux_amd64.tar.gz",
      "not a checksum line",
      "",
    ].join("\n"),
  );
  assert.equal(map.get("CLIProxyAPI_7.2.121_darwin_aarch64.tar.gz"), "abc".padEnd(64, "0"));
  assert.equal(map.get("CLIProxyAPI_7.2.121_linux_amd64.tar.gz"), "def".padEnd(64, "1"));
  assert.equal(map.size, 2);
});

test("compareVersions is numeric per segment and tolerant of v", () => {
  assert.ok(compareVersions("6.10.0", "6.5.2") > 0);
  assert.ok(compareVersions("v6.5.2", "6.10.0") < 0);
  assert.equal(compareVersions("v7.2.121", "7.2.121"), 0);
  assert.ok(compareVersions("7.2.121.1", "7.2.121") > 0);
});

test("parseRelease extracts tag and usable assets", () => {
  const release = parseRelease({
    tag_name: "v7.2.121",
    assets: [
      { name: "checksums.txt", browser_download_url: "https://example.com/checksums.txt" },
      { name: "CLIProxyAPI_7.2.121_darwin_aarch64.tar.gz", browser_download_url: "https://example.com/a.tar.gz" },
      { bogus: true },
    ],
  });
  assert.equal(release.version, "7.2.121");
  assert.equal(release.assets.length, 2);
  assert.equal(pickAsset(release, "checksums.txt")?.url, "https://example.com/checksums.txt");
  assert.equal(pickAsset(release, "missing"), null);
});

test("parseRelease rejects malformed responses", () => {
  assert.throws(() => parseRelease(null), /malformed/);
  assert.throws(() => parseRelease({}), /tag_name/);
});
