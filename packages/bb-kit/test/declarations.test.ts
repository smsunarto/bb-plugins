import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("published declarations", () => {
  it("keep the operations boundary independent of the unpublished bb SDK", () => {
    const operations = readFileSync(
      join(import.meta.dirname, "../dist/operations.d.ts"),
      "utf8",
    );
    const standardSchema = readFileSync(
      join(import.meta.dirname, "../dist/standard-schema.d.ts"),
      "utf8",
    );
    expect(operations).not.toContain("@bb/plugin-sdk");
    expect(standardSchema).not.toContain("@bb/plugin-sdk");
  });
});
