import { z } from "zod";
import { HTML_RENDER_MAX_HTML_LENGTH } from "../../shared/html-render.ts";

export const html = z
  .string()
  .min(1)
  .max(HTML_RENDER_MAX_HTML_LENGTH)
  .describe(
    "A complete, self-contained HTML document, or a fragment for the visualization runtime.",
  );
