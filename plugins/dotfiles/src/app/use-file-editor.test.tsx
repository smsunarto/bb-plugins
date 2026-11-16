import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { installDom } from "@bb-plugins/testing";

installDom();
const { act, fireEvent } = await import("@testing-library/react");
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { queryClient } = await import("./query.ts");
const { useFileEditor } = await import("./use-file-editor.ts");

afterEach(() => queryClient.clear());

function Probe() {
  const editor = useFileEditor("host-a", ".dotfiles/mcp.json" as never);
  if (editor.status !== "ready") return <output>{editor.status}</output>;
  return (
    <>
      <output>{editor.dirty ? "dirty" : "clean"}</output>
      <button type="button" onClick={() => editor.setContent(`${editor.content}!`)}>
        Edit
      </button>
      <button type="button" onClick={editor.flush}>
        Save
      </button>
    </>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("the draft is dirty after an edit, clean once saved, and dirty again for an edit made mid-save", async () => {
  const saves: { content: string; reply: ReturnType<typeof deferred<unknown>> }[] = [];
  const slot = renderSlot(
    { component: Probe },
    {},
    {
      rpc: {
        readFile: () => ({ content: "a", sha256: "s0", headContent: null }),
        saveFile: ({ content }: { content: string }) => {
          const reply = deferred<unknown>();
          saves.push({ content, reply });
          return reply.promise;
        },
      } as never,
    },
  );
  const status = () => slot.container.querySelector("output")?.textContent;
  await slot.findByText("clean");

  fireEvent.click(slot.getByRole("button", { name: "Edit" }));
  assert.equal(status(), "dirty");

  fireEvent.click(slot.getByRole("button", { name: "Save" }));
  await act(async () => {
    saves[0]!.reply.resolve({ outcome: "written", sha256: "s1", renderHint: false });
  });
  assert.equal(status(), "clean");

  // An edit while the save is out stays dirty after that save lands, until
  // the follow-up save writes it.
  fireEvent.click(slot.getByRole("button", { name: "Edit" }));
  fireEvent.click(slot.getByRole("button", { name: "Save" }));
  fireEvent.click(slot.getByRole("button", { name: "Edit" }));
  await act(async () => {
    saves[1]!.reply.resolve({ outcome: "written", sha256: "s2", renderHint: false });
  });
  assert.equal(saves[1]!.content, "a!!");
  assert.equal(status(), "dirty");
  await act(async () => {
    saves[2]!.reply.resolve({ outcome: "written", sha256: "s3", renderHint: false });
  });
  assert.equal(saves[2]!.content, "a!!!");
  assert.equal(status(), "clean");
  slot.unmount();
});
