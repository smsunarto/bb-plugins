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
  const ctx = stubHostContext();
  const bb = ctx.bb as { log?: { info(message: string): void } };
  bb.log = { info: options.log ?? (() => {}) };
  return {
    ...ctx,
    git: provideFakeGit(ctx.bb, git),
  };
}
