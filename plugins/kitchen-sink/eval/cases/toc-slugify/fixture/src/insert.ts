import { splitLines } from "./scan.ts";

export const START_MARKER = "<!-- toc -->";
export const END_MARKER = "<!-- /toc -->";

export function markerPositions(document: string): { start: number; end: number } | null {
  const lines = splitLines(document);
  const start = lines.findIndex((line) => line.trim() === START_MARKER);
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && line.trim() === END_MARKER);
  if (end === -1) return null;
  return { start, end };
}

export function hasMarkers(document: string): boolean {
  return markerPositions(document) !== null;
}

export function insertToc(document: string, toc: string): string {
  const positions = markerPositions(document);
  if (positions === null) {
    throw new Error(`document has no ${START_MARKER} / ${END_MARKER} pair`);
  }
  const lines = splitLines(document);
  const before = lines.slice(0, positions.start + 1);
  const after = lines.slice(positions.end);
  return [...before, "", toc, "", ...after].join("\n");
}

export function removeToc(document: string): string {
  const positions = markerPositions(document);
  if (positions === null) return document;
  const lines = splitLines(document);
  return [...lines.slice(0, positions.start + 1), ...lines.slice(positions.end)].join("\n");
}
