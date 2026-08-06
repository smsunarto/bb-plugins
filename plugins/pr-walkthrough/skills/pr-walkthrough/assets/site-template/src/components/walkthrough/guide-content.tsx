import type { ReactNode } from "react"

import type { WalkthroughGuideBlock } from "@/data/walkthrough"

export function GuideContent({ blocks }: { blocks: readonly WalkthroughGuideBlock[] }) {
  const content: ReactNode[] = []
  const seenKeys = new Map<string, number>()

  for (const block of blocks) {
    const blockValue = block.type === "code" ? block.code : block.type === "list" ? block.items.join("|") : block.text
    const keySource = `${block.type}-${blockValue}`
    const keyOccurrence = seenKeys.get(keySource) ?? 0
    seenKeys.set(keySource, keyOccurrence + 1)
    const key = `${keySource}-${keyOccurrence}`

    if (block.type === "list") {
      const List = block.ordered ? "ol" : "ul"
      const seenItems = new Map<string, number>()
      content.push(
        <List className={`space-y-1 pl-5 text-sm leading-6 text-muted-foreground ${block.ordered ? "list-decimal" : "list-disc"}`} key={key}>
          {block.items.map((item) => {
            const occurrence = seenItems.get(item) ?? 0
            seenItems.set(item, occurrence + 1)
            return <li key={`${key}-${item}-${occurrence}`}>{item}</li>
          })}
        </List>,
      )
    } else if (block.type === "quote") {
      content.push(<blockquote className="border-l-2 border-primary/50 pl-3 text-sm leading-6 text-muted-foreground" key={key}>{block.text}</blockquote>)
    } else if (block.type === "code") {
      content.push(
        <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-5" key={key}>
          <code data-language={block.language}>{block.code}</code>
        </pre>,
      )
    } else {
      content.push(<p className="text-sm leading-6 text-muted-foreground" key={key}>{block.text}</p>)
    }
  }

  return <div className="space-y-3">{content}</div>
}
