import { expect, test } from "vitest";
import { DEFAULT_API_BASE, resolveSettings, type RawSettings } from "./settings.ts";

const raw: RawSettings = {
  apiKey: " boat_secret ",
  apiBase: `${DEFAULT_API_BASE}/`,
  defaultType: "large",
  environment: " staging ",
  idleMinutes: 15,
  autoStopHours: 24,
};

test("resolves a complete configuration into typed settings", () => {
  expect(resolveSettings(raw)).toEqual({
    ok: true,
    settings: {
      apiKey: "boat_secret",
      apiBase: DEFAULT_API_BASE,
      defaultType: "large",
      environment: "staging",
      idleMs: 15 * 60_000,
      ttlSeconds: 24 * 3600,
    },
  });
});

test("zero disables idle stop and Boat auto-stop; a blank environment means the account default", () => {
  const resolved = resolveSettings({ ...raw, idleMinutes: 0, autoStopHours: 0, environment: "" });
  expect(resolved).toMatchObject({
    ok: true,
    settings: { idleMs: null, ttlSeconds: null, environment: null },
  });
});

test("reports what is missing or invalid", () => {
  expect(resolveSettings({ ...raw, apiKey: undefined })).toEqual({
    ok: false,
    message: "Set apiKey in the plugin's settings.",
  });
  expect(resolveSettings({ ...raw, apiBase: "boat.dev" })).toMatchObject({ ok: false });
  expect(resolveSettings({ ...raw, apiBase: "http://boat.dev/api/v1" })).toMatchObject({
    ok: false,
  });
  expect(resolveSettings({ ...raw, defaultType: "huge" })).toMatchObject({ ok: false });
  expect(resolveSettings({ ...raw, idleMinutes: 1.5 })).toMatchObject({ ok: false });
  expect(resolveSettings({ ...raw, autoStopHours: 31 * 24 })).toMatchObject({ ok: false });
});
