import { expect, test } from "bun:test";
import { shares } from "./shares.ts";

test("the shares tool titles its timeline row instead of the generic tool name", () => {
  expect(shares.presentation).toEqual({
    label: { pending: "Managing Cloudflare shares", completed: "Managed Cloudflare shares" },
  });
});

test("the shares tool accepts every share action and rejects unknown ones", () => {
  for (const action of ["overview", "list"]) {
    expect(shares.parameters.safeParse({ action }).success).toBe(true);
  }
  expect(shares.parameters.safeParse({ action: "publish" }).success).toBe(false);
});
