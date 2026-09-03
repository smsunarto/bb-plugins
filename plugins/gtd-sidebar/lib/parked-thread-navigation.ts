export interface ParkedThreadNavigation {
  openVisibleThread(threadId: string, split: boolean): void;
  openAnyThread(threadId: string): void;
  onNavigate(): void;
}

/**
 * Settled threads are archived, so bb's sidebar action cannot resolve them.
 * General navigation reads the thread first and can route to archived work.
 */
export function openParkedThread(
  shelf: "snoozed" | "settled",
  threadId: string,
  split: boolean,
  navigation: ParkedThreadNavigation,
): void {
  if (shelf === "settled") navigation.openAnyThread(threadId);
  else navigation.openVisibleThread(threadId, split);
  navigation.onNavigate();
}
