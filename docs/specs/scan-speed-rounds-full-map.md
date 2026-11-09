# disk-clean: a fast scan, cleanup in rounds, a map that accounts for every byte

Decided 2026-11-09. The user: "takes forever to scan", "deleting a group doesn't allow you to
continue selecting for a next delete", "many many files and folders are missing making it
impossible to account for all the 500gb of used space". The user approved all three parts, built
on `live-scan`, merged to main.

## Measured baseline (v0.5.0, 2026-11-08, the user's Mac)

`disk-clean scan RUN_DIR` on a 460 GiB volume, 418 GB used, 11M files:

- 760 s wall clock, 28.9 s user CPU and 237.8 s system CPU. The process is mostly waiting, not
  working.
- 12.5 s sizing 26 fixed locations before the walk starts, then those locations are walked again by
  the full walk.
- 704 s for the walk. 56 s more until the 65 git worktree checks finish.
- map.tsv: 438 folders. 392 of the 451 GB sit in folders at the depth cap (5) that cannot be
  opened (`/private/var/folders/..` 36.7 GB, `~/Public/web/shortcode` 18.9 GB, `~/Library/Application
  Support/Claude` 13.3 GB, ...). 40.5 GB sits inside mapped folders under no label (folders under
  200 MB and loose files). No file is ever on the map.
- The Cleanup list has 13 categories. Nothing outside them can be deleted.
- After one approval the review app locks every row and says "a new cleanup starts with
  /disk-clean", which means a new 12-minute scan.

## A. The scan is fast

Causes found by reading the code, to be confirmed by measurement before and after each change:

- Every walk reader and the scan thread run at `QOS_CLASS_UTILITY` (`util::utility_qos`). macOS
  throttles the disk I/O of that class whenever anything else uses the disk.
- Only `hw.perflevel1.logicalcpu` reader threads (the efficiency cores, 6 here).
- One thread consumes every listing.
- The fixed locations are sized twice.

The shape:

- The walk and the scan run at the default QoS. The user is waiting on this scan, in the
  foreground. Worktree checks and the Docker / simulator probes may stay at utility.
- Reader threads: as many as help, measured. Start from all logical CPUs and try more (the walk is
  I/O bound, APFS on SSD answers many requests in parallel). Pick the count from measurements on
  this machine and keep it a function of the core count, not a constant.
- If the single consumer is the bottleneck after the above, make it parallel. Measure first.
- The fixed locations are sized once. They still appear on the page early (delete-while-scanning
  depends on it); the full walk reuses those sizes instead of walking those folders again, or the
  walk reaches them first. Whichever is simpler, as long as the numbers stay identical.
- The SKILL.md line "one to three minutes" states what the scan takes after this work, measured.

Acceptance: `disk-clean scan` on the user's real disk (read only, safe) at least 3x faster than the
760 s baseline in wall clock, with the same item count and the same totals within 1 % (the disk
changes between runs). Report both runs: wall, user, sys, walk seconds, item count, map rows.

## B. Cleanup in rounds

Build `one-session.md` as decided there (Claude stays in the loop for every cleanup, the session
never ends on its own, approval never cancels the scan). Recheck its "Today" section against the
current code first: trash.md, rescan.md and live-scan.md have landed since it was written, so
update that spec where the code moved, keeping every decision in it.

What the user must be able to do, end to end:

1. Run /disk-clean. The page opens and fills in.
2. Select a group, Delete, confirm. Claude shows the dry run and runs it.
3. Without reloading, without a new scan: the deleted rows leave the list (or show as moved to the
   Trash and are no longer selectable), every other row is selectable again, the totals and the
   disk numbers update, and the user selects the next group and deletes again. Then again.
4. Undo and Empty keep working per cleanup round.
5. The session ends when the user tells Claude they are done (`disk-clean stop RUN_DIR`).

## C. A map that accounts for every byte, and you can delete from it

### Server

- No depth cap. `DISK_CLEAN_MAP_DEPTH` goes away.
- The walk records every folder of at least `DISK_CLEAN_INDEX_MIN_BYTES` (default 10 MB) at any
  depth into an index kept in memory and written to the run dir as `index.tsv` (same columns as
  map.tsv), so `review RUN_DIR` serves it too. map.tsv and the `tree` in `growing` / `walked` keep
  the 200 MB floor, at any depth.
- `POST /children {token, path}` answers one folder's contents, sorted by size (a POST like the
  other page calls, so the path never sits in a URL):
  - subfolders from the index, with size, file count and modified time;
  - files of at least 1 MB, read from the folder at request time (one `read_dir`, allocated size,
    hard links counted once as the walk counts them);
  - one remainder entry, "N smaller items", with the bytes that make the listed entries add up
    exactly to the folder's size from the walk.
  - A path not in the index answers 404. A wrong token answers 403.
- Every folder in the page tree and every `/children` answer adds up to its parent's size. The
  remainder entry is what makes it add up; it is never negative (if a folder changed since the
  walk, clamp to zero and the parent shows the walk's size).

### Page

- Storage zooms into any folder at any depth. When the page tree has no children for a folder, it
  asks `/children` and draws the answer the same way (sunburst, treemap, inspector). The remainder
  entry is drawn as one neutral slice / tile named "N smaller items".
- Every folder the page opens is loaded once, also a folder already on the first map (its small
  contents were one "everything else" slice there); subfolders the map already drew keep their
  drawn children.
- The Storage address keeps working for any depth (`/storage/<folder token>`), reload included: the
  page keeps the token of every folder it loaded in sessionStorage, and a reload loads the folders
  on the way down again. Loaded folders and folders moved by a round survive the replayed `walked`
  event.
- Any folder or file in Storage can be added to the cleanup: a "Add to cleanup" action in the
  inspector, once the scan has finished (during the scan `scan.tsv` is still being written). The
  server checks it with the same safety rules `clean` uses (`safe_to_remove` and
  the protected paths); a refusal shows its reason and adds nothing. An accepted path becomes a row
  of a "Picked by you" section, risk `review`, selected, and goes through the same confirm,
  dry run, Trash, Undo and Empty as every other row. A picked path inside an already listed path,
  or containing one, counts once, as today.
- After a cleanup round (B) the map shrinks by what was moved: folders moved to the Trash leave the
  map and their parents get smaller, without a rescan.

## Tests

- Rust: the index has no depth cap and keeps the floor; `/children` adds up exactly, including the
  remainder and hard links; a path outside the index is a 404; a picked protected path is refused;
  every existing safety test stays green. One-session tests as listed in one-session.md.
- Browser (the existing vitest browser projects, Chromium and Firefox): zoom below the old depth
  cap loads children; the remainder slice is drawn; Add to cleanup adds a row; a refused pick
  shows its reason; two cleanup rounds in one session without reload.
- All tests in sandboxes, never against the real HOME. The only run against the real disk is the
  read-only `scan` timing in A.
