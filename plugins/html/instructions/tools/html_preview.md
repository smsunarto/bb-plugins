Preview an HTML page before publishing it with `html_render`. Returns a PNG, `contentHeight`, and `consoleMessages`, plus `missingImages` when local images could not be inlined.

Inline `<style>` and `<script>`. Absolute local image paths are inlined; remote URLs load as-is. Follow the layout and theme rules in `html_render`.

Inspect the PNG, console output, and any missing images. Fix issues, then call `html_render` with `contentHeight` as its `height`.
