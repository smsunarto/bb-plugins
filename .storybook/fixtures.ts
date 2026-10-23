/** Fictional review data shared by file trees and workflow stories. */
export const reviewFiles: {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  previousPath?: string;
}[] = [
  { path: "src/reviews/use-review-query.ts", status: "modified", additions: 38, deletions: 14 },
  { path: "src/reviews/review-panel.tsx", status: "modified", additions: 24, deletions: 8 },
  { path: "src/reviews/offline-notice.tsx", status: "added", additions: 46, deletions: 0 },
  { path: "src/reviews/__tests__/reconnect.test.ts", status: "added", additions: 92, deletions: 0 },
  { path: "src/reviews/legacy-polling.ts", status: "deleted", additions: 0, deletions: 61 },
  {
    path: "docs/reviews/offline-recovery.md",
    status: "renamed",
    previousPath: "docs/reviews/retry.md",
    additions: 12,
    deletions: 4,
  },
];

export const recoveryPlan = `# Keep reviews available offline

The review panel currently clears its file list when the checkout host disconnects. The refresh handler in \`use-review-query.ts\` owns this transition. Keep the last successful snapshot visible while reconnection runs in the background.

## Acceptance criteria

- [x] Keep the selected file and scroll position when a refresh starts
- [x] Label cached results with the last successful refresh time
- [ ] Ignore responses from a previously selected checkout
- [ ] Verify reconnect while a review comment is being edited

## Expected behavior

| Connection | File list | Primary action |
| --- | --- | --- |
| Connected | Latest snapshot | Refresh |
| Reconnecting | Cached snapshot | Retry |
| Offline, no cache | Empty state with explanation | Retry |

> Never label cached data as a successful refresh. A disconnected host should not prevent reviewing files already loaded.

See the [recovery runbook](https://example.com/atlas/runbooks/host-reconnect) for the manual verification steps.

### Review focus

Switch from **Atlas / frontend** to **Atlas / api** while the first request is pending. Only the selected checkout may update the panel.
`;
