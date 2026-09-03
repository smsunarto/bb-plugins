import { expect, test } from "bun:test";

test("the embed proxy presents Laminar's configured auth origin", async () => {
  const caddyfile = await Bun.file(new URL("./Caddyfile", import.meta.url)).text();

  expect(caddyfile).toContain("header_up Origin http://localhost:5667");
});
