# slug-util

Slug helpers shared by the docs site build and the CMS importer.

`slugify` turns heading text into a URL segment, `truncateSlug` keeps long
headings inside the 80 character path budget, and `uniqueSlug` resolves
collisions with a numeric suffix.

Everything public is re-exported from `src/index.ts`.
