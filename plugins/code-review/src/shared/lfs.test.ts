import { expect, test } from "bun:test";
import { lfsFromPatch, parseLfsPointer } from "./lfs.ts";

const OID = "3de81c8fa10429766e005b1216577e39e407259209e3a698ab53aa35719c359a";
const OTHER = "0".repeat(63) + "1";
const pointer = (oid: string, size: number) =>
  `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}`;

test("only a pointer with a sha256 hex oid and a decimal size is Git LFS", () => {
  expect(parseLfsPointer(`${pointer(OID, 31)}\n`)).toEqual({ oid: OID, size: 31 });
  expect(parseLfsPointer(pointer("../../etc/passwd", 31))).toBeNull();
  expect(parseLfsPointer(pointer(OID, -1))).toBeNull();
  expect(parseLfsPointer("oid sha256:" + OID)).toBeNull();
});

test("both sides' pointers come back from a pointer's diff", () => {
  const patch = [
    "@@ -1,3 +1,3 @@",
    " version https://git-lfs.github.com/spec/v1",
    `-oid sha256:${OID}`,
    "-size 31",
    `+oid sha256:${OTHER}`,
    "+size 2048",
  ].join("\n");
  expect(lfsFromPatch(patch)).toEqual({
    base: { oid: OID, size: 31 },
    head: { oid: OTHER, size: 2048 },
  });
  const added = pointer(OID, 31)
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");
  expect(lfsFromPatch(`@@ -0,0 +1,3 @@\n${added}`)).toEqual({
    base: null,
    head: { oid: OID, size: 31 },
  });
  expect(lfsFromPatch("@@ -1 +1 @@\n-a\n+b")).toBeNull();
  expect(lfsFromPatch(null)).toBeNull();
});
