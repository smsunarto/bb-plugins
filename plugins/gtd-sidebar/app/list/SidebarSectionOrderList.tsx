import type { ReactNode } from "react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { SidebarSectionId } from "../model/sidebar-section-id.js";
import type { ReorderDndContextProps } from "@/components/ui/use-reorder-dnd";

interface SidebarSectionOrderListProps {
  children: (sectionId: SidebarSectionId) => ReactNode;
  dndContextProps?: ReorderDndContextProps;
  order: readonly SidebarSectionId[];
  trailing?: ReactNode;
  className?: string;
}

export function SidebarSectionOrderList({
  children,
  dndContextProps,
  order,
  trailing,
  className = "space-y-4 max-md:pointer-coarse:space-y-8",
}: SidebarSectionOrderListProps) {
  const content = (
    <SortableContext items={[...order]} strategy={verticalListSortingStrategy}>
      <div className={className}>{order.map(children)}</div>
    </SortableContext>
  );

  return dndContextProps ? (
    <DndContext {...dndContextProps}>
      {content}
      {trailing}
    </DndContext>
  ) : (
    content
  );
}
