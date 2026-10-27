/*
 * Requests the embedded studio asks bb's composer to carry. The panel that hosts the iframe
 * posts them here; the composer banner in the matching scope takes them. A thread's panel names
 * its thread; the new-thread panel names none.
 */
export type StudioPromptInput = {
  gameId: string;
  action: string;
  boardId?: string;
  nodeId?: string;
  documentId?: string;
  experimentId?: string;
  assetId?: string;
  recipe?: string;
};
export type StudioRequest = {
  threadId: string | null;
  prompt: string;
  request: unknown;
  input: StudioPromptInput;
};

const changes = new EventTarget();
let pending: StudioRequest[] = [];

export const studioRequests = {
  post(request: StudioRequest) {
    pending = [...pending, request];
    changes.dispatchEvent(new Event("change"));
  },
  /** Takes every request for a scope; nothing is left for a banner that is not there yet. */
  take(threadId: string | null): StudioRequest[] {
    const mine = pending.filter((request) => request.threadId === threadId);
    if (mine.length) pending = pending.filter((request) => request.threadId !== threadId);
    return mine;
  },
  subscribe(listener: () => void) {
    changes.addEventListener("change", listener);
    return () => changes.removeEventListener("change", listener);
  },
};
