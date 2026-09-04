import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CanvasSource, UnreadableReason } from "../shared/document.ts";

export interface FileLocation {
  readonly hostId?: string;
  readonly path: string;
  readonly rootPath?: string;
}

// `files.read` wants an absolute path; `rootPath` only fences reads inside the
// worktree or storage directory.

export type LocateResult =
  | { readonly ok: true; readonly location: FileLocation }
  | { readonly ok: false; readonly reason: UnreadableReason; readonly detail: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function locateSource(bb: BbPluginApi, source: CanvasSource): Promise<LocateResult> {
  switch (source.kind) {
    case "workspace": {
      let environment: Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
      try {
        environment = await bb.sdk.environments.get({ environmentId: source.environmentId });
      } catch (error) {
        return {
          ok: false,
          reason: "host-offline",
          detail: `environment lookup failed: ${messageOf(error)}`,
        };
      }
      if (environment.path === null) {
        return {
          ok: false,
          reason: "no-worktree",
          detail: "this environment has no worktree path, so workspace files cannot be read",
        };
      }
      return {
        ok: true,
        location: {
          hostId: environment.hostId,
          path: join(environment.path, source.path),
          rootPath: environment.path,
        },
      };
    }
    case "thread-storage": {
      try {
        const storage = await bb.sdk.threads.storageLocation({ threadId: source.threadId });
        return {
          ok: true,
          location: {
            hostId: storage.hostId,
            path: join(storage.storageRootPath, source.path),
            rootPath: storage.storageRootPath,
          },
        };
      } catch (error) {
        return {
          ok: false,
          reason: "host-offline",
          detail: `thread storage lookup failed: ${messageOf(error)}`,
        };
      }
    }
    case "host":
      return {
        ok: true,
        location:
          source.hostId === null
            ? { path: source.path }
            : { hostId: source.hostId, path: source.path },
      };
  }
}
