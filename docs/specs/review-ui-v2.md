# disk-clean review UI v2

## Goal

Replace the hand-written `cli/assets/page.html` with a React app that is easier to trust and to read,
and show everything the scan already learns about the disk, not only the cleanup list.

## Decisions

- Stack: Vite, React 19, shadcn on Base UI, Tailwind v4, `@tanstack/charts` (pinned, alpha).
  No TanStack Start: the Rust binary is the server, the page is one static file.
- Delivery: `disk-clean/web/` builds one self-contained `cli/assets/page.html`
  (vite-plugin-singlefile). The built file is committed so `cargo build` needs no Node.
  CI rebuilds it and fails when the committed file differs.
- Data handoff: the page holds `<script id="disk-clean-data" type="application/json">__DATA__</script>`
  and `<meta name="disk-clean-token" content="__TOKEN__">`. Rust escapes `</` as `<\/` in the JSON.
  In `vite dev` the app loads `web/dev/fixture.json` instead.
- Endpoints unchanged: `POST /preview`, `POST /decide`.
- Test projects (`pnpm test` runs them all): `app *` is the functional suite and the only one CI
  runs. `perf`, `frames` and `realtime` are a local gate, not on CI runners: they measure React work,
  frame budgets and real-time film playback (frame rate, film seconds, work per frame), which a
  shared GPU-less runner cannot hold. `pnpm run test:slow` runs `app *` the way CI's macOS runner
  does: Firefox with software WebGL and software WebRender, Chromium with `--disable-gpu` and 4x CPU
  throttling. `app firefox software-gl` always runs the movie on software WebGL: the burning
  backdrop times one 64 px draw and drops itself when the GPU is too slow, so the film still plays.

## Layout (approved mockup C, https://claude.ai/artifact/8L2K5Exn7Z3WCWgrkKisFM)

Tabs: Cleanup, Storage, Insights.

- Header strip on every tab: donut (used / selected / free after, TanStack donut with center total),
  big "selected to free" number, one summary line.
- Cleanup: List | Cards toggle (remembered in localStorage).
  - List: sidebar of sections grouped Safe / Review first / Report only, each with a tri-state
    section checkbox, size, size bar, picked count; table of the open section's items with
    checkbox, path, note, idle days, size; search, sort, quick-select (all / idle 90+ / idle 1y+ / none).
  - Cards: grid of section cards with the same checkbox, size, picked count, description,
    "Show items" (switches to List on that section).
  - Footer: count and total, Cancel, Preview commands (dry-run dialog), Approve and delete
    (two-step confirm when any review item is picked).
- Storage: Sunburst | Treemap toggle over the home tree (`map.tsv`), click to drill in,
  breadcrumbs to go back, cleanable folders outlined; whole-disk reconciliation rows below.
- Insights: charts from the new scan data below.
- Dry-run dialog: stats (folders, worktrees, repos pruned, fixed commands), Commands and Rejected
  tabs, copy as shell script, Approve.

## New scan data (Rust)

Collected during the existing walk from metadata it already reads; written as `insights.json`
in the run dir and passed to the page as `insights` (absent for older runs, the page hides the tab).

- `modified_by_day`: allocated bytes and file count by last-modified day for the last 365 days
  (calendar heatmap).
- `age_by_folder`: allocated bytes for each top folder under `~` (depth 2, the 12 largest)
  by last-modified bucket: <1 week, <1 month, <3 months, <6 months, <1 year, <2 years, older
  (folder x age heatmap).
- `by_kind`: allocated bytes and file count by kind from the file extension or folder
  (video, images, audio, archives, disk images, documents, code, dependencies (node_modules,
  .venv, target), git objects, caches, other) (bar or donut).
- `largest_files`: the 25 largest files under `~` with size and last-modified time.
- Cleanup section x age heatmap is derived in the page from `scan.tsv` ages, no Rust change.

## Out of scope

Light theme polish beyond tokens, i18n, TanStack Router.
