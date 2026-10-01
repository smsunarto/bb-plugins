import { createFakePluginHost, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { createFakeGit, type FakeDotfilesGit } from "./fake-git.ts";
import type { DotfilesGit, GitContext } from "./git.ts";

export interface FakeContext extends GitContext {
  readonly git: FakeDotfilesGit;
  /** The fake host behind `bb`, for assertions such as `logEntries`. */
  readonly harness: FakePluginHarness;
}

/** The `{ bb, git }` a handler receives, over a fake host and a fake git. */
export function createFakeContext(git: Partial<DotfilesGit> = {}): FakeContext {
  const { bb, harness } = createFakePluginHost({ pluginId: "dotfiles" });
  return { bb, git: createFakeGit(git), harness };
}
