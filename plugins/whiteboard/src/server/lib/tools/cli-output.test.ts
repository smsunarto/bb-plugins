import { expect, test } from "vitest";
import { capOutput } from "./cli-output.ts";

test("text under the cap is unchanged", () => {
  expect(capOutput("abc\n", 1024)).toBe("abc\n");
});

test("text over the cap is cut on a character boundary and says so", () => {
  // 600 two-byte characters: 1200 bytes against a 1024-byte cap.
  const text = "é".repeat(600);
  expect(capOutput(text, 1024)).toBe(
    `${"é".repeat(256)}\n[Output truncated: 512 of 1200 bytes shown. bb caps plugin CLI output at 1024 bytes; narrow the read to see the rest.]\n`,
  );
});

test("an odd cut point backs up to the start of the character", () => {
  const text = `a${"é".repeat(600)}`;
  expect(capOutput(text, 1024)).toBe(
    `a${"é".repeat(255)}\n[Output truncated: 511 of 1201 bytes shown. bb caps plugin CLI output at 1024 bytes; narrow the read to see the rest.]\n`,
  );
});
