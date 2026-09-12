# Generate Canvas files with Eta

```sh
bb canvas generate review --data /absolute/review.json --out /absolute/review.canvas.mdx
```

Choose `review`, `issue`, or `pull-request`. The generator uses bundled Eta templates. It reads JSON and writes the result through BB's host file API on the thread's host. Outside a thread, pass `--host <host-id>`. Relative paths resolve against the invoking command's working directory. `--json` returns the output path, host ID, and template name.

The output must be a new `.canvas.mdx` path. Existing files are preserved. Edit an existing document directly or generate to a new path for comparison. Invalid data, malformed MDX, unsupported components, nonliteral props, and output larger than 2 MiB fail before writing.

## Data contract

```json
{
  "title": "Cache refresh: preserve the last successful value",
  "summary": "- A failed refresh keeps the last successful value.",
  "why": "Readers can continue while the upstream service recovers.",
  "sections": [
    {
      "title": "Evidence",
      "body": "Add the inspected source link and exact relevant excerpt here.",
      "collapsible": true
    }
  ]
}
```

This is a shape example, not verified change evidence. Replace it with actual content before delivery. The populated examples are in `../examples/review.json`, `../examples/issue.json`, and `../examples/pull-request.json`.

- All templates require `title` and `summary`. `context` is optional Markdown below the title. `sections` defaults to an empty list.
- Each section requires a one-line `title` and nonempty Markdown/Canvas `body`.
- Review also accepts `why` and collapsible sections, which start closed.
- Issue also accepts `steps` (strings), `expected`, and `actual`.
- Unsupported fields fail rather than disappearing from the output. Empty optional sections should be omitted.

## Markdown and JSX

Eta runs only during generation. JSON content is not recursively evaluated as template code. The templates use `autoEscape: false` and `autoTrim: false` to preserve Markdown and whitespace. Input bodies are authored Markdown/Canvas content, not arbitrary text escaped for HTML. If you need to display literal MDX metacharacters, quote them as code or serialize them into a component prop.

Serialize component values with `JSON.stringify`. For example, construct a `Source` body in a data-authoring script:

```ts
const body = `<Source path={${JSON.stringify(path)}} content={${JSON.stringify(code)}} />`;
```

This preserves quotes, braces, backticks, and line breaks without delimiter collisions. The generator parses and validates the complete result using Canvas's existing validator. It does not execute imports or expressions in the generated Canvas.

## Template ownership

Bundled `.eta` files are trusted plugin code, compiled once per template per plugin process. The command deliberately accepts template names, not user-provided executable template paths. Add reusable layouts by editing the plugin's bundled templates, then build and reload the plugin. All template data stays inline in the final Canvas.
