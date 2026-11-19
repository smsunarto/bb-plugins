import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crewRpcContract } from "../shared/crew-contract";
import { registerCrewApi } from "./crew";
import { createStore } from ".";

const CAPTAIN = { kind: "plugin", pluginId: "captain" } as const;
const OTHER_PLUGIN = { kind: "plugin", pluginId: "slopcop" } as const;

function setup() {
  vi.useFakeTimers({ now: new Date("2026-11-16T10:00:00.000Z") });
  const host = createFakePluginHost({ pluginId: "scott-tasks" });
  const store = createStore(host.bb);
  registerCrewApi(host.bb, store);
  const project = store.tasks.createProject({ name: "Plugins", prefix: "PLUG", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Render PR images" });
  const call = (method: string, input: unknown, caller?: typeof CAPTAIN | typeof OTHER_PLUGIN) =>
    host.harness.callRpc(method, input, caller ? { experimental_caller: caller } : undefined);
  return { ...host, store, task, call };
}

async function defineReview(call: ReturnType<typeof setup>["call"]) {
  await call("defineField", { key: "review", values: ["findings", "passed", "skipped"] }, CAPTAIN);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("owned task fields", () => {
  it("lets only the owner plugin write a field", async () => {
    const { harness, store, task, call } = setup();
    await defineReview(call);

    await expect(
      call("setField", { taskId: task.id, key: "review", value: "passed" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      call("setField", { taskId: task.id, key: "review", value: "passed" }, OTHER_PLUGIN),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(store.tasks.getTaskField(task.id, "review")).toBeUndefined();

    const written = crewRpcContract.setField.output.parse(
      await call(
        "setField",
        { taskId: task.id, key: "review", value: "passed", head: "abc123" },
        CAPTAIN,
      ),
    );
    expect(written.field).toEqual({
      key: "review",
      value: "passed",
      head: "abc123",
      writtenAt: "2026-11-16T10:00:00.000Z",
    });

    await harness.dispose();
  });

  it("refuses defining fields from a client or over another plugin's field", async () => {
    const { harness, call } = setup();
    await expect(call("defineField", { key: "review", values: ["passed"] })).rejects.toMatchObject({
      code: "forbidden",
    });
    await defineReview(call);
    await expect(
      call("defineField", { key: "review", values: ["passed"] }, OTHER_PLUGIN),
    ).rejects.toMatchObject({ code: "forbidden" });

    await harness.dispose();
  });

  it("accepts only the field's values or unset, and keeps a value a task still holds", async () => {
    const { harness, store, task, call } = setup();
    await defineReview(call);

    await expect(
      call("setField", { taskId: task.id, key: "review", value: "approved" }, CAPTAIN),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      call("setField", { taskId: task.id, key: "triage", value: "skipped" }, CAPTAIN),
    ).rejects.toMatchObject({ code: "not_found" });

    await call("setField", { taskId: task.id, key: "review", value: "findings" }, CAPTAIN);
    await expect(
      call("defineField", { key: "review", values: ["passed", "skipped"] }, CAPTAIN),
    ).rejects.toMatchObject({ code: "conflict" });

    await call("setField", { taskId: task.id, key: "review", value: null }, CAPTAIN);
    expect(store.tasks.getTaskField(task.id, "review")).toBeUndefined();
    const narrowed = crewRpcContract.defineField.output.parse(
      await call("defineField", { key: "review", values: ["passed", "skipped"] }, CAPTAIN),
    );
    expect(narrowed.field).toMatchObject({
      ownerPluginId: "captain",
      values: ["passed", "skipped"],
    });

    await harness.dispose();
  });

  it("bumps the task's updated_at when a value is written or unset, not when repeated", async () => {
    const { harness, store, task, call } = setup();
    await defineReview(call);
    expect(store.tasks.getTask(task.id)?.updatedAt).toBe("2026-11-16T10:00:00.000Z");

    vi.setSystemTime(new Date("2026-11-16T10:05:00.000Z"));
    await call("setField", { taskId: task.id, key: "review", value: "passed" }, CAPTAIN);
    expect(store.tasks.getTask(task.id)?.updatedAt).toBe("2026-11-16T10:05:00.000Z");

    vi.setSystemTime(new Date("2026-11-16T10:06:00.000Z"));
    await call("setField", { taskId: task.id, key: "review", value: "passed" }, CAPTAIN);
    expect(store.tasks.getTask(task.id)?.updatedAt).toBe("2026-11-16T10:05:00.000Z");

    vi.setSystemTime(new Date("2026-11-16T10:07:00.000Z"));
    await call("setField", { taskId: task.id, key: "review", value: null }, CAPTAIN);
    expect(store.tasks.getTask(task.id)?.updatedAt).toBe("2026-11-16T10:07:00.000Z");

    await harness.dispose();
  });

  it("reads a task's fields with no thread attached, and leaves out unknown tasks", async () => {
    const { harness, task, call } = setup();
    await defineReview(call);
    await call(
      "setField",
      { taskId: task.id, key: "review", value: "passed", head: "abc123" },
      CAPTAIN,
    );

    const read = crewRpcContract.taskFields.output.parse(
      await call("taskFields", { taskIds: [task.id, "01M7ZZZZZZZZZZZZZZZZZZZZZZ"] }, CAPTAIN),
    );

    expect(read.tasks).toEqual([
      {
        taskId: task.id,
        fields: [expect.objectContaining({ key: "review", value: "passed", head: "abc123" })],
      },
    ]);
    await harness.dispose();
  });
});
