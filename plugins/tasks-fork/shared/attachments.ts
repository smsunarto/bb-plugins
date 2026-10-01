export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

export function attachmentDownloadUrl(attachmentId: string): string {
  return `/api/v1/plugins/tasks-fork/http/attachments/download?attachmentId=${encodeURIComponent(attachmentId)}`;
}
