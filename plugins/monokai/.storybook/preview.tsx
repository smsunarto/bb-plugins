import type { ReactNode } from "react";

import "./preview.css";
import "../themes/bb-monokai.css";

const withMonokai = (Story: () => ReactNode) => (
  <main className="dark sb-catalog">
    <Story />
  </main>
);

const preview = {
  decorators: [withMonokai],
  parameters: {
    layout: "fullscreen",
    options: {
      storySort: {
        order: ["Theme", ["Foundations", "Chrome and states", "Content palettes"]],
      },
    },
  },
};

export default preview;
