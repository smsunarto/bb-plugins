import { test, expect, mock } from "bun:test";
import { z } from "zod";
import { CloudflareAPI, CloudflareError, appOverlaps, appSchema } from "./api.ts";

test("inventory follows pagination and rejects a truncated 5,000-resource result", async () => {
  const fetcher = mock(async (input: string | URL | Request) => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    return Response.json({
      success: true,
      result: [{ id: String(page) }],
      result_info: { total_pages: 2 },
    });
  });
  const api = new CloudflareAPI("secret", fetcher as typeof fetch);
  expect(await api.list("/accounts/account/access/apps", z.object({ id: z.string() }))).toEqual([
    { id: "1" },
    { id: "2" },
  ]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  const unbounded = mock(async () =>
    Response.json({
      success: true,
      result: Array.from({ length: 100 }, (_, id) => ({ id })),
      result_info: { total_pages: 51 },
    }),
  );
  await expect(
    new CloudflareAPI("secret", unbounded as typeof fetch).list(
      "/zones",
      z.object({ id: z.number() }),
    ),
  ).rejects.toThrow("exceeds 5,000");
  expect(unbounded).toHaveBeenCalledTimes(50);
});
test("network and invalid write responses are uncertain without leaking response text", async () => {
  for (const fetcher of [
    async () => {
      throw new Error("secret-token");
    },
    async () => new Response("secret-token"),
    async () => Response.json({ success: true, result: { token: "secret-token" } }),
  ]) {
    const api = new CloudflareAPI("secret-token", fetcher as typeof fetch);
    try {
      await api.request("POST", "/accounts/account/cfd_tunnel", z.object({ id: z.string() }), {});
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareError);
      expect((error as CloudflareError).uncertain).toBe(true);
      expect((error as Error).message).not.toContain("secret-token");
    }
  }
});
test("permission errors are actionable and never include provider payload", async () => {
  const api = new CloudflareAPI("secret-token", (async () =>
    Response.json({ errors: [{ message: "secret-token" }] }, { status: 403 })) as typeof fetch);
  await expect(api.list("/zones", z.unknown())).rejects.toThrow("Check token permissions");
});
test("successful HTTP still requires a valid success envelope", async () => {
  for (const result of [
    { result: [] },
    { success: false, result: [] },
    { success: true, result: {} },
  ]) {
    const api = new CloudflareAPI("secret", (async () => Response.json(result)) as typeof fetch);
    await expect(api.list("/zones", z.unknown())).rejects.toBeInstanceOf(CloudflareError);
  }
});
test("Access overlaps include paths, partial wildcards and public destinations", () => {
  for (const domain of [
    "demo.example.com/path",
    "*emo.example.com",
    "*.example.com",
    "d*o.example.com/path",
  ]) {
    expect(
      appOverlaps(
        appSchema.parse({ id: "foreign", name: "production", type: "self_hosted", domain }),
        "demo.example.com",
      ),
    ).toBe(true);
  }
  expect(
    appOverlaps(
      appSchema.parse({
        id: "foreign",
        name: "production",
        type: "self_hosted",
        destinations: [{ type: "public", uri: "https://demo.example.com/admin" }],
      }),
      "demo.example.com",
    ),
  ).toBe(true);
  expect(
    appOverlaps(
      appSchema.parse({
        id: "other",
        name: "unrelated",
        type: "self_hosted",
        domain: "other.example.com",
      }),
      "demo.example.com",
    ),
  ).toBe(false);
});
