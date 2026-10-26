<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/benjitaylor/agentation/main/package/logo-dark.svg">
  <img src="https://raw.githubusercontent.com/benjitaylor/agentation/main/package/logo.svg" alt="Agentation" width="180">
</picture>

<br>

[![npm version](https://img.shields.io/npm/v/agentation)](https://www.npmjs.com/package/agentation)
[![downloads](https://img.shields.io/npm/dm/agentation)](https://www.npmjs.com/package/agentation)

**[Agentation](https://agentation.com)** is an agent-agnostic visual feedback tool. Click elements on your page, add notes, and copy structured output that helps AI coding agents find the exact code you're referring to.

## Install

```bash
npm install agentation -D
```

## Usage

```tsx
import { Agentation } from 'agentation';

function App() {
  return (
    <>
      <YourApp />
      <Agentation />
    </>
  );
}
```

The toolbar appears in the bottom-right corner. Click to activate, then click any element to annotate it.

## Connect to your agent

`<Agentation />` works locally for copying feedback. To sync annotations to an
MCP server, provide its HTTP URL explicitly:

```tsx
<Agentation endpoint="http://localhost:4747" />
```

Configure your coding agent to run `npx -y agentation-mcp server`. Use the same
server and port in both places. A healthy MCP server alone does not connect the
browser: create a test annotation and ask your agent to read
`agentation_get_all_pending`, confirming the exact comment and page. See the
[MCP setup guide](https://agentation.com/mcp) for the complete flow.

## Features

- **Click to annotate** – Click any element with automatic selector identification
- **Text selection** – Select text to annotate specific content
- **Multi-select** – Hold Cmd/Ctrl to build a selection by clicking elements individually, or drag to select multiple at once
- **Area selection** – Drag to annotate any region, even empty space
- **Animation pause** – Pause supported CSS animations, Web Animations, and videos to capture specific states
- **Structured output** – Copy markdown with selectors, positions, and context
- **Programmatic access** – Callback prop for direct integration with tools
- **Dark/light mode** – Toggle in settings, persists to localStorage
- **Zero dependencies** – No runtime libraries beyond the React peer dependencies

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `onAnnotationAdd` | `(annotation: Annotation) => void` | - | Called when an annotation is created |
| `onAnnotationDelete` | `(annotation: Annotation) => void` | - | Called when an annotation is deleted |
| `onAnnotationUpdate` | `(annotation: Annotation) => void` | - | Called when an annotation is edited |
| `onAnnotationsClear` | `(annotations: Annotation[]) => void` | - | Called when all annotations are cleared |
| `onCopy` | `(output: string) => void` | - | Callback with formatted output after a Copy attempt, even if clipboard access fails |
| `onSubmit` | `(output: string, annotations: Annotation[]) => void \| Promise<void>` | - | Called when "Send Annotations" is clicked; awaited, and a rejection marks the send as failed and keeps the feedback |
| `copyToClipboard` | `boolean` | `true` | Set to false to prevent writing to clipboard |
| `endpoint` | `string` | - | Server URL for Agent Sync (e.g., `"http://localhost:4747"`) |
| `sessionId` | `string` | - | Pre-existing session ID to join |
| `onSessionCreated` | `(sessionId: string) => void` | - | Called when a new session is created |
| `webhookUrl` | `string` | - | Webhook URL to receive annotation events |
| `className` | `string` | - | Class applied to the toolbar host, for positioning, z-index or hiding it |
| `useHashLocation` | `boolean` | `false` | Separate feedback, layout state and sessions by pathname plus hash |
| `appName` | `string` | - | Identify the app in copied and submitted feedback |
| `enableKeyboardShortcuts` | `boolean` | `true` | Enable global shortcuts; popup Enter/Escape and button activation remain available |
| `identifyingAttributes` | `readonly string[]` | See below | Attributes captured from the selected element for identification |
| `copyFormat` | `"markdown"`, `"source"`, `"classes"`, or attribute option | `"markdown"` | Choose the Copy output; Send still receives structured markdown and annotations |
| `onOpenSource` | `(sourceFile: string) => void` | - | Show Open in editor when source metadata is available |
| `portalContainer` | `HTMLElement \| ShadowRoot \| null` | `document.body` | Place Agentation inside a host modal or popover's focus boundary |

### App identity, selectors and copying

```tsx
<Agentation
  appName="Checkout preview"
  enableKeyboardShortcuts={false}
  identifyingAttributes={["data-testid", "data-qa"]}
  copyFormat={{ attribute: "data-qa" }}
/>
```

The default identifying attributes are `data-testid`, `data-test`, `data-qa`,
`data-cy` and `data-component`. Supplying a list replaces those defaults. Values
are captured in `annotation.attributes`; up to two short `data-*` values also
appear as escaped attribute selectors in the element path. Capture is limited
to 16 names and 500 characters per value. Choose attributes intended for sharing.

`copyFormat` accepts `"markdown"`, `"source"`, `"classes"`,
or `{ attribute: "data-qa" }`. Metadata formats produce unique values on
separate lines. An explicitly requested attribute is captured automatically;
when present, its annotation can be saved without a comment. Missing metadata
does not overwrite the clipboard or clear feedback. This option changes Copy
only, including the `onCopy` callback.

`onOpenSource` receives a detected `path:line:column` reference. The host decides
how to open it, for example by calling its existing editor integration:

```tsx
<Agentation onOpenSource={(sourceFile) => openInEditor(sourceFile)} />
```

The action is hidden when no trustworthy source location is available. React
development metadata is best effort and may be unavailable in production builds.

### Host modals and popovers

Pass the active overlay's content element, using a callback ref so changes
rerender Agentation:

```tsx
const [feedbackContainer, setFeedbackContainer] = useState<HTMLElement | null>(null);

<Dialog.Popup ref={setFeedbackContainer}>{/* dialog content */}</Dialog.Popup>
<Agentation portalContainer={feedbackContainer} />
```

The container must belong to the same document as Agentation. Switching it
moves the existing portal and preserves the feedback draft. On browsers with
the native Popover API, Agentation uses a manual top-layer surface while keeping
its DOM inside the host focus boundary. This also avoids clipping by a
transformed modal. Older browsers fall back to an ordinary portal and may still
be affected by the host's overflow or transforms. Modal libraries that explicitly
filter Shadow DOM focus targets may require an additional host integration.

### Embedded pages

Same-origin iframes support picking, nested frames, open shadow roots, borders,
axis-aligned scaling, child scrolling and frame navigation/removal. Saved single
element markers track their child document and hide while outside its viewport
or while the frame shows another URL. Frame context is preserved through MCP.

Cross-origin frames remain a browser security boundary: Agentation can select
the frame element, but cannot inspect its contents. Rotated/skewed frames and
moving multi-element groups across frame boundaries are not supported by this
coordinate model. Group geometry remains a snapshot.

### Hash-based routing

For an app whose routes live in the URL fragment, enable hash location tracking:

```tsx
<Agentation useHashLocation endpoint="http://localhost:4747" />
```

Hash changes and browser Back/Forward update automatically. If your router calls `history.pushState` or `history.replaceState` without emitting a navigation event, render Agentation from a component that subscribes to that router's location so it rerenders on navigation. This option does not patch the browser's history methods.

`/app#/inbox` and `/app#/settings` keep separate notes, layout state and default
MCP sessions. Hash changes and browser back/forward switch the active page while
keeping the toolbar open. Pending selection and unsaved popup text are cancelled
on navigation; saved feedback stays with its route. Query strings do not create
additional storage buckets. Ordinary anchor links retain the existing behavior
unless this option is enabled.

If you supply an explicit `sessionId`, Agentation joins that session and displays
the annotations whose URLs match the active route. Without one, sessions are
created and remembered separately for each route.

Existing pathname-only data is preserved in its original storage bucket. It is
not automatically reassigned to the first hash route visited, because the old
data may contain notes from several routes. Review or export those notes with
the option disabled before enabling it on an existing installation.

### Programmatic Integration

Use callbacks to receive annotation data directly:

```tsx
import { Agentation, type Annotation } from 'agentation';

function App() {
  const handleAnnotation = (annotation: Annotation) => {
    // Structured data - no parsing needed
    console.log(annotation.element);      // "Button"
    console.log(annotation.elementPath);  // "body > div > button"
    console.log(annotation.boundingBox);  // { x, y, width, height }
    console.log(annotation.cssClasses);   // "btn btn-primary"

    // Send to your agent, API, etc.
    sendToAgent(annotation);
  };

  return (
    <>
      <YourApp />
      <Agentation
        onAnnotationAdd={handleAnnotation}
        copyToClipboard={false}  // Don't write to clipboard
      />
    </>
  );
}
```

### Annotation Type

```typescript
type Annotation = {
  id: string;
  x: number;                    // % of viewport width
  y: number;                    // px from top of document (absolute) OR viewport (if isFixed)
  comment: string;              // User's note
  element: string;              // e.g., "Button"
  elementPath: string;          // e.g., "body > div > button"
  timestamp: number;

  // Optional metadata (when available)
  selectedText?: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
  sourceFile?: string;          // Detected source path and position, when available
  attributes?: Record<string, string>; // Explicit identifying attributes
  nearbyText?: string;
  cssClasses?: string;
  nearbyElements?: string;
  computedStyles?: string;
  fullPath?: string;
  accessibility?: string;
  isMultiSelect?: boolean;
  isFixed?: boolean;
};
```

> **Note:** This is a simplified type. The full type includes additional fields for Agent Sync (`url`, `status`, `thread`, `reactComponents`, etc.). See [agentation.com/schema](https://agentation.com/schema) for the complete schema.

## How it works

Agentation captures class names, selectors, and element positions so AI agents can `grep` for the exact code you're referring to. Instead of describing "the blue button in the sidebar," you give the agent `.sidebar > button.primary` and your feedback.

## Requirements

- React 18+
- Desktop browser (mobile not supported)

## Docs

Full documentation at [agentation.com](https://agentation.com)

## License

© 2026 Benji Taylor

Licensed under PolyForm Shield 1.0.0
