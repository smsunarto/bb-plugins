import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function readTextOr(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Write via tmp file + rename so readers (and the core process) never observe
    a partial file. Adapted from plugins/amp/lib/provision.ts. */
export function writeAtomic(path: string, content: string | Buffer, mode?: number): void {
  ensureDir(dirname(path));
  const tmp = `${path}.bb-plugin-agent-proxy-${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Copy `content` into backupsDir as <baseName>.<iso-stamp> and return the
    backup's absolute path. Backups are kept forever; newest wins in listings. */
export function timestampedBackup(content: string, backupsDir: string, baseName: string): string {
  ensureDir(backupsDir);
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const target = join(backupsDir, `${baseName}.${stamp}`);
  writeFileSync(target, content, { mode: 0o600 });
  return target;
}
