// @vitest-environment jsdom
import { act, fireEvent, waitFor } from "@testing-library/react";
import type { ComposerSelection } from "@get-bb/plugin-sdk/app";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerHandleProvider, usePickerComposer } from "../composer-handle";
import {
  PERSONAL_PROJECT_ID,
  hiddenProjectIds,
  publishHiddenProjectIds,
  resetHiddenProjects,
} from "./hidden-projects";
import { moveOffHiddenProject, useCaptainProjectGuard } from "./useCaptainProjectGuard";

const CAPTAINS = "proj_captains";

function Guarded() {
  useCaptainProjectGuard();
  const composer = usePickerComposer();
  return (
    <>
      <output data-testid="project">{composer.selection?.projectId ?? "none"}</output>
      <button type="button" onClick={() => void composer.setSelection({ projectId: CAPTAINS })}>
        Pick Captains
      </button>
    </>
  );
}

function render(
  projectId: string,
  homeProjects: () => { projectIds: string[] } | Promise<{ projectIds: string[] }>,
  scope: "new-thread" | "thread" = "new-thread",
) {
  return renderSlot(
    {
      component: () => (
        <ComposerHandleProvider>
          <Guarded />
        </ComposerHandleProvider>
      ),
    },
    {},
    {
      rpc: { homeProjects },
      composer: {
        scope:
          scope === "new-thread"
            ? { kind: "new-thread", projectId }
            : { kind: "thread", threadId: "t1" },
        selection: { projectId },
      },
    },
  );
}

const project = (slot: ReturnType<typeof render>) => slot.getByTestId("project").textContent;
const never = () => new Promise<never>(() => {});

beforeEach(() => {
  localStorage.clear();
  resetHiddenProjects();
});

describe("useCaptainProjectGuard", () => {
  it("moves a new thread remembered on Captains to the personal project", async () => {
    const slot = render(CAPTAINS, () => ({ projectIds: [CAPTAINS] }));
    try {
      await waitFor(() => expect(project(slot)).toBe(PERSONAL_PROJECT_ID));
      expect(hiddenProjectIds()).toEqual([CAPTAINS]);
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("moves off Captains from the cached ids before Captain answers", async () => {
    publishHiddenProjectIds([CAPTAINS]);
    resetHiddenProjects();
    const slot = render(CAPTAINS, never);
    try {
      await waitFor(() => expect(project(slot)).toBe(PERSONAL_PROJECT_ID));
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("keeps the cached ids when Captain's read fails", async () => {
    publishHiddenProjectIds([CAPTAINS]);
    resetHiddenProjects();
    const slot = render(CAPTAINS, () => {
      throw new Error("plugin captain is not installed");
    });
    try {
      await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
      await waitFor(() => expect(project(slot)).toBe(PERSONAL_PROJECT_ID));
      expect(hiddenProjectIds()).toEqual([CAPTAINS]);
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("returns a hand pick of Captains to the project the composer was on", async () => {
    const slot = render("proj_a", () => ({ projectIds: [CAPTAINS] }));
    try {
      await waitFor(() => expect(hiddenProjectIds()).toEqual([CAPTAINS]));
      fireEvent.click(slot.getByRole("button", { name: "Pick Captains" }));
      await waitFor(() =>
        expect(slot.inspection.composer.selections.map((s) => s.projectId)).toEqual([
          CAPTAINS,
          "proj_a",
        ]),
      );
      expect(project(slot)).toBe("proj_a");
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("hides and moves nothing when Captain does not answer and nothing is cached", async () => {
    const slot = render(CAPTAINS, () => {
      throw new Error("plugin captain is not installed");
    });
    try {
      await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
      expect(hiddenProjectIds()).toEqual([]);
      expect(project(slot)).toBe(CAPTAINS);
    } finally {
      slot.lifecycle.unmount();
    }
  });

  it("asks Captain only once the composer is a new-thread composer", async () => {
    const slot = render(CAPTAINS, () => ({ projectIds: [CAPTAINS] }), "thread");
    try {
      await act(async () => {});
      expect(slot.inspection.rpcCalls).toHaveLength(0);
      await slot.behavior.setComposerScope({ kind: "new-thread", projectId: CAPTAINS });
      await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    } finally {
      slot.lifecycle.unmount();
    }
  });
});

describe("moveOffHiddenProject", () => {
  /** A composer that refuses project changes `refusals` times, as BB does mid-upload. */
  function refusingComposer(refusals: number) {
    let projectId = CAPTAINS;
    const setSelection = vi.fn(async (selection: ComposerSelection) => {
      if (setSelection.mock.calls.length > refusals && selection.projectId) {
        projectId = selection.projectId;
      }
      return { projectId };
    });
    return { setSelection };
  }
  const isHidden = (id: string) => id === CAPTAINS;

  it("retries a refused move until BB applies it", async () => {
    const composer = refusingComposer(2);
    await moveOffHiddenProject(composer, "proj_a", isHidden, new AbortController().signal, {
      retryMs: 0,
    });
    expect(composer.setSelection).toHaveBeenCalledTimes(3);
  });

  it("gives up after its attempts", async () => {
    const composer = refusingComposer(99);
    await moveOffHiddenProject(composer, "proj_a", isHidden, new AbortController().signal, {
      attempts: 4,
      retryMs: 0,
    });
    expect(composer.setSelection).toHaveBeenCalledTimes(4);
  });

  it("stops retrying once aborted", async () => {
    const composer = refusingComposer(99);
    const controller = new AbortController();
    const moving = moveOffHiddenProject(composer, "proj_a", isHidden, controller.signal, {
      retryMs: 10_000,
    });
    await waitFor(() => expect(composer.setSelection).toHaveBeenCalledTimes(1));
    controller.abort();
    await moving;
    expect(composer.setSelection).toHaveBeenCalledTimes(1);
  });
});
