// The palette row is registered at app definition time, outside React, while
// bb's archive action and the list's advance only exist inside a mounted
// inbox. The mounted list publishes its settle here so the palette settles
// exactly like a row's own button.
export interface PublishedSidebarActions {
  settle(threadId: string): void;
}

let current: PublishedSidebarActions | null = null;

export function publishSidebarActions(published: PublishedSidebarActions): void {
  current = published;
}

export function forgetSidebarActions(published: PublishedSidebarActions): void {
  if (current === published) current = null;
}

export function hasSidebarActions(): boolean {
  return current !== null;
}

export function settleThread(threadId: string): void {
  current?.settle(threadId);
}

// The palette row still asks for archiveThread; a settle is an archive plus
// the advance, so it routes through the same dispatcher. Stays until the
// palette's own change can land on its stack.
export function archiveThread(threadId: string): void {
  settleThread(threadId);
}
