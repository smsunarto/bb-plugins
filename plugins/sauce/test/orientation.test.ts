// The per-project orientation default: what `defaults` stores and what `start` does with it.
import { expect, onTestFinished, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

import { MIGRATIONS, createDefaultsStore } from "../src/server/core.ts";
import { SauceError } from "../src/server/live.ts";
import { registerSauce } from "../src/server/server.ts";
import { fakeDevice } from "./fakes.ts";

const GAME = { threadId: "thr_a", projectId: "proj_game" };
const APP = { threadId: "thr_b", projectId: "proj_app" };

function cli() {
  const fake = fakeDevice();
  const { bb, harness } = createFakePluginHost({
    pluginId: "sauce",
    agentSkillIds: ["sauce-live"],
  });
  // Disposing removes the fake host's storage dir.
  onTestFinished(() => harness.lifecycle.dispose());
  registerSauce(bb, fake.deps);
  const json = async (argv: string[], ctx: { threadId?: string; projectId?: string } = GAME) => {
    const result = await harness.runCli([...argv, "--json"], ctx);
    return { ...result, value: JSON.parse(result.stdout || "null") as Record<string, any> };
  };
  return { ...fake, json };
}

test("a project's default turns the device at start, and only for that project's threads", async () => {
  const { json, world } = cli();
  const set = await json(["defaults", "--orientation", "landscape"]);
  expect(set.value).toMatchObject({
    project: "rampage",
    project_id: "proj_game",
    orientation: "landscape",
  });

  const start = await json(["start", "Samsung Galaxy S23"]);
  expect(start.value).toMatchObject({
    orientation: "landscape",
    orientation_from: "project_default",
  });
  expect(world.orientation).toBe("landscape");
  expect(world.sent).toEqual(["orient landscape"]);
  await json(["end"]);

  const other = await json(["start", "Samsung Galaxy S23"], APP);
  expect(other.exitCode).toBe(0);
  expect(other.value.orientation).toBeUndefined();
  expect(world.orientation).toBe("portrait");
  expect(world.sent).toEqual(["orient landscape"]);
});

test("--orientation on start wins over the project's default", async () => {
  const { json, world } = cli();
  await json(["defaults", "--orientation", "landscape"]);
  const start = await json(["start", "Samsung Galaxy S23", "--orientation", "portrait"]);
  expect(start.value).toMatchObject({ orientation: "portrait", orientation_from: "option" });
  // A session starts portrait, so nothing had to turn.
  expect(world.sent).toEqual([]);
  await json(["end"]);

  const turned = await json(["start", "Samsung Galaxy S23", "--orientation", "landscape"], APP);
  expect(turned.value).toMatchObject({ orientation: "landscape", orientation_from: "option" });
  expect(world.sent).toEqual(["orient landscape"]);
});

test("a start without a project or a default leaves the device as Sauce starts it", async () => {
  const { json, world } = cli();
  await json(["defaults", "--orientation", "landscape"]);
  const start = await json(["start", "Samsung Galaxy S23"], { threadId: "thr_c" });
  expect(start.exitCode).toBe(0);
  expect(start.value.orientation).toBeUndefined();
  expect(world.sent).toEqual([]);
});

test("defaults shows, sets and clears a project's orientation without a thread or a device", async () => {
  const { json, world } = cli();
  const project = { projectId: "proj_game" };
  expect((await json(["defaults"], project)).value.orientation).toBeNull();
  expect((await json(["defaults", "--orientation", "landscape"], project)).value.note).toContain(
    "turns the device landscape",
  );
  // Reading another project by id from anywhere, and it has its own default.
  expect((await json(["defaults", "--project", "proj_app"], project)).value).toMatchObject({
    project: "bb",
    orientation: null,
  });
  expect((await json(["defaults"], project)).value.orientation).toBe("landscape");
  expect((await json(["defaults", "--orientation", "none"], project)).value.orientation).toBeNull();
  expect((await json(["defaults"], project)).value.orientation).toBeNull();
  expect(world.sent).toEqual([]);
});

test("defaults refuses a shell with no project, an unknown project, and an unknown orientation", async () => {
  const { json } = cli();
  const nowhere = await json(["defaults"], {});
  expect(nowhere.exitCode).toBe(1);
  expect(nowhere.value.error.code).toBe("no_project");
  expect(nowhere.value.error.hint).toContain("--project");

  const unknown = await json(["defaults", "--project", "proj_nope", "--orientation", "landscape"]);
  expect(unknown.value.error.code).toBe("not_found");

  const typo = await json(["defaults", "--orientation", "sideways"]);
  expect(typo.exitCode).not.toBe(0);
  expect((await json(["defaults"])).value.orientation).toBeNull();
  expect(
    (await json(["start", "Samsung Galaxy S23", "--orientation", "upside"])).exitCode,
  ).not.toBe(0);
});

test("a device that will not turn is a note on a session that still started", async () => {
  const { json, world } = cli();
  await json(["defaults", "--orientation", "landscape"]);
  world.failOrient = new SauceError("timeout", "The device did not turn landscape within 10 s.");
  const start = await json(["start", "Samsung Galaxy S23"]);
  expect(start.exitCode).toBe(0);
  expect(start.value.orientation).toBeUndefined();
  expect(start.value.orientation_note).toContain("not turned landscape");
  expect(start.value.orientation_note).toContain("bb sauce device rotate");
  expect((await json(["status"])).value.state).toBe("session_mine");
});

test("project defaults live in plugin storage, one row per project that has one", () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "sauce" });
  // Disposing removes the fake host's storage dir.
  onTestFinished(() => harness.lifecycle.dispose());
  bb.storage.migrate(bb.storage.database(), MIGRATIONS);
  const store = createDefaultsStore(bb);
  expect(store.read("proj_game")).toEqual({ orientation: null });
  store.write("proj_game", { orientation: "landscape" });
  store.write("proj_app", { orientation: "portrait" });
  store.write("proj_game", { orientation: "landscape" });
  expect(createDefaultsStore(bb).read("proj_game")).toEqual({ orientation: "landscape" });
  expect(store.read("proj_app")).toEqual({ orientation: "portrait" });
  store.write("proj_app", { orientation: null });
  expect(store.read("proj_app")).toEqual({ orientation: null });
  const rows = bb.storage.database().prepare("SELECT project_id FROM sauce_project_defaults").all();
  expect(rows).toEqual([{ project_id: "proj_game" }]);
});
