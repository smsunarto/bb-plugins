import { useMDXComponents as getNextraComponents } from "nextra/mdx-components"

const nextraComponents = getNextraComponents()
type NextraComponents = typeof nextraComponents

export function useMDXComponents(components: Partial<NextraComponents> = {}): NextraComponents {
  return {
    ...nextraComponents,
    ...components,
  }
}
