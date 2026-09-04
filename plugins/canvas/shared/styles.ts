import { suggest } from "./suggest.ts";

// Zod-free so the app can import it as a value, like `source.ts`.

export const styleNames = ["default", "github"] as const;

export type StyleName = (typeof styleNames)[number];

export const styles: Readonly<Record<StyleName, { readonly summary: string }>> = {
  default: { summary: "Compact prose, toned surfaces, and bb's own palette." },
  github: { summary: "The GitHub markdown body with rules under headings and bordered tables." },
};

export const defaultStyle: StyleName = "default";

export function isStyleName(name: string): name is StyleName {
  return Object.hasOwn(styles, name);
}

export function suggestStyleName(typo: string): string | undefined {
  return suggest(typo, styleNames);
}
