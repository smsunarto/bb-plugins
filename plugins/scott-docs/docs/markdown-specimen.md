---
title: Markdown styling specimen
---

# Markdown styling specimen

This document renders every Markdown element the Docs editor styles. Open it in Docs with bb Monokai selected to audit the reading theme. Each section names the element, and the prose around it gives the spacing something to push against.

## Headings

Six heading levels follow. Each one has more room above than below, so it groups with the paragraph it introduces.

# Heading 1

Body text under a first-level heading.

## Heading 2

Body text under a second-level heading.

### Heading 3

Body text under a third-level heading.

#### Heading 4

Body text under a fourth-level heading.

##### Heading 5

Body text under a fifth-level heading.

###### Heading 6

Body text under a sixth-level heading.

## Inline marks

Plain text, **bold text**, _italic text_, **_bold italic_**, ~~strikethrough~~, and `inline code` in one sentence. Bold can wrap **`code`** and [links](https://getbb.app). A link can wrap code: [`bb docs pull`](https://getbb.app).

A line ends with a hard break here.\
The next line starts after the break.

A long unbroken token must wrap without widening the page: `plugins/docs/components/ui/hooks/use-compact-viewport-with-an-unreasonably-long-file-name.tsx`, and so must a bare URL like https://github.com/smsunarto/bb-plugins/tree/main/plugins/docs/docs/markdown-specimen.md.

This paragraph is long enough to wrap across several lines at the reading measure. It shows the line length, the leading, and the paragraph gap together, which are the three settings that decide whether a page reads as calm or cramped. A comfortable measure lands near sixty-five characters per line.

## Links

Visit [bb](https://getbb.app) for an inline link, or paste a bare URL such as https://getbb.app. Hover a link to see its hover color. Focus it with the keyboard to see the focus ring.

## Blockquotes

> A single-paragraph quote carries a rule on its left edge and muted text.

> A quote with two paragraphs.
>
> The second paragraph should sit one quiet step below the first, not a full prose gap.
>
> - A list inside a quote
> - keeps its markers
>
> > A nested quote draws a second rule.

## Lists

### Unordered

- First item
- Second item with enough text to wrap onto a second line so the hanging indent shows where continuation lines align
  - Nested item
  - Nested sibling
    - Third level
    - Third-level sibling
- Third item

### Ordered

1. First step
2. Second step
   1. Nested step
   2. Nested sibling
3. Third step
4. Fourth step

### Mixed nesting

1. Ordered parent
   - Unordered child
   - Unordered sibling
2. Ordered sibling
   - Unordered child

- Unordered parent
  1. Ordered child
  2. Ordered sibling

### Tasks

- [ ] Open task
- [x] Completed task
- [ ] Task with enough text to wrap onto a second line so the checkbox alignment and the continuation indent both show
  - [ ] Nested open task
  - [x] Nested completed task
- [ ] Last task

## Code

Inline code sits in prose: run `bun run dev` before `bb plugin reload docs`.

```ts
export function greet(name: string): string {
  const greeting = `Hello, ${name}`;
  return greeting.length > 40 ? greeting.slice(0, 40) : greeting; // trim long names
}
```

A fenced block can break out of the prose measure to fit about 100 columns, then scrolls instead of wrapping:

```sh
bb docs pull plans --folder --vault personal --into ./docs-work && bb docs status ./docs-work --diff --verbose --show-ignored-paths
```

A fenced block without a language:

```
plain fenced text
  keeps its indentation
```

A `diagram` fence tightens its leading so box-drawing glyphs join into continuous lines:

```diagram
plugins/docs
├── app.tsx
├── docs
│   └── markdown-specimen.md
└── server.ts
```

## Tables

| Element    | Token           | Notes                                                                   |
| ---------- | --------------- | ----------------------------------------------------------------------- |
| Heading    | `prose-heading` | Display text                                                            |
| Link       | `prose-link`    | [Underlined](https://getbb.app)                                         |
| Long cell  | —               | This cell holds enough text to wrap, so row height and padding show up. |
| **Strong** | `prose-strong`  | _Italic_ and ~~struck~~ text inside a cell                              |

## Image

![A placeholder image](./_attachments/specimen.svg)

## Horizontal rule

Text above the rule.

---

Text below the rule.

## Embedded HTML

::html{src="./markdown-specimen.html" height="160"}

## End

The last paragraph closes the document. The editor leaves generous room below it so the final line can scroll to the middle of the pane.
