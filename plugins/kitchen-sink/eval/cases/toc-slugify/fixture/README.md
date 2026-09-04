# markdown-toc

Builds a linked table of contents from the headings of a markdown document.
Headings inside fenced code blocks and inside front matter are ignored, and a
repeated heading gets a numbered anchor so every link stays unique.

Wrap the spot you want the list in with `<!-- toc -->` and `<!-- /toc -->`, then
call `insertToc` from `src/insert.ts` with the rendered list.
