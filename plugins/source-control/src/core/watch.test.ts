import { expect, test } from "vitest";
import { parsePrLink, prLookup, prUrl } from "./watch.ts";

const PR = "https://github.com/Acme/API/pull/12";

test("only a link to a pull request itself is one Review can show", () => {
  expect(parsePrLink(PR)).toEqual({ owner: "Acme", repo: "API", number: 12 });
  expect(parsePrLink(`${PR}/`)).toEqual({ owner: "Acme", repo: "API", number: 12 });
  expect(parsePrLink("https://www.github.com/acme/api/pull/3")).toMatchObject({ number: 3 });
  for (const other of [
    `${PR}/files`,
    `${PR}/commits/abc1234`,
    `${PR}#issuecomment-1`,
    `${PR}?w=1`,
    "https://github.com/acme/api/issues/12",
    "https://gitlab.com/acme/api/pull/12",
    "http://github.com/acme/api/pull/12",
    "acme/api#12",
    "https://github.com/acme/api/pull/0",
  ])
    expect(parsePrLink(other)).toBeNull();
});

test("a pull request's page and lookup key, whatever its case", () => {
  const ref = { owner: "Acme", repo: "API", number: 12 };
  expect(prUrl(ref)).toBe(PR);
  expect(parsePrLink(prUrl(ref))).toEqual(ref);
  expect(prLookup(ref)).toBe("pr:acme/api#12");
});
