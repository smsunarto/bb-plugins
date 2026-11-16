import { expect, test } from "vitest";
import { GhError, type Exec } from "./github.ts";
import { readTimeline } from "./timeline.ts";

test("GitHub's GraphQL rate limit reads as a rate limit, not a failure", async () => {
  const exec: Exec = async () => ({
    code: 1,
    stderr: "",
    stdout: JSON.stringify({
      errors: [
        {
          type: "RATE_LIMIT",
          code: "graphql_rate_limit",
          message: "API rate limit already exceeded for user ID 1.",
        },
      ],
    }),
  });
  const read = readTimeline(exec, { owner: "acme", name: "api" }, 42);
  await expect(read).rejects.toBeInstanceOf(GhError);
  await expect(read).rejects.toMatchObject({ code: "rate-limited" });
});
