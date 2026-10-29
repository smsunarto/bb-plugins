import { lstat, realpath } from "node:fs/promises";
import { join, isAbsolute, relative, sep } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { documentHostContract } from "./model.ts";

/** Native files supplies content and CAS; this adds a no-symlink metadata check. */
export default experimental_defineHostEntry({
  contract: documentHostContract,
  handlers: {
    async inspectPath({ rootPath, path, readOnlyLinks }) {
      const root = await realpath(rootPath);
      if (isAbsolute(path) || path.includes("\\") || path.split("/").some((p) => p === ".." || !p))
        throw new Error("Invalid relative path");
      let current = root;
      for (const segment of path.split("/").filter((part) => part !== ".")) {
        current = join(current, segment);
        try {
          const stat = await lstat(current);
          if (stat.isSymbolicLink()) {
            if (!readOnlyLinks)
              throw new Error(
                "Linked files and directories are read-only; edit their authored source instead.",
              );
            const resolved = relative(root, await realpath(join(root, path)));
            if (
              !resolved ||
              resolved.startsWith(`..${sep}`) ||
              resolved === ".." ||
              isAbsolute(resolved)
            )
              throw new Error("Linked target is outside the registered checkout.");
            return {
              rootPath: root,
              exists: true,
              resolvedPath: resolved.split(sep).join("/"),
              linked: true,
            };
          }
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            return { rootPath: root, exists: false };
          throw error;
        }
      }
      return { rootPath: root, exists: true };
    },
  },
});
