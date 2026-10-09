import { expect, test } from "bun:test";
import { GhFailure, fakeContext } from "../../../test/fake-gh.ts";
import { status } from "./status.ts";

test("names the signed-in account", async () => {
  const { ctx } = fakeContext({ rest: { user: { login: "sms-yui" } } });
  expect(await status.execute(ctx)).toEqual({ ok: true, login: "sms-yui" });
});

test("says what is wrong instead of throwing", async () => {
  const answer = (stderr: string, code?: number) =>
    status.execute(
      fakeContext({
        rest: {
          user: () => {
            throw new GhFailure(stderr, code);
          },
        },
      }).ctx,
    );

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
