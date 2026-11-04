import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { DOTFILES_AGENTS, MAX_TREE_BYTES } from "./model.ts";

async function entries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Resolves a relative `path` under the checkout without following links: every
 * existing segment must be a plain file or folder, so nothing outside the
 * checkout can be read. A missing segment is fine; the caller sees ENOENT.
 */
async function inside(rootPath: string, path: string) {
  const root = await realpath(rootPath);
  let current = root;
  for (const segment of path.split("/")) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(
          `${relative(root, current)} is a link; the importer reads only plain files`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return join(root, path);
}

/** Folders in `parent`, and the links that stand in for folders or files there. */
async function children(parent: string, prefix: string, keep: (e: Dirent) => boolean) {
  const found = (await entries(parent)).filter((e) => !e.name.startsWith(".") && keep(e));
  return {
    names: found
      .filter((e) => !e.isSymbolicLink())
      .map((e) => e.name)
      .sort(),
    links: found.filter((e) => e.isSymbolicLink()).map((e) => `${prefix}/${e.name}`),
  };
}

const folderOrLink = (e: Dirent) => e.isDirectory() || e.isSymbolicLink();

/** Host handlers that read the dotfiles agent sources. They never write. */
export const catalogHostHandlers = {
  async listAgentSources({ rootPath }: { rootPath: string }) {
    const base = await inside(rootPath, DOTFILES_AGENTS);
    const links: string[] = [];
    // Parents are already plain folders, so only the listed folder itself can be a link.
    const list = async (path: string, keep: (e: Dirent) => boolean) => {
      const stat = await lstat(join(base, path)).catch(() => null);
      if (stat?.isSymbolicLink()) {
        links.push(`${DOTFILES_AGENTS}/${path}`);
        return [];
      }
      const found = await children(join(base, path), `${DOTFILES_AGENTS}/${path}`, keep);
      links.push(...found.links);
      return found.names;
    };
    const instructions = await list(
      "instructions",
      (e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith(".md"),
    );
    const skills: { dir: string; plugin: string | null }[] = [];
    for (const name of await list("skills", folderOrLink))
      skills.push({ dir: `${DOTFILES_AGENTS}/skills/${name}`, plugin: null });
    for (const plugin of await list("plugins", folderOrLink))
      for (const name of await list(`plugins/${plugin}/skills`, folderOrLink))
        skills.push({ dir: `${DOTFILES_AGENTS}/plugins/${plugin}/skills/${name}`, plugin });
    return { instructions, skills, links };
  },

  async readSkillTree({ rootPath, dir }: { rootPath: string; dir: string }) {
    const root = await inside(rootPath, dir);
    const found: { path: string; absolute: string; executable: boolean }[] = [];
    const symlinks: string[] = [];
    let bytes = 0;
    async function walk(current: string, prefix: string) {
      for (const entry of (await entries(current)).sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = join(current, entry.name);
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) symlinks.push(path);
        else if (entry.isDirectory()) await walk(absolute, path);
        else if (entry.isFile()) {
          const stat = await lstat(absolute);
          bytes += stat.size;
          found.push({ path, absolute, executable: (stat.mode & 0o111) !== 0 });
        }
      }
    }
    await walk(root, "");
    if (bytes > MAX_TREE_BYTES) return { files: [], symlinks, tooLarge: true };
    const files = await Promise.all(
      found.map(async ({ path, absolute, executable }) => ({
        path,
        executable,
        base64: (await readFile(absolute)).toString("base64"),
      })),
    );
    return { files, symlinks, tooLarge: false };
  },

  async readText({ rootPath, path }: { rootPath: string; path: string }) {
    try {
      return { content: await readFile(await inside(rootPath, path), "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: null };
      throw error;
    }
  },
};
