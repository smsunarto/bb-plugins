// Turns a model's Mermaid source into an Excalidraw-looking diagram: Mermaid's
// hand-drawn look (rough strokes, hachure fills) in Excalifont, in Excalidraw's
// palette. Excalidraw's dark theme is its light canvas through
// `invert(93%) hue-rotate(180deg)`; the dark palette here is that filter
// worked out per colour, so the SVG is drawn dark natively and BB's zoom view,
// which copies the SVG elsewhere, shows it right too. Pure: no DOM.

/** The font family the diagram text uses; Excalifont is loaded by sketchFont.ts. */
export const SKETCH_FONT_FAMILY = "Excalifont, 'Segoe Print', 'Bradley Hand', 'Comic Sans MS', cursive";

/** Excalidraw's stroke and fill colours (its default palette, light theme). */
const LIGHT = {
  ink: "#1e1e1e",
  canvas: "#ffffff",
  blue: "#a5d8ff",
  green: "#b2f2bb",
  yellow: "#ffec99",
  red: "#ffc9c9",
  violet: "#d0bfff",
  gray: "#f1f3f5",
  /** Clickable nodes (Diagram details): outline, hover hachure, selected hachure. */
  link: "#1971c2",
  hover: "#74c0fc",
  selected: "#ffd43b",
} as const;

export type SketchPalette = { readonly [K in keyof typeof LIGHT]: string };

const channel = (value: number) => Math.round(Math.min(255, Math.max(0, value)));

/** A colour through Excalidraw's dark-theme filter: invert(93%), then hue-rotate(180deg). */
export function darkened(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => 255 * 0.93 + parseInt(hex.slice(at, at + 2), 16) * (1 - 2 * 0.93));
  // The CSS hue-rotate matrix at 180°.
  const rotated = [-0.574 * r + 1.43 * g + 0.144 * b, 0.426 * r + 0.43 * g + 0.144 * b, 0.426 * r + 1.43 * g - 0.856 * b];
  return `#${rotated.map((value) => channel(value).toString(16).padStart(2, "0")).join("")}`;
}

const DARK = Object.fromEntries(Object.entries(LIGHT).map(([name, hex]) => [name, darkened(hex)])) as SketchPalette;

export function sketchPalette(dark: boolean): SketchPalette {
  return dark ? DARK : LIGHT;
}

/** One seed, so every render of the same diagram draws the same wobble. */
const SEED = 7;

/** `backdrop` is the colour the diagram is drawn on; edge labels are cut out of the lines with it. */
function frontmatter(colors: SketchPalette, backdrop: string): string {
  const variables: Record<string, string> = {
    fontFamily: SKETCH_FONT_FAMILY,
    fontSize: "17px",
    background: backdrop,
    primaryColor: colors.blue,
    mainBkg: colors.blue,
    secondaryColor: colors.green,
    tertiaryColor: colors.yellow,
    primaryBorderColor: colors.ink,
    nodeBorder: colors.ink,
    primaryTextColor: colors.ink,
    textColor: colors.ink,
    lineColor: colors.ink,
    edgeLabelBackground: backdrop,
    clusterBkg: colors.gray,
    clusterBorder: colors.ink,
    titleColor: colors.ink,
    actorBkg: colors.blue,
    actorBorder: colors.ink,
    actorTextColor: colors.ink,
    actorLineColor: colors.ink,
    signalColor: colors.ink,
    signalTextColor: colors.ink,
    labelBoxBkgColor: colors.yellow,
    labelBoxBorderColor: colors.ink,
    labelTextColor: colors.ink,
    loopTextColor: colors.ink,
    noteBkgColor: colors.yellow,
    noteBorderColor: colors.ink,
    noteTextColor: colors.ink,
    activationBkgColor: colors.gray,
    activationBorderColor: colors.ink,
  };
  return [
    "---",
    "config:",
    "  look: handDrawn",
    `  handDrawnSeed: ${SEED}`,
    "  theme: base",
    "  darkMode: false",
    `  fontFamily: "${SKETCH_FONT_FAMILY}"`,
    "  themeVariables:",
    ...Object.entries(variables).map(([name, value]) => `    ${name}: "${value}"`),
    "---",
  ].join("\n");
}

/** Flowchart node shapes that get their own colour, as Excalidraw users colour-code. */
const SHAPE_CLASSES = [
  // id{text} or id{{text}}: a decision.
  { name: "sketchDecision", color: "yellow", openers: ["{", "{{"] },
  // id[(text)]: a data store.
  { name: "sketchStore", color: "green", openers: ["[("] },
  // id((text)) or id(((text))): a start or end point.
  { name: "sketchTerminal", color: "red", openers: ["((", "((("] },
  // id>text]: a flag, often an input or event.
  { name: "sketchEvent", color: "violet", openers: [">"] },
] as const;

/** Lines that define no nodes. */
const NOT_NODES = /^\s*(%%|subgraph\b|end\b|direction\b|click\b|class\b|classDef\b|style\b|linkStyle\b|flowchart\b|graph\b)/;
/** Arrows and `&` separate the nodes on a line: -->, ---, -.->, ==>, --o, <-->, ~~~ … */
const SEPARATORS = /\s*(?:<?(?:-{2,}|-\.+-|={2,}|~{3,})[->ox]?|&)\s*/;
/** A segment that starts a node: its id and the shape opener after it, if any. */
const NODE_START = /^([A-Za-z_][\w-]*)\s*(\{\{|\{|\[\(|\(\(\(|\(\(|>)?/;

function isFlowchart(source: string): boolean {
  return /^\s*(flowchart|graph)\b/.test(source);
}

/** The model set its own look: front matter or an init directive. */
function hasOwnStyling(source: string): boolean {
  return /^\s*---/.test(source) || /%%\{\s*init/.test(source);
}

function hasOwnClasses(source: string): boolean {
  return /\bclassDef\b|^\s*style\s|:::/m.test(source);
}

/** Class lines colouring decisions, data stores, terminals and events in a flowchart. */
export function shapeClassLines(source: string, colors: SketchPalette = LIGHT): string[] {
  if (!isFlowchart(source) || hasOwnClasses(source)) return [];
  const members = new Map<string, Set<string>>(SHAPE_CLASSES.map((shape) => [shape.name, new Set()]));
  for (const line of source.split("\n")) {
    if (NOT_NODES.test(line)) continue;
    // Edge text (|…|) and quoted labels can hold braces that are not shapes.
    const bare = line.replace(/\|[^|]*\|/g, " ").replace(/"[^"]*"/g, '""');
    for (const segment of bare.split(SEPARATORS)) {
      const [, id, opener] = NODE_START.exec(segment.trim()) ?? [];
      if (id === undefined || opener === undefined) continue;
      const shape = SHAPE_CLASSES.find((candidate) => (candidate.openers as readonly string[]).includes(opener));
      if (shape !== undefined) members.get(shape.name)?.add(id);
    }
  }
  const lines: string[] = [];
  for (const shape of SHAPE_CLASSES) {
    const ids = [...(members.get(shape.name) ?? [])];
    if (ids.length === 0) continue;
    lines.push(`  classDef ${shape.name} fill:${colors[shape.color]}`, `  class ${ids.join(",")} ${shape.name}`);
  }
  return lines;
}

/**
 * The source BB's Mermaid renderer gets. A diagram that brings its own front
 * matter or init directive keeps it untouched; one with its own class or style
 * lines keeps its colours but still gets the hand-drawn look. The diagram has
 * no canvas of its own: it is drawn on `backdrop`, Excalidraw's canvas colour
 * if none is given.
 */
export function sketchMermaid(source: string, dark = false, backdrop?: string): string {
  const trimmed = source.trim();
  if (hasOwnStyling(trimmed)) return trimmed;
  const colors = sketchPalette(dark);
  return [frontmatter(colors, backdrop ?? colors.canvas), trimmed, ...shapeClassLines(trimmed, colors)].join("\n");
}
