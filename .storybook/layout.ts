/** Full screens need a viewport; their fixtures may own document-wide state. */
export const screenParameters = {
  previewLayout: "screen",
  docs: { story: { inline: false, height: "720px" } },
};

/** Components that own a singleton cache cannot share an inline Docs page. */
export const isolatedParameters = {
  docs: { story: { inline: false, height: "320px" } },
};
