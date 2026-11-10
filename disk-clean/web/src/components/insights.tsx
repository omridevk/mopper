import {barX, cell, defineChart} from '@tanstack/charts'
import {Chart} from '@tanstack/charts/react/tooltip'
import {scaleBand} from '@tanstack/charts/scales/band'
import {scaleLinear as linear} from '@tanstack/charts/scales/linear'
import {scaleLinear} from 'd3-scale'
import {useMemo, type ReactNode} from 'react'
import {ChartBoundary} from './chart-boundary'
import {READING} from './storage'
import {BigBytes, CARD_TOOLTIP, CardLink, ChartCard, CopyPath, Fact, Meter, SelectForDelete, shareOf} from './chart-card'
import {formatBytes, sumBytes, type Category, type Insights as InsightsData, untilde} from '@/lib/data'
import {useDb} from '@/lib/db'
import {zoomLink, type Folder} from '@/lib/folders'
import {useHome} from '@/lib/page-data'
import {usePlatform} from '@/lib/platform'
import {useCategories, useFolders, useScanState} from '@/lib/views'

const HEAT = ['#18181b', '#60a5fa']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const IDLE_BUCKETS: [string, number][] = [
  ['today', 0],
  ['<1w', 7],
  ['<1m', 30],
  ['<3m', 90],
  ['<1y', 365],
  ['1y+', Infinity],
]

const INTERACTION = {tooltip: CARD_TOOLTIP, focusRing: false} as const

function dayTitle(day: string) {
  return new Date(`${day}T00:00`).toLocaleDateString('en', {weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'})
}

function heat(max: number) {
  return () => scaleLinear<string>().domain([0, Math.max(1, max)]).range(HEAT)
}

function Panel({title, hint, children, wide}: {title: string; hint: string; children: ReactNode; wide?: boolean}) {
  return (
    <section className={`flex flex-col gap-3 rounded-xl border bg-card p-4 ${wide ? 'col-span-2' : ''}`}>
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <ChartBoundary resetKey={title}>{children}</ChartBoundary>
    </section>
  )
}

function Calendar({days}: {days: InsightsData['modified_by_day']}) {
  const definition = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const start = new Date(today)
    start.setDate(start.getDate() - 364 - start.getDay())
    const byDay = new Map(days.map(d => [d.day, d]))
    const cells = []
    for (const date = new Date(start); date <= today; date.setDate(date.getDate() + 1)) {
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      const week = Math.floor((date.getTime() - start.getTime()) / (7 * 86_400_000))
      const found = byDay.get(day)
      cells.push({day, week: String(week), weekday: WEEKDAYS[date.getDay()] ?? '', bytes: found?.bytes ?? 0, files: found?.files ?? 0})
    }
    const weeks = [...new Set(cells.map(c => c.week))]
    const year = sumBytes(cells)
    const sorted = cells.map(c => c.bytes).toSorted((a, b) => a - b)
    const cap = sorted[Math.floor(sorted.length * 0.97)] ?? 1
    return defineChart({
      marks: [
        cell(cells.map(c => ({...c, year})), {
          x: 'week',
          y: 'weekday',
          color: row => Math.min(row.bytes, cap),
          key: 'day',
          inset: 1.5,
        }),
      ],
      scales: {
        x: {scale: () => scaleBand<string>().domain(weeks), axis: false},
        y: {scale: () => scaleBand<string>().domain(WEEKDAYS), axis: {label: ''}},
      },
      color: {scale: heat(cap)},
      ...INTERACTION,
    })
  }, [days])
  return (
    <Chart
      definition={definition}
      height={170}
      ariaLabel="Bytes by last-modified day over the past year"
      renderTooltipBody={({primaryPoint, pinned}) => {
        const d = primaryPoint?.datum
        return (
          d && (
            <ChartCard title={dayTitle(d.day)} pinned={pinned}>
              <BigBytes bytes={d.bytes} />
              <Fact label="Files changed" value={d.files.toLocaleString()} />
              <Meter label="of the past year's changes" share={shareOf(d.bytes, d.year)} />
            </ChartCard>
          )
        )
      }}
    />
  )
}

function FolderAge({data, folders}: {data: InsightsData['age_by_folder']; folders: ReadonlyMap<string, Folder>}) {
  const home = useHome()
  const {path} = usePlatform()
  const definition = useMemo(() => {
    const cells = data.folders.flatMap(f => data.buckets.map((bucket, i) => ({folder: f.path, bucket, bytes: f.bytes[i] ?? 0, total: f.bytes.reduce((s, b) => s + b, 0)})))
    const max = Math.max(...cells.map(c => c.bytes))
    return defineChart({
      marks: [cell(cells, {x: 'bucket', y: 'folder', color: 'bytes', key: row => `${row.folder}|${row.bucket}`, inset: 1.5})],
      scales: {
        x: {scale: () => scaleBand<string>().domain(data.buckets), axis: {label: 'Last modified'}},
        y: {scale: () => scaleBand<string>().domain(data.folders.map(f => f.path)), axis: {label: '', ticks: {format: path}}},
      },
      color: {scale: heat(max)},
      ...INTERACTION,
    })
  }, [data, path])
  return (
    <Chart
      definition={definition}
      height={36 + data.folders.length * 26}
      ariaLabel="Folder size by last-modified age"
      renderTooltipBody={({primaryPoint, pinned, dismiss}) => {
        const d = primaryPoint?.datum
        return (
          d && (
            <ChartCard
              title={d.folder.split('/').at(-1) || d.folder}
              subtitle={path(d.folder)}
              pinned={pinned}
              actions={
                <>
                  {folders.has(untilde(d.folder, home)) && (
                    <CardLink to={zoomLink(folders.get(untilde(d.folder, home)))} onClick={dismiss}>
                      Open in Storage
                    </CardLink>
                  )}
                  <CopyPath path={untilde(d.folder, home)} />
                  <SelectForDelete path={untilde(d.folder, home)} />
                </>
              }
            >
              <BigBytes bytes={d.bytes} />
              <Fact label="Last modified" value={d.bucket} />
              <Meter label="of this folder" share={shareOf(d.bytes, d.total)} />
            </ChartCard>
          )
        )
      }}
    />
  )
}

function Kinds({kinds}: {kinds: InsightsData['by_kind']}) {
  const definition = useMemo(() => {
    const total = sumBytes(kinds)
    return defineChart({
      marks: [barX(kinds.map(k => ({...k, total})), {x: 'bytes', y: 'kind', key: 'kind', fill: '#60a5fa', radius: 3, inset: 3})],
        scales: {
          x: {scale: linear, nice: true, grid: true, axis: {label: 'Bytes', ticks: {format: (v: number) => formatBytes(v)}}},
          y: {scale: () => scaleBand<string>().domain(kinds.map(k => k.kind)), axis: {label: ''}},
        },
      ...INTERACTION,
    })
  }, [kinds])
  return (
    <Chart
      definition={definition}
      height={40 + kinds.length * 26}
      ariaLabel="Bytes by file kind"
      renderTooltipBody={({primaryPoint, pinned}) => {
        const d = primaryPoint?.datum
        return (
          d && (
            <ChartCard title={d.kind} pinned={pinned}>
              <BigBytes bytes={d.bytes} />
              <Fact label="Files" value={d.files.toLocaleString()} />
              <Meter label="of all files by size" share={shareOf(d.bytes, d.total)} />
            </ChartCard>
          )
        )
      }}
    />
  )
}

function SectionAge({categories}: {categories: Category[]}) {
  const definition = useMemo(() => {
    const rows = categories.filter(c => c.items.some(i => i.age !== null))
    const cells = rows.flatMap(c =>
      IDLE_BUCKETS.map(([bucket], index) => {
        const low = index === 0 ? -1 : (IDLE_BUCKETS[index - 1]?.[1] ?? 0)
        const high = IDLE_BUCKETS[index]?.[1] ?? Infinity
        const items = c.items.filter(i => i.age !== null && i.age > low && i.age <= (index === 0 ? 0 : high))
        return {section: c.title, id: c.id, bucket, bytes: sumBytes(items), items: items.length, total: c.bytes}
      }),
    )
    const max = Math.max(...cells.map(c => c.bytes))
    return {
      height: 36 + rows.length * 26,
      chart: defineChart({
        marks: [cell(cells, {x: 'bucket', y: 'section', color: 'bytes', key: row => `${row.section}|${row.bucket}`, inset: 1.5})],
        scales: {
          x: {scale: () => scaleBand<string>().domain(IDLE_BUCKETS.map(([b]) => b)), axis: {label: 'Idle for'}},
          y: {scale: () => scaleBand<string>().domain(rows.map(c => c.title)), axis: {label: ''}},
        },
        color: {scale: heat(max)},
        ...INTERACTION,
      }),
    }
  }, [categories])
  return (
    <Chart
      definition={definition.chart}
      height={definition.height}
      ariaLabel="Cleanup sections by idle time"
      renderTooltipBody={({primaryPoint, pinned, dismiss}) => {
        const d = primaryPoint?.datum
        return (
          d && (
            <ChartCard
              title={d.section}
              pinned={pinned}
              actions={
                <CardLink to={{to: '/cleanup/$section', params: {section: d.id}, search: true}} onClick={dismiss}>
                  Open in Cleanup
                </CardLink>
              }
            >
              <BigBytes bytes={d.bytes} />
              <Fact label="Idle for" value={d.bucket} />
              <Fact label="Items" value={d.items.toLocaleString()} />
              <Meter label="of this section" share={shareOf(d.bytes, d.total)} />
            </ChartCard>
          )
        )
      }}
    />
  )
}

export function Insights() {
  const db = useDb()
  const {insights, walked} = useScanState(db)
  const folders = useFolders(db)
  const categories = useCategories(db)
  const home = useHome()
  const {path} = usePlatform()
  return (
    <div className="grid grid-cols-2 gap-4 overflow-auto px-7 py-5">
      {insights && !walked && <p className="col-span-2 text-sm text-muted-foreground">Still reading the disk; these numbers grow until it finishes.</p>}
      {insights ? (
        <>
          <Panel wide title="When your files last changed" hint="Bytes by last-modified day over the past year. Bright days are when the disk filled.">
            <Calendar days={insights.modified_by_day} />
          </Panel>
          <Panel title="How old each big folder is" hint="Bytes in the largest folders under ~, by last-modified age.">
            <FolderAge data={insights.age_by_folder} folders={folders} />
          </Panel>
          <Panel title="What kind of data" hint="Bytes by file kind across your home folder.">
            <Kinds kinds={insights.by_kind} />
          </Panel>
        </>
      ) : (
        <p className="col-span-2 rounded-xl border p-4 text-sm text-muted-foreground">{walked ? 'Re-run the scan to see when and what filled the disk.' : READING}</p>
      )}
      <Panel title="Cleanup sections by idle time" hint="Bytes the Cleanup tab can act on, by days since last use.">
        <SectionAge categories={categories} />
      </Panel>
      {insights && (
        <Panel title="Largest files" hint="The biggest single files under ~.">
          <div className="flex max-h-80 flex-col overflow-auto">
            {insights.largest_files.map(f => (
              <div key={f.path} className="flex items-center gap-3 py-1 text-xs">
                <span className="grow truncate font-mono">{path(f.path)}</span>
                <span className="text-muted-foreground tabular-nums">{new Date(f.mtime * 1000).toLocaleDateString()}</span>
                <span className="w-16 text-right tabular-nums">{formatBytes(f.bytes)}</span>
                <SelectForDelete path={untilde(f.path, home)} />
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  )
}
