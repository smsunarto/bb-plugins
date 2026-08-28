import { useMemo } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";

export const PANEL_PATH = "dotfiles";

export type RepoPath = string;

export interface DotfilesRoute {
  readonly path: RepoPath | null;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed deep link degrades to the server's not-a-tweakable error.
    return segment;
  }
}

export function parseSubPath(subPath: string): DotfilesRoute {
  if (subPath === "") return { path: null };
  return { path: subPath.split("/").map(decodeSegment).join("/") };
}

export function encodeSubPath(path: RepoPath): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export interface DotfilesNavigation extends DotfilesRoute {
  open(path: RepoPath): void;
  clear(): void;
}

export function useDotfilesRoute(subPath: string): DotfilesNavigation {
  const navigate = useBbNavigate();
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  return {
    path: route.path,
    open(path) {
      navigate.toPluginPanel(PANEL_PATH, { subPath: encodeSubPath(path) });
    },
    clear() {
      navigate.toPluginPanel(PANEL_PATH, { subPath: "", replace: true });
    },
  };
}
