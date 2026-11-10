import {treemapSquarify, type HierarchyRectangularNode} from 'd3-hierarchy'

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

export function squarifyInBounds<T>(node: HierarchyRectangularNode<T>, x0: number, y0: number, x1: number, y1: number) {
  treemapSquarify(node, x0, y0, x1, y1)
  for (const child of node.children ?? []) {
    child.x0 = clamp(child.x0, x0, x1)
    child.x1 = clamp(child.x1, x0, x1)
    child.y0 = clamp(child.y0, y0, y1)
    child.y1 = clamp(child.y1, y0, y1)
  }
}
