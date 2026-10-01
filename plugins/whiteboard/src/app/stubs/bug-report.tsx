/**
 * Replaces upstream `bug-report-dialog.tsx` and `bug-report-screenshot.ts`
 * (design §2.3 D). bb has its own feedback path, so the topbar control
 * renders nothing.
 */
export function BugReportControl(_props: { captureScreenshot?: () => Promise<string> } = {}): null {
  return null;
}
