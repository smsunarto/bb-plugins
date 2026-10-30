import { expect, test } from "bun:test";
import { fakeContext, runnerFrom } from "../../../test/fake-gh.ts";
import { createGitHub } from "../lib/gh.ts";
import { status } from "./status.ts";

test("names every signed-in account, the active one first", async () => {
  const { ctx } = fakeContext({ accounts: ["sms-yui", "smsunarto"] });
  expect(await status(ctx)).toEqual({
    ok: true,
    login: "sms-yui",
    accounts: ["sms-yui", "smsunarto"],
  });
});

test("says what is wrong instead of throwing", async () => {
  const answer = (stderr: string, code?: number) => {
    const fail = runnerFrom(async () => ({ code: code ?? 1, stdout: "", stderr }));
    return status({ ...fakeContext().ctx, github: createGitHub(fail) });
  };

  expect(await answer("ENOENT: gh not found", 127)).toEqual({
    ok: false,
    reason: "gh-missing",
    message:
      "GitHub CLI (gh) is not installed on the bb server's machine. Install it from https://cli.github.com.",
  });
  expect(await answer("To get started with GitHub CLI, please run:  gh auth login")).toEqual({
    ok: false,
    reason: "unauthenticated",
    message: "GitHub CLI is not signed in. Run `gh auth login`.",
  });
  expect(await answer("gh: error connecting to api.github.com")).toEqual({
    ok: false,
    reason: "failed",
    message: "error connecting to api.github.com",
  });
});
