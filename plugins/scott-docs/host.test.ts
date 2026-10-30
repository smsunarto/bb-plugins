import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExperimentalHostWatchListener,
  ExperimentalHostWatchOptions,
} from "@get-bb/plugin-sdk/host";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "./host.js";

const temporaryDirectories: string[] = [];

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Docs host path listing", () => {
  it("keeps authored hidden trees and skips generated, dependency, metadata, and symlink trees", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-docs-host-"));
    temporaryDirectories.push(root);
    await Promise.all([
      mkdir(path.join(root, ".dotfiles", ".agents"), { recursive: true }),
      mkdir(path.join(root, ".agents"), { recursive: true }),
      mkdir(path.join(root, ".claude"), { recursive: true }),
      mkdir(path.join(root, ".claude", "worktrees", "checkout"), { recursive: true }),
      mkdir(path.join(root, ".git"), { recursive: true }),
      mkdir(path.join(root, "node_modules", "package"), { recursive: true }),
      mkdir(path.join(root, ".node_modules", "package"), { recursive: true }),
      mkdir(path.join(root, ".ruff_cache", "0.16.4"), { recursive: true }),
      mkdir(path.join(root, ".scratch"), { recursive: true }),
      mkdir(path.join(root, "dist"), { recursive: true }),
      mkdir(path.join(root, "outside"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(root, ".dotfiles", ".agents", "instructions.md"), "# Rules"),
      writeFile(path.join(root, ".agents", "AGENTS.md"), "# Agents"),
      writeFile(path.join(root, ".claude", "CLAUDE.md"), "# Claude"),
      writeFile(path.join(root, ".claude", "worktrees", "checkout", "AGENTS.md"), "# Generated"),
      writeFile(path.join(root, ".git", "config"), "[core]"),
      writeFile(path.join(root, "node_modules", "package", "README.md"), "# Package"),
      writeFile(path.join(root, ".node_modules", "package", "README.md"), "# Package"),
      writeFile(path.join(root, ".ruff_cache", "0.16.4", "README.md"), "# Cache"),
      writeFile(path.join(root, ".scratch", "notes.md"), "# Scratch"),
      writeFile(path.join(root, "dist", "README.md"), "# Build output"),
      writeFile(path.join(root, "outside", "linked.md"), "# Linked"),
    ]);
    await symlink(path.join(root, "outside"), path.join(root, "linked"));

    const host = experimental_createHostEntryHarness(hostEntry);
    const result = await host.experimental_call("listPaths", {
      path: root,
      includeFiles: true,
      includeDirectories: true,
      limit: 100,
    });
    await host.experimental_dispose();

    expect(result).toMatchObject({ truncated: false });
    expect(result.paths.map(({ kind, path: listedPath }) => ({ kind, path: listedPath }))).toEqual(
      expect.arrayContaining([
        { kind: "directory", path: ".dotfiles" },
        { kind: "directory", path: ".dotfiles/.agents" },
        { kind: "file", path: ".dotfiles/.agents/instructions.md" },
        { kind: "directory", path: ".agents" },
        { kind: "file", path: ".agents/AGENTS.md" },
        { kind: "directory", path: ".claude" },
        { kind: "file", path: ".claude/CLAUDE.md" },
      ]),
    );
    for (const excludedPath of [
      ".claude/worktrees",
      ".git",
      ".node_modules",
      ".ruff_cache",
      ".scratch",
      "dist",
      "node_modules",
    ]) {
      expect(result.paths.some((entry) => entry.path.startsWith(excludedPath))).toBe(false);
    }
    expect(result.paths.some((entry) => entry.path.startsWith("linked"))).toBe(false);
  });
});

describe("Docs host vault roots", () => {
  it("rejects a missing vault root instead of listing it as empty", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-docs-host-"));
    temporaryDirectories.push(root);
    const missing = path.join(root, "obsidian-vault");

    const host = experimental_createHostEntryHarness(hostEntry);
    await expect(
      host.experimental_call("listPaths", {
        path: missing,
        includeFiles: true,
        includeDirectories: true,
        limit: 100,
      }),
    ).rejects.toThrow(`Folder not found: ${missing}`);
    await host.experimental_dispose();
  });

  it("reports each file's modification time and size", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-docs-host-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "plan.md"), "# Plan");
    await utimes(path.join(root, "plan.md"), 1_700_000_000, 1_700_000_000);

    const host = experimental_createHostEntryHarness(hostEntry);
    const result = await host.experimental_call("listPaths", {
      path: root,
      includeFiles: true,
      includeDirectories: true,
      limit: 100,
    });
    await host.experimental_dispose();

    expect(result).toEqual({
      paths: [{ kind: "file", path: "plan.md", modifiedAtMs: 1_700_000_000_000, sizeBytes: 6 }],
      truncated: false,
    });
  });

  it("lists a note whose modification time is before 1970", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-docs-host-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "old.md"), "# Old");
    // Node treats a negative number as "now", so pass a Date.
    const before1970 = new Date(-86_400_000);
    await utimes(path.join(root, "old.md"), before1970, before1970);

    const host = experimental_createHostEntryHarness(hostEntry);
    const result = await host.experimental_call("listPaths", {
      path: root,
      includeFiles: true,
      includeDirectories: true,
      limit: 100,
    });
    await host.experimental_dispose();

    expect(result).toEqual({
      paths: [{ kind: "file", path: "old.md", modifiedAtMs: -86_400_000, sizeBytes: 5 }],
      truncated: false,
    });
  });
});

describe("Docs host vault watching", () => {
  it("signals authored changes and ignores dependency and metadata trees", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-docs-host-"));
    temporaryDirectories.push(root);
    const listeners: ExperimentalHostWatchListener[] = [];
    const watched: ExperimentalHostWatchOptions[] = [];
    const dispose = vi.fn(async () => {});
    const host = experimental_createHostEntryHarness(hostEntry, {
      experimental_watch: (options, listener) => {
        watched.push(options);
        listeners.push(listener);
        return { dispose };
      },
    });

    await expect(
      host.experimental_call("watchVault", { vaultId: "obsidian", rootPath: root }),
    ).resolves.toEqual({ ok: true });
    expect(watched).toMatchObject([{ rootPath: root, debounceMs: 250 }]);
    expect(watched[0]?.ignoredPaths).toEqual(
      expect.arrayContaining(["**/node_modules/**", "**/.git/**", "**/.claude/worktrees/**"]),
    );

    await listeners[0]!({
      kind: "changed",
      changes: [
        { path: path.join(root, "node_modules", "pkg", "README.md"), type: "update" },
        { path: path.join(root, ".git", "index"), type: "update" },
      ],
    });
    await mkdir(path.join(root, "notes"));
    await writeFile(path.join(root, "notes", "plan.md"), "# Plan");
    // An attachment is never a note this server saved, so it is not read to hash.
    await writeFile(path.join(root, "notes", "scan.png"), Buffer.alloc(2 * 1024 * 1024));
    await listeners[0]!({
      kind: "changed",
      changes: [
        { path: path.join(root, "notes", "plan.md"), type: "update" },
        { path: path.join(root, "notes", "scan.png"), type: "create" },
        { path: path.join(root, "notes", "gone.md"), type: "delete" },
      ],
    });
    await listeners[0]!({ kind: "rescan-required" });
    // Each change names its path and new hash, so the server can drop the
    // echo of its own save and documents can skip unrelated paths.
    expect(host.experimental_getSignals()).toEqual([
      {
        signal: "vaultChanged",
        payload: {
          vaultId: "obsidian",
          kind: "changed",
          changes: [
            { path: "notes/plan.md", sha256: sha256("# Plan") },
            { path: "notes/scan.png", sha256: null },
            { path: "notes/gone.md", sha256: null },
          ],
        },
      },
      { signal: "vaultChanged", payload: { vaultId: "obsidian", kind: "rescan-required" } },
    ]);

    await host.experimental_call("unwatchVault", { vaultId: "obsidian" });
    expect(dispose).toHaveBeenCalledOnce();
    await host.experimental_dispose();
  });

  it("refuses to watch a vault root that does not exist on this host", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-docs-host-"));
    temporaryDirectories.push(root);
    const missing = path.join(root, "dotfiles");
    const watch = vi.fn();
    const host = experimental_createHostEntryHarness(hostEntry, { experimental_watch: watch });

    await expect(
      host.experimental_call("watchVault", { vaultId: "dotfiles", rootPath: missing }),
    ).rejects.toThrow(`Folder not found: ${missing}`);
    expect(watch).not.toHaveBeenCalled();
    await host.experimental_dispose();
  });

  it("reports the watches it holds and drops one whose folder is gone", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-docs-host-"));
    temporaryDirectories.push(root);
    const obsidian = path.join(root, "obsidian");
    const dotfiles = path.join(root, "dotfiles");
    await Promise.all([mkdir(obsidian), mkdir(dotfiles)]);
    const disposed: string[] = [];
    const host = experimental_createHostEntryHarness(hostEntry, {
      experimental_watch: (options) => ({
        dispose: async () => {
          disposed.push(options.rootPath);
        },
      }),
    });
    await host.experimental_call("watchVault", { vaultId: "obsidian", rootPath: obsidian });
    await host.experimental_call("watchVault", { vaultId: "dotfiles", rootPath: dotfiles });

    await expect(
      host.experimental_call("watchAlive", { vaultIds: ["obsidian", "dotfiles", "notes"] }),
    ).resolves.toEqual({ live: ["obsidian", "dotfiles"] });

    await rm(dotfiles, { recursive: true });
    await expect(
      host.experimental_call("watchAlive", { vaultIds: ["obsidian", "dotfiles"] }),
    ).resolves.toEqual({ live: ["obsidian"] });
    expect(disposed).toEqual([dotfiles]);
    await host.experimental_dispose();
  });
});

describe("Docs host opened-file watching", () => {
  it("signals the watched file's new hash, ignores its siblings and subfolders, and answers the hash on renewal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-docs-host-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "plan.md");
    await writeFile(filePath, "# Plan");
    await mkdir(path.join(root, "nested"));
    const daemonWatch = vi.fn(() => ({ dispose: async () => {} }));
    const host = experimental_createHostEntryHarness(hostEntry, {
      experimental_watch: daemonWatch,
    });
    const watch = { watchId: "w1", path: filePath, leaseMs: 60_000 };

    await expect(host.experimental_call("watchFile", watch)).resolves.toEqual({
      sha256: sha256("# Plan"),
    });
    // One folder, watched in this worker: the daemon's watcher would take the
    // whole tree under it, which for ~/AGENTS.md is $HOME.
    expect(daemonWatch).not.toHaveBeenCalled();
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);

    await writeFile(path.join(root, "other.md"), "# Other");
    await writeFile(path.join(root, "nested", "plan.md"), "# Nested");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(host.experimental_getSignals()).toEqual([]);

    await writeFile(filePath, "# Plan\n\nAgent rewrite");
    await vi.waitFor(() =>
      expect(host.experimental_getSignals()).toEqual([
        {
          signal: "fileChanged",
          payload: { watchId: "w1", sha256: sha256("# Plan\n\nAgent rewrite") },
        },
      ]),
    );

    // Renewing keeps the one watch and answers the current hash.
    await expect(host.experimental_call("watchFile", watch)).resolves.toEqual({
      sha256: sha256("# Plan\n\nAgent rewrite"),
    });
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    await host.experimental_dispose();
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(0);
  });

  it("keeps one watch and one worker lease when two renewals of a watch overlap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-docs-host-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "plan.md");
    await writeFile(filePath, "# Plan");
    const host = experimental_createHostEntryHarness(hostEntry);
    const watch = { watchId: "w1", path: filePath, leaseMs: 60_000 };

    await expect(
      Promise.all([
        host.experimental_call("watchFile", watch),
        host.experimental_call("watchFile", watch),
      ]),
    ).resolves.toEqual([{ sha256: sha256("# Plan") }, { sha256: sha256("# Plan") }]);
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    await host.experimental_dispose();
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(0);
  });

  it("drops a watch whose lease lapses", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-docs-host-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "plan.md");
    await writeFile(filePath, "# Plan");
    const host = experimental_createHostEntryHarness(hostEntry);
    await host.experimental_call("watchFile", { watchId: "w1", path: filePath, leaseMs: 1_000 });
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    await writeFile(filePath, "# After");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(host.experimental_getSignals()).toEqual([]);
    await host.experimental_dispose();
  });

  it("reports whether a file exists without reading it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-docs-host-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "plan.md"), "# Plan");
    const host = experimental_createHostEntryHarness(hostEntry);
    await expect(
      host.experimental_call("statFile", { path: path.join(root, "plan.md") }),
    ).resolves.toMatchObject({ file: { sizeBytes: 6 } });
    await expect(
      host.experimental_call("statFile", { path: path.join(root, "missing.md") }),
    ).resolves.toEqual({ file: null });
    await host.experimental_dispose();
  });
});
