import { stubHostContext } from "@bb-kit/core/testing";
import type { Context } from "@bb-kit/core/plugin";
import { provideFakeGit, type FakeDotfilesGit } from "./fake-git.ts";
import type { DotfilesGit } from "./git.ts";

export interface FakeContext extends Context {
  readonly git: FakeDotfilesGit;
}

export function createFakeContext(
  git: Partial<DotfilesGit> = {},
  options: { log?: (message: string) => void } = {},
): FakeContext {
  const context = stubHostContext();
  const bb = context.bb as { log?: { info(message: string): void } };
  bb.log = { info: options.log ?? (() => {}) };
  return {
    ...context,
    git: provideFakeGit(context.bb, git),
  };
}
