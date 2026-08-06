import type { Metadata } from "next"
import { Head } from "nextra/components"

import { TooltipProvider } from "@/components/ui/tooltip"

import "nextra-theme-docs/style.css"
import "./globals.css"

export const metadata: Metadata = {
  description: "A human-friendly pull request review guide.",
  title: "Pull request walkthrough",
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html className="dark" dir="ltr" lang="en" suppressHydrationWarning>
      <Head />
      <body><TooltipProvider>{children}</TooltipProvider></body>
    </html>
  )
}
