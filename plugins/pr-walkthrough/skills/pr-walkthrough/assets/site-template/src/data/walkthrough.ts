import rawData from "./walkthrough.generated.json";

export type WalkthroughFile = {
  path: string;
  url?: string;
  note?: string;
};

export type WalkthroughComment = {
  author: string;
  body: string;
  url?: string;
};

export type WalkthroughGuideBlock =
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; language?: string; code: string }
  | { type: "quote"; text: string };

export type WalkthroughGuideComment = {
  id: string;
  side: "deletions" | "additions";
  lineNumber: number;
  body: string;
};

export type WalkthroughGuideDiagram = {
  summary: string;
  nodes: Array<{
    id: string;
    label: string;
    detail?: string;
    x: number;
    y: number;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    label?: string;
  }>;
};

export type WalkthroughGuideExcerpt = {
  id: string;
  title: string;
  explanation: WalkthroughGuideBlock[];
  path: string;
  url: string;
  patch: string;
  rangeLabel: string;
  additions: number;
  deletions: number;
  binary: boolean;
  generated: boolean;
  countsTowardCompletion: boolean;
  defaultCollapsed: boolean;
  comments: WalkthroughGuideComment[];
};

export type WalkthroughGuidePhase = {
  id: "foundations" | "apis" | "behavior" | "integration" | "tests" | "misc" | "generated";
  title: string;
  explanation: WalkthroughGuideBlock[];
  diagram?: WalkthroughGuideDiagram;
  excerpts: WalkthroughGuideExcerpt[];
  defaultCollapsed: boolean;
};

export type WalkthroughGuide = {
  phases: WalkthroughGuidePhase[];
};

export type WalkthroughReviewGroup = {
  id: string;
  title: string;
  objective: string;
  summary: string;
  details: string[];
  files: WalkthroughFile[];
  comments: WalkthroughComment[];
  links: Array<{ label: string; url: string }>;
  guide: WalkthroughGuide;
};

export type WalkthroughDiffFile = {
  path: string;
  previousPath?: string;
  status: "added" | "copied" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
  oldContents?: string;
  newContents?: string;
  binary: boolean;
  generated: boolean;
  generatedReason?: string;
  url: string;
};

export type WalkthroughData = {
  meta: {
    title: string;
    prUrl: string;
    baseRef: string;
    headRef: string;
    headSha: string;
    summary: string;
  };
  reviewGroups: WalkthroughReviewGroup[];
  diffFiles: WalkthroughDiffFile[];
};

export const walkthroughData = rawData as WalkthroughData;
