# disk-clean: Storage and Insights grow while the disk is walked

User ask (2026-10-12): "any reason we cannot start showing insights or storage while we scan? why do
we need to wait", then "folder size can still be shown but it can change, what's the issue in having
a live view that grows as we scan?"

## Today

Both tabs wait for the end of the one disk walk:

- `walk::consume` (`cli/src/walk.rs:596`) sums each folder into its parent when the folder finishes
  (`pop`, `walk.rs:265`) and pushes finished folders of at least `map_min_kb` and depth up to
  `map_depth` into `Walk.map`. Insights counters fill `Walk.insights` as files are seen.
- After `run_walk` returns, `scan.rs:598-654` writes `map.tsv` and `insights.json`, builds the tree
  with `review::load_map`, and emits one `walked` event `{home, tree, insights, worktrees}`.
- The page sets `tree` and `insights` from `walked` only (`web/src/lib/scan-feed.ts:184`). Until
  then Storage says "No storage map in this run" and Insights says "Re-run the scan ...", which are
  wrong while a scan is running.

## What changes

### Rust: a `growing` event about once a second during the walk

- The walk's `progress` callback (called every 4096 entries, `walk.rs:620`) also receives the open
  folders: the frames on `consume`'s stack that pass `pop`'s "mapped" rule, as rows shaped like
  `Walk.map`. That rule moves into one function in `walk.rs` used by both `pop` and the progress
  call. An open folder's size so far is its own `blocks` (its files plus its finished children)
  plus every open folder below it on the stack; without that last part `/` and `/Users` sit at 0
  while `~` is open. That size only grows, and the "mapped" rule is applied to it. The list is empty exactly when no map is being built (`map_depth` is `None` after the first walk,
  `scan.rs:290`), which is how the callback knows to send `tree: null`.
- In `scan.rs`, the callback emits `growing` at most once a second (its own `Instant`, separate from
  `progress`'s throttle): `{tree, insights}`.
  - `tree`: the finished folders in `Walk.map` plus those open rows. A folder's parent is always
    either finished or open, and an open folder's size so far is at least that of anything inside
    it, finished or open, so the tree stays connected under the same cutoff.
  - The tree is built by the code `load_map` uses today: split `load_map` into reading `map.tsv`
    and one function that builds the `Node` from rows. Both the file path and `growing` call it; no
    second tree builder. During the walk the root keeps its partial size; the `used` substitution
    (`review.rs`, `util::is_root(&root) && used > root_size`) applies only to the final tree.
  - `insights`: `insights::to_json` takes `&Insights` instead of the value (the heap of largest
    files is cloned for the sorted list), so the walk keeps accumulating. The final call after the
    walk stays as it is.
  - Only the first walk (the data volume, the one with `map_depth`) sends `growing`; the extra
    drives and the `DISK_CLEAN_SKIP_MAP` walk send insights only (`tree: null`).
- `Live::emit` (`review.rs:387`): when it appends a `growing` event it blanks the text of the
  previous `growing` entry in `log.events` (same index, empty string), so the backlog replayed to a
  new tab holds one snapshot, not one per second. Index-based `sent` counters in `stream_events`
  keep working because the length is unchanged by blanking.
- `walked` stays exactly as it is and is the final word: same payload, same files written.

### Page

- `scan-feed.ts`: a `growing` handler sets `insights`, and sets `tree` only when the event's `tree`
  is not null (the extra-drive walks send `tree: null` after the data-volume walk; the tree from the
  first walk stays). `walked` still sets both and `walked: true`. Add `growing` to `SCAN_TYPES` (`lib/db.ts:31`) and to the event
  union.
- Storage while `!scan.walked` and a tree is present:
  - The chart and inspector work as normal on the partial tree (zoom, hover, breadcrumbs). A
    zoomed folder that is not in the next snapshot yet keeps the current focus logic
    (`focusOf` falls back to the root).
  - The reconciliation rows say "so far". `scan.home` is only set by `walked`, so during the walk
    "Your home folder · so far" is the size of the home node in the growing tree, "Rest of the data
    volume · so far" is the root's size so far minus that, and one extra row "Not read yet" is
    `used - root so far` while it is above 0. The reserve stays `total - used - free` (outside
    `used`), so the rows still add up to the total. Disk total, used and free come from the `disk`
    event and are exact from the start. After `walked` the rows are exactly today's.
  - No tree yet (first second of the walk): "Reading the disk ..." instead of "No storage map in
    this run". The "Re-run the scan" text stays for a finished scan with no map.
- Insights while `!scan.walked` and insights are present: the charts render from the snapshot, and
  the tab header says "Still reading the disk; these numbers grow until it finishes." No insights
  yet: the same "Reading the disk ..." line instead of "Re-run the scan ...".
- Chart redraws on each snapshot without replaying its intro. The renderer is already
  `motion({initial: false})` (`storage.tsx:33`); confirm at runtime and change code only if it
  replays.

## Not changing

The walk order, what is measured, `map.tsv` and `insights.json` contents, the `walked` and `done`
events, the Cleanup tab's streaming, and the 200 MB / depth 5 map defaults.

## Tests

- Rust: a walk over a temp tree with a progress callback that records snapshots: every snapshot is
  a connected tree; each folder's size never shrinks between snapshots; the last snapshot's
  finished folders equal the final `map.tsv` rows. `to_json(&acc)` twice gives the same JSON and the
  accumulator is still usable.
- Rust: `Live` keeps one non-empty `growing` entry in the backlog after several emits.
- Page (roles and text only): feed `disk`, two `growing`, then `walked`; Storage shows the chart
  and "so far" labels and the "Not read yet" row before `walked`, and neither after; a `growing`
  with `tree: null` keeps the earlier tree; Insights shows the still-reading line before `walked`
  only. (The overview share card lives on the `share-card` branch; its own spec already makes it
  wait for the finished scan.) Add the test file to the Firefox `app` include list in `vite.config.ts`.
- Runtime: run `review` on this machine, open Storage during the walk, check it grows, check the
  console has no errors, and check the final tree equals a run of the released binary.
