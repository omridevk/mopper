import {defineChart, findNearestPoint, type ChartFocusStrategy, type ChartPoint, type ChartScene, type ChartValue} from '@tanstack/charts'
import {whenFocused} from '@tanstack/charts/focus/mark'
import {sunburst, type SunburstNode} from '@tanstack/charts/hierarchy/sunburst'
import {treemap, type TreemapNode} from '@tanstack/charts/hierarchy/treemap'
import {motion} from '@tanstack/charts/motion'
import {polar} from '@tanstack/charts/polar'
import {RendererChart as Chart} from '@tanstack/charts/react/tooltip'
import {Link, useNavigate} from '@tanstack/react-router'
import {Fragment, useMemo, useRef, useState, type RefObject} from 'react'
import {Badge} from '@/components/ui/badge'
import {ChartBoundary} from './chart-boundary'
import {BigBytes, CARD_TOOLTIP, CardLink, ChartCard, changedAgo, CopyPath, Meter, shareOf} from './chart-card'
import {RISK_BAR} from './cleanup'
import {ToggleGroup, ToggleGroupItem} from '@/components/ui/toggle-group'
import {formatBytes, plural, tilde, type TreeNode} from '@/lib/data'
import {useDb} from '@/lib/db'
import {zoomLink, type Folder} from '@/lib/folders'
import {SHAPES, type Shape} from '@/lib/search'
import {useHome, useSelection} from '@/lib/page-data'
import {isDiskRoot, usePlatform} from '@/lib/platform'
import type {Disk} from '@/lib/scan-feed'
import {useCleanable, useDisk, useFolders, useInside, useScanState} from '@/lib/views'
import {squarifyInBounds} from '@/lib/treemap-tile'

interface Row {
  id: string
  parent: string | undefined
  name: string
  value: number
  node: TreeNode
}

const renderer = motion({initial: false})

export const SHAPE_LABEL: Record<Shape, string> = {sunburst: 'Sunburst', treemap: 'Treemap'}

const HUES = [210, 28, 152, 340, 265, 46, 190, 120, 8, 300, 172, 65]

function tone(hue: number, depth: number) {
  const level = Math.min(Math.max(depth, 1), 3) - 1
  return `hsl(${hue} ${[62, 52, 44][level]}% ${[52, 60, 67][level]}%)`
}

function flatten(root: TreeNode): {rows: Row[]; parents: Map<string, TreeNode>; byPath: Map<string, TreeNode>} {
  const rows: Row[] = []
  const parents = new Map<string, TreeNode>()
  const byPath = new Map<string, TreeNode>()
  const visit = (node: TreeNode, parent: TreeNode | undefined) => {
    byPath.set(node.path, node)
    if (parent) parents.set(node.path, parent)
    rows.push({id: node.path, parent: parent?.path, name: node.name, value: node.children.length ? 0 : node.bytes, node})
    node.children.forEach(child => visit(child, node))
  }
  visit(root, undefined)
  return {rows, parents, byPath}
}

function subtree(root: TreeNode, depth: number): Row[] {
  const rows: Row[] = []
  const visit = (node: TreeNode, parent: string | undefined, level: number) => {
    const leaf = level === depth || node.children.length === 0
    rows.push({id: node.path, parent, name: node.name, value: leaf ? node.bytes : 0, node})
    if (!leaf) node.children.forEach(child => visit(child, node.path, level + 1))
  }
  visit(root, undefined, 0)
  return rows
}

function nodeOf(point: ChartPoint | null) {
  const datum = point?.datum as SunburstNode<Row> | TreemapNode<Row> | undefined
  return datum?.data?.node ?? null
}

function titleOf(node: TreeNode) {
  if (isDiskRoot(node.path)) return 'Whole disk'
  return node.name === '~' ? 'Home folder' : node.name
}

interface Figures extends Disk {
  home: number
  root?: number
}

export const READING = 'Reading the disk…'

interface FolderCardProps {
  node: TreeNode | null
  zoomTo: TreeNode | null
  folders: ReadonlyMap<string, Folder>
  parents: Map<string, TreeNode>
  total: number
  home: string
  pinned: boolean
  dismiss: () => void
}

function FolderCard({node, zoomTo, folders, parents, total, home, pinned, dismiss}: FolderCardProps) {
  const {path} = usePlatform()
  if (!node) return null
  const parent = parents.get(node.path)
  const top = node.children.filter(c => !c.rest).slice(0, 3)
  const actions = (
    <>
      {zoomTo && (
        <CardLink to={zoomLink(folders.get(zoomTo.path))} onClick={dismiss}>
          {zoomTo === node ? 'Zoom in' : `Zoom into ${zoomTo.name}`}
        </CardLink>
      )}
      <CopyPath path={node.path} />
    </>
  )
  return (
    <ChartCard title={titleOf(node)} subtitle={path(tilde(node.path, home))} hint={zoomTo ? 'Click to pin, then zoom in' : undefined} pinned={pinned} actions={actions}>
      <BigBytes bytes={node.bytes} />
      <div className="flex flex-col gap-2">
        {parent && <Meter label={`of ${titleOf(parent)}`} share={shareOf(node.bytes, parent.bytes)} />}
        <Meter label="of the disk" share={shareOf(node.bytes, total)} />
      </div>
      <Activity node={node} />
      {top.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t pt-2.5">
          {top.map(child => (
            <Meter key={child.path} label={child.name} value={formatBytes(child.bytes)} share={shareOf(child.bytes, node.bytes)} color="var(--color-zinc-500)" />
          ))}
        </div>
      )}
      <Cleanable path={node.path} />
    </ChartCard>
  )
}

function Activity({node}: {node: TreeNode}) {
  const parts = [node.files > 0 && plural(node.files, 'file', 'files'), node.mtime > 0 && `changed ${changedAgo(node.mtime)}`].filter(Boolean)
  if (parts.length === 0) return null
  return <div className="text-muted-foreground">{parts.join(' · ')}</div>
}

function Cleanable({path}: {path: string}) {
  const {bytes, count, selected, risk} = useInside(useDb(), path, useSelection().rowSelection)
  if (count === 0) return null
  return (
    <div className="flex items-center gap-2 border-t pt-2.5">
      <span className={`size-2 shrink-0 rounded-full ${RISK_BAR[risk]}`} />
      <span>
        {formatBytes(bytes)} cleanable in {plural(count, 'item', 'items')} · {formatBytes(selected)} selected
      </span>
    </div>
  )
}

function branchFocus<T extends {id: string; ancestorIds: readonly string[]}, X extends ChartValue, Y extends ChartValue>(
  scene: RefObject<ChartScene | null>,
): ChartFocusStrategy<T, X, Y> {
  return {
    resolve: (points, {x, y, maxDistance}) => {
      const hit = scene.current && findNearestPoint(scene.current, x, y, maxDistance)
      const point = hit && points.find(p => p.key === hit.key)
      return point ? [point] : []
    },
    group: (points, {point}) => {
      const ancestors = new Set(point.datum.ancestorIds)
      return [point, ...points.filter(p => p !== point && ancestors.has(p.datum.id))]
    },
    navigation: points => [...points].sort((a, b) => a.x - b.x || a.y - b.y),
  }
}

function Reconciliation({data}: {data: Figures}) {
  const {otherHint, reserved: reservedName, reservedHint, sharedBlocks} = usePlatform()
  const other = Math.max(0, (data.root ?? data.used) - data.home)
  const unread = data.root === undefined ? 0 : Math.max(0, data.used - data.root)
  const reserved = Math.max(0, data.total - data.used - data.free)
  const soFar = (name: string) => (data.root === undefined ? name : `${name} · so far`)
  const rows: [string, number, string, string][] = [
    [soFar('Your home folder'), data.home, 'bg-blue-400', 'everything under ~, mapped above'],
    [soFar('Rest of the data volume'), other, 'bg-zinc-500', otherHint],
    ...(unread > 0 ? [['Not read yet', unread, 'bg-zinc-700', ''] satisfies [string, number, string, string]] : []),
    [reservedName, reserved, 'bg-amber-500', reservedHint],
    ['Free right now', data.free, 'bg-emerald-500/50', ''],
  ]
  return (
    <section className="flex flex-col gap-1 rounded-xl border p-4">
      <h3 className="pb-2 text-sm font-semibold">Where your {formatBytes(data.total)} went</h3>
      {data.home > data.used && (
        <p className="pb-2 text-xs text-muted-foreground">
          du counts {formatBytes(data.home - data.used)} more than the disk holds: {sharedBlocks}
        </p>
      )}
      {rows.map(([name, bytes, color, hint]) => (
        <div key={name} className="grid grid-cols-[12px_minmax(0,1fr)_90px_56px] items-center gap-3 py-1.5">
          <span className={`size-2.5 rounded-[3px] ${color}`} />
          <span className="text-[13px]">
            {name}
            {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
          </span>
          <span className="text-right text-[13px] tabular-nums">{formatBytes(bytes)}</span>
          <span className="text-right text-xs text-muted-foreground tabular-nums">{((bytes / data.total) * 100).toFixed(1)}%</span>
        </div>
      ))}
      {data.snapshots > 0 && (
        <p className="pt-1 text-xs text-muted-foreground">
          {plural(data.snapshots, 'local Time Machine snapshot', 'local Time Machine snapshots')} {data.snapshots === 1 ? 'sits' : 'sit'} inside the reserve row; macOS
          purges them when space runs low.
        </p>
      )}
    </section>
  )
}

function storageDefinition(
  flat: ReturnType<typeof flatten>,
  tree: TreeNode,
  shape: Shape,
  focus: string,
  cleanable: Set<string>,
  scene: RefObject<ChartScene | null>,
) {
  const stroke = (node: {data: Row | null}) => (node.data && cleanable.has(node.data.id) ? '#fafafa' : '#0a0a0a')
  const focusNode = flat.byPath.get(focus)
  const hueOf = new Map((focusNode?.children ?? []).map((child, i) => [child.path, HUES[i % HUES.length] ?? 210]))
  const fill = (branch: string, depth: number) => tone(hueOf.get(branch) ?? 210, depth)
  const shared = {
    scales: {x: null, y: null},
    motion: {transition: {type: 'tween', duration: 480, easing: 'ease-in-out'}},
    tooltip: CARD_TOOLTIP,
    focusRing: false,
  } as const
  if (shape === 'sunburst') {
    const rings = (className?: string) =>
      polar({
        marks: [
          sunburst(flat.rows, {
            id: 'storage-sunburst',
            className,
            nodeId: 'id',
            parentId: 'parent',
            value: 'value',
            rootId: focus,
            visibleDepth: 3,
            innerRadius: ({radius}) => radius * 0.28,
            fill: node => fill(node.branchId ?? node.id, node.depth),
            stroke,
            strokeWidth: 1,
          }),
        ],
        scales: {angle: null, radius: null},
      })
    return defineChart({
      marks: [rings('storage-base'), whenFocused(rings(), {match: 'group'})],
      focus: branchFocus<SunburstNode<Row>, number, number>(scene),
      ...shared,
    })
  }
  return defineChart({
    marks: [
      treemap(subtree(flat.byPath.get(focus) ?? tree, 2), {
        id: 'storage-treemap',
        nodeId: 'id',
        parentId: 'parent',
        value: 'value',
        method: squarifyInBounds,
        fill: node => fill(node.ancestorIds[1] ?? node.id, node.depth),
        label: node => node.data?.name ?? node.name,
        labelFill: '#09090b',
        radius: 3,
        stroke,
        strokeWidth: 1,
        states: [{when: {focus: 'unmatched'}, style: {opacity: 0.28}, transition: {type: 'tween', duration: 250, easing: 'ease-out'}}],
      }),
    ],
    focus: branchFocus<TreemapNode<Row>, string, number>(scene),
    ...shared,
  })
}

function useStorageDefinition(flat: ReturnType<typeof flatten> | null, tree: TreeNode | null, shape: Shape, focus: string, cleanable: Set<string>) {
  const scene = useRef<ChartScene | null>(null)
  const definition = useMemo(() => (flat && tree ? storageDefinition(flat, tree, shape, focus, cleanable, scene) : null), [flat, tree, shape, focus, cleanable])
  const onRender = ({scene: rendered}: {scene: ChartScene}) => {
    scene.current = rendered
  }
  return {definition, onRender}
}

function focusOf(flat: ReturnType<typeof flatten> | null, root: string, zoom: string) {
  return zoom && flat?.byPath.has(zoom) ? zoom : root
}

function useStorageData() {
  const db = useDb()
  const scan = useScanState(db)
  const disk = useDisk(db)
  return {data: {...disk, home: scan.home}, tree: scan.tree, walked: scan.walked, cleanable: useCleanable(db)}
}

function drillTarget(point: ChartPoint | null, flat: ReturnType<typeof flatten>, shape: Shape, focus: string) {
  let node = nodeOf(point)
  while (shape === 'treemap' && node) {
    const parent = flat.parents.get(node.path)
    if (!parent || parent.path === focus) break
    node = parent
  }
  return node?.children.length ? node : null
}

function Crumbs({chain, folders}: {chain: readonly TreeNode[]; folders: ReadonlyMap<string, Folder>}) {
  const {separator} = usePlatform()
  return (
    <nav aria-label="Folder path" className="flex grow flex-wrap items-center gap-1 text-sm">
      {chain.map((n, i) => (
        <Fragment key={n.path}>
          {i > 0 && <span className="text-muted-foreground">{separator}</span>}
          <Link
            {...zoomLink(folders.get(n.path))}
            activeOptions={{exact: true}}
            className={i === chain.length - 1 ? 'font-semibold' : `text-muted-foreground transition-[color] duration-(--duration-quick) ease-(--ease-smooth-out) motion-reduce:transition-none hover:text-foreground`}
          >
            {n.name}
          </Link>
        </Fragment>
      ))}
    </nav>
  )
}

function Details({shown, focusNode, total, cleanable, shape}: {shown: TreeNode; focusNode: TreeNode; total: number; cleanable: ReadonlySet<string>; shape: Shape}) {
  const {path} = usePlatform()
  return (
  <aside className="flex flex-col gap-2 border-l pl-5">
    <div className="font-mono text-xs break-all text-muted-foreground">{path(shown.path)}</div>
    <div className="text-3xl font-bold tracking-tight tabular-nums">{formatBytes(shown.bytes)}</div>
    <div className="text-xs text-muted-foreground">
      {((shown.bytes / total) * 100).toFixed(1)}% of the disk
      {shown !== focusNode ? ` · ${((shown.bytes / focusNode.bytes) * 100).toFixed(1)}% of ${focusNode.name}` : ''}
    </div>
    {cleanable.has(shown.path) && <Badge className="self-start bg-blue-400/15 text-blue-300">cleanable</Badge>}
    <div className="mt-2 flex flex-col gap-1 border-t pt-3">
      {shown.children.slice(0, 8).map(k => (
        <div key={k.path} className="flex items-center gap-2 text-xs">
          <span className={`grow truncate ${k.rest ? 'text-muted-foreground italic' : ''}`}>{k.name}</span>
          <span className="tabular-nums">{formatBytes(k.bytes)}</span>
        </div>
      ))}
    </div>
    <p className="mt-auto text-xs text-muted-foreground">
      Click a {shape === 'sunburst' ? 'ring' : 'tile'} to pin its card and zoom in from there, a crumb to go back. White outlines mark folders the Cleanup tab can delete.
    </p>
  </aside>
  )
}

function chainOf(parents: Map<string, TreeNode>, focus: TreeNode) {
  const chain: TreeNode[] = []
  for (let n: TreeNode | undefined = focus; n; n = parents.get(n.path)) chain.unshift(n)
  return chain
}

export function Storage({shape, zoom}: {shape: Shape; zoom: string}) {
  const {data, tree, walked, cleanable} = useStorageData()
  const home = useHome()
  const {path} = usePlatform()
  const folders = useFolders(useDb())
  const flat = useMemo(() => (tree ? flatten(tree) : null), [tree])
  const root = tree?.path ?? ''
  const focus = focusOf(flat, root, zoom)
  const navigate = useNavigate()
  const [hover, setHover] = useState<TreeNode | null>(null)
  const {definition, onRender} = useStorageDefinition(flat, tree, shape, focus, cleanable)
  const reshape = (next: Shape) => navigate({to: '.', search: prev => ({...prev, shape: next})})

  if (!tree || !flat || !definition) {
    return <div className="p-10 text-center text-sm text-muted-foreground">{walked ? 'No storage map in this run. Re-run the scan to build one.' : READING}</div>
  }
  const figures = walked ? data : {...data, home: flat.byPath.get(home)?.bytes ?? 0, root: tree.bytes}

  const focusNode = flat.byPath.get(focus) ?? tree
  const chain = chainOf(flat.parents, focusNode)
  const shown = hover ?? focusNode

  return (
    <div className="flex flex-col gap-5 overflow-auto px-7 py-5">
      <div className="flex items-center gap-3">
        <Crumbs chain={chain} folders={folders} />
        <ToggleGroup value={[shape]} onValueChange={v => v[0] && reshape(v[0] as Shape)} variant="outline" size="sm" aria-label="Chart">
          {SHAPES.map(next => (
            <ToggleGroupItem key={next} value={next}>
              {SHAPE_LABEL[next]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_280px] gap-6">
        <ChartBoundary resetKey={`${shape}:${focus}`}>
          <div className="storage-chart" data-hovering={hover !== null}>
            <Chart
              definition={definition}
              renderer={renderer}
              height={shape === 'sunburst' ? 520 : 480}
              ariaLabel={`Storage ${shape} of ${path(focusNode.path)}`}
              onFocusChange={point => setHover(nodeOf(point))}
              onRender={onRender}
              renderTooltipBody={({primaryPoint, pinned, dismiss}) => (
                <FolderCard
                  node={nodeOf(primaryPoint ?? null)}
                  zoomTo={drillTarget(primaryPoint ?? null, flat, shape, focus)}
                  folders={folders}
                  parents={flat.parents}
                  total={data.total}
                  home={home}
                  pinned={pinned}
                  dismiss={dismiss}
                />
              )}
            />
          </div>
        </ChartBoundary>
        <Details shown={shown} focusNode={focusNode} total={data.total} cleanable={cleanable} shape={shape} />
      </div>
      <Reconciliation data={figures} />
    </div>
  )
}
