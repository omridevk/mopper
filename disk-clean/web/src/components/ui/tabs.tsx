"use client"

import type { ReactNode } from "react"
import { cva } from "class-variance-authority"
import { cn } from "cn"

import { useTabsPill } from "@/lib/motion"

const tabsListVariants = cva(
  "t-tabs group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "gap-0 bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const tabsPillVariants = cva("t-tabs-pill", {
  variants: {
    variant: {
      default: "top-1/2 h-[calc(100%-7px)] -translate-y-1/2 rounded-md border border-input bg-input/30 shadow-sm",
      line: "top-auto bottom-[-1.5px] h-0.5 rounded-none bg-foreground",
    },
  },
  defaultVariants: {
    variant: "default",
  },
})

function TabLinks({label, children}: {label: string; children: ReactNode}) {
  const { bar, pill } = useTabsPill<HTMLDivElement>('[aria-selected="true"]')
  return (
    <div ref={bar} role="tablist" aria-label={label} className={cn(tabsListVariants(), "h-8")}>
      <span ref={pill} aria-hidden className={tabsPillVariants()} />
      {children}
    </div>
  )
}

const TAB_LINK =
  "t-tab relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-muted-foreground hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring aria-selected:text-foreground"

export { TabLinks, TAB_LINK }
