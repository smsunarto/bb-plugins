import nextra from "nextra";

const withNextra = nextra({});

export default withNextra({
  assetPrefix: ".",
  output: "export",
  images: {
    unoptimized: true,
  },
  trailingSlash: true,
  turbopack: {
    resolveAlias: {
      "next-mdx-import-source-file": "./src/mdx-components.tsx",
    },
  },
});
