import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhiteboardHostResolver } from "../host-resolver.ts";
import { openLocalReviewStore } from "../vendor/review/src/review-api/local-data.ts";
import { HostUnavailableError, installHostClient, invokeHost } from "./client.ts";
import { REPO_CONTEXT_RETRY_MS, resolveRepoContextSync } from "./local-vcs.ts";
import { defaultPullRequestDeps } from "./pull-request.ts";
import { IN_PROCESS_HOST_ID, createInProcessHostClient } from "./testing/in-process.ts";

const MAC = "host_mac";
const url = "https://github.com/acme/widget/pull/7";

/** bb's `ApiError` shape: a disconnected host, a host that never answered, a daemon's own failure. */
const transportError = (status: number, code: string, message = code) =>
  Object.assign(new Error(message), { status, body: { code, message } });

let directory: string;
/** Checkouts under this directory live on the Mac; everything else on the in-process host. */
let macRoot: string;
const offline = new Map<string, Error>();
const attempts: Array<{ hostId: string; fn?: string }> = [];
let uninstall: () => void;

beforeEach(() => {
  directory = realpathSync(mkdtempSync(path.join(tmpdir(), "whiteboard-offline-")));
  macRoot = path.join(directory, "mac");
  mkdirSync(macRoot);
  offline.clear();
  attempts.length = 0;
  const inProcess = createInProcessHostClient();
  const client = {
    ...inProcess,
    call: (method: string, input: unknown, options: { hostId: string }) => {
      attempts.push({ hostId: options.hostId, fn: (input as { fn?: string }).fn });
      const failure = offline.get(options.hostId);
      if (failure) return Promise.reject(failure);
      return inProcess.call(method as never, input as never, options);
    },
  } as typeof inProcess;
  const onMac = (rootPath?: string) =>
    rootPath !== undefined && path.resolve(rootPath).startsWith(macRoot);
  const resolver: WhiteboardHostResolver = {
    hostFor: async ({ rootPath }) => (onMac(rootPath) ? MAC : IN_PROCESS_HOST_ID),
    bindRepository: async () => {},
    rememberPath: () => {},
    callerHost: async () => IN_PROCESS_HOST_ID,
    boundHosts: () => [MAC, IN_PROCESS_HOST_ID],
    hostName: async (hostId) => (hostId === MAC ? "Personal Mac" : hostId),
  };
  uninstall = installHostClient(client, resolver);
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstall();
  rmSync(directory, { recursive: true, force: true });
});

describe("a host bb cannot reach", () => {
  it("fails with the machine's name, not bb's transport error", async () => {
    offline.set(MAC, transportError(502, "host_unavailable"));
    const disconnected = await invokeHost("fs", "exists", [macRoot], { rootPath: macRoot }).catch(
      (error: unknown) => error,
    );
    expect(disconnected).toBeInstanceOf(HostUnavailableError);
    expect(disconnected).toMatchObject({
      hostId: MAC,
      message:
        "Personal Mac is not connected to bb. Whiteboard reads this checkout on Personal Mac. Reconnect it, then retry.",
    });
    const timedOut =
      "Personal Mac did not answer in time. Whiteboard reads this checkout on Personal Mac. Check that it is awake and connected to bb, then retry.";
    offline.set(MAC, transportError(504, "command_timeout"));
    await expect(
      invokeHost("fs", "exists", [macRoot], { rootPath: macRoot }),
    ).rejects.toMatchObject({ message: timedOut });
    // The daemon's own deadline answers first, as a command failure.
    for (const message of [
      "host plugin call 0199c3f2-7a1b-7c3d-9e4f-5a6b7c8d9e0f reached its deadline before dispatch",
      "host plugin call 0199c3f2-7a1b-7c3d-9e4f-5a6b7c8d9e0f exceeded its deadline",
    ]) {
      offline.set(MAC, transportError(502, "command_failed", message));
      await expect(
        invokeHost("fs", "exists", [macRoot], { rootPath: macRoot }),
      ).rejects.toMatchObject({ name: "HostUnavailableError", message: timedOut });
    }
    // Any other command failure is the host entry's own error, unchanged.
    offline.set(MAC, transportError(502, "command_failed", "EACCES: permission denied"));
    await expect(
      invokeHost("fs", "exists", [macRoot], { rootPath: macRoot }),
    ).rejects.toMatchObject({ name: "Error", message: "EACCES: permission denied" });
  });

  it("is asked for a missing repository context at most once per retry window", async () => {
    offline.set(MAC, transportError(502, "host_unavailable"));
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const asks = () => attempts.filter((attempt) => attempt.fn === "resolveRepoContext").length;
    const checkout = path.join(macRoot, "repo");
    expect(resolveRepoContextSync(checkout)).toBeNull();
    expect(resolveRepoContextSync(checkout)).toBeNull();
    await vi.waitFor(() => expect(asks()).toBe(1));
    now.mockReturnValue(1_000_000 + REPO_CONTEXT_RETRY_MS);
    expect(resolveRepoContextSync(checkout)).toBeNull();
    await vi.waitFor(() => expect(asks()).toBe(2));
  });
});

describe("creating a Whiteboard from a pull request URL across hosts", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
    }).trim();

  /** A local repository stands in for github.com/acme/widget, with PR 7's head ref. */
  const upstream = () => {
    const root = path.join(directory, "upstream");
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Whiteboard Test");
    git(root, "config", "user.email", "whiteboard-test@example.invalid");
    writeFileSync(path.join(root, "base.ts"), "export const base = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "Base");
    git(root, "checkout", "-q", "-b", "feature");
    writeFileSync(path.join(root, "feature.ts"), "export const feature = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "Feature");
    git(root, "update-ref", "refs/pull/7/head", "HEAD");
    git(root, "checkout", "-q", "main");
    return root;
  };

  const clone = (source: string, target: string) => {
    git(directory, "clone", "-q", source, target);
    const gitDir = path.join(target, ".git");
    execFileSync("git", [
      "--git-dir",
      gitDir,
      "config",
      "remote.origin.url",
      "https://github.com/acme/widget.git",
    ]);
    execFileSync("git", [
      "--git-dir",
      gitDir,
      "config",
      `url.${source}.insteadOf`,
      "https://github.com/acme/widget.git",
    ]);
    return target;
  };

  const open = () =>
    openLocalReviewStore(path.join(directory, "reviews.db"), {
      manageWorkspaces: false,
      pullRequests: {
        ...defaultPullRequestDeps,
        run: async (file, args, options) =>
          file === "gh"
            ? JSON.stringify({ number: 7, title: "Add widgets", baseRefName: "main" })
            : defaultPullRequestDeps.run(file, args, options),
        fetch: () => Promise.reject(new Error("no network in tests")),
      },
    });

  const createFromUrl = (local: ReturnType<typeof open>) =>
    local.store.execute({
      commandId: randomUUID(),
      operation: { type: "create", pullRequestUrl: url },
    });

  it("skips a checkout whose host is offline and uses the next one", async () => {
    const source = upstream();
    const local = open();
    try {
      await local.data.register(clone(source, path.join(macRoot, "widget")));
      const reachable = await local.data.register(clone(source, path.join(directory, "widget")));
      offline.set(MAC, transportError(502, "host_unavailable"));
      const created = await createFromUrl(local);
      expect(local.store.read(created.reviewId)).toMatchObject({
        title: "Add widgets",
        pins: { repositoryId: reachable.id },
      });
    } finally {
      await local.store.close();
      await local.data.close();
    }
  });

  it("names the offline machine when no reachable checkout matches", async () => {
    const source = upstream();
    const local = open();
    try {
      await local.data.register(clone(source, path.join(macRoot, "widget")));
      offline.set(MAC, transportError(502, "host_unavailable"));
      await expect(createFromUrl(local)).rejects.toMatchObject({
        name: "HostUnavailableError",
        message:
          "Personal Mac is not connected to bb. Whiteboard reads this checkout on Personal Mac. Reconnect it, then retry.",
      });
    } finally {
      await local.store.close();
      await local.data.close();
    }
  });
});
