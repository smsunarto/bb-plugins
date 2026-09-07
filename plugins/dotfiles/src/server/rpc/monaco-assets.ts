import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";

const ASSET_FILES = ["editor.js", "editor.css", "editor.worker.js"] as const;
const ASSET_LEASE_TTL_MS = 60 * 60 * 1000;
const ASSET_LEASE_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface MonacoAssetLease {
  readonly baseUrl: string;
  readonly expiresAtMs: number;
}

interface MonacoAssetsOptions {
  readonly bundleDir?: string;
  readonly now?: () => number;
}

function defaultBundleDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(moduleDir) === "dist"
    ? path.join(moduleDir, "monaco")
    : path.resolve(moduleDir, "..", "..", "dist", "monaco");
}

async function validateBundle(bundleDir: string): Promise<void> {
  await Promise.all(
    ASSET_FILES.map(async (name) => {
      try {
        const entry = await stat(path.join(bundleDir, name));
        if (entry.isFile()) return;
      } catch {}
      throw new Error(
        `Monaco asset missing: dist/monaco/${name}. Run \`bun run build:monaco\` in plugins/dotfiles.`,
      );
    }),
  );
}

function createMonacoAssets(options: MonacoAssetsOptions = {}) {
  const bundleDir = options.bundleDir ?? defaultBundleDir();
  const now = options.now ?? Date.now;
  let lease: MonacoAssetLease | null = null;
  let refresh: Promise<MonacoAssetLease> | null = null;

  return defineQuery({
    output: z
      .object({
        baseUrl: z.string(),
        expiresAtMs: z.number(),
      })
      .strict(),
    execute(ctx) {
      if (lease !== null && lease.expiresAtMs - now() > ASSET_LEASE_REFRESH_MARGIN_MS) {
        return lease;
      }
      refresh ??= (async () => {
        await validateBundle(bundleDir);
        const next = await ctx.bb.sdk.files.createPreview({
          rootPath: bundleDir,
          ttlMs: ASSET_LEASE_TTL_MS,
        });
        lease = next;
        return next;
      })().finally(() => {
        refresh = null;
      });
      return refresh;
    },
  });
}

export const monacoAssets = Object.assign(createMonacoAssets(), {
  create: createMonacoAssets,
});
