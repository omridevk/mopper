---
name: disk-clean
description: Find reclaimable disk space on this computer (macOS, Linux or Windows), show a browser UI listing exactly what will be deleted, and run the approved cleanup in the background (approved items go to the Trash: the macOS Trash, the freedesktop.org Trash on Linux or the Recycle Bin on Windows, so they can be undone until the Trash is emptied). Use when the user asks to clean up disk space, free space, find what is eating the disk, or invokes /disk-clean.
---

# Disk Clean

Scan and review (stages 1 and 2) run as one session, and stage 3 deletes each approval while the
session stays open: the user can delete, look, and delete again, any number of rounds, without a new
scan. Never skip the review — nothing is deleted without an explicit approval in the UI, and you run
every approved cleanup yourself, after showing its dry run.

Every stage goes through one launcher. It runs the `disk-clean` binary for this plugin version,
fetching it on first use (the published release, checksum-verified, or a `cargo build` from the
bundled source when no release exists). The first run may print a download or build line on
stderr. Each command is shown twice: for the Bash tool (`run.sh`, which hands off to `run.ps1`
under Git Bash on Windows) and for Claude Code's PowerShell tool on Windows (`run.ps1`).

## Stages 1 and 2 — Scan and review

Run this **in the background** (`run_in_background: true`) and tell the user to switch to the
browser tab that opens: the page is the progress UI, so the terminal will look idle. It is the
session's server and runs until you stop it (see "The loop" below).

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/run.sh" "${CLAUDE_PLUGIN_DATA}" review --drives "<drives>"
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/scripts/run.ps1" "${CLAUDE_PLUGIN_DATA}" review --drives "<drives>"
```

`<drives>` is the argument `/disk-clean` was given, or `all` when it was given none. Windows only:
`/disk-clean C D` scans the profile plus drives C and D, `all` every fixed drive; macOS and Linux
accept only `all`. Use the argument only when it is the word `all` or drive letters (A-Z, any case)
separated by spaces or commas; for anything else do not run the command: say it is not a drive
list and show the accepted forms (`C D`, `C,D`, `all`).

It creates a run directory under `~/.cache/disk-clean/`, opens a local page in the default browser
right away, and scans in the background while the page fills in: a live counter during the walk
(one to three minutes, a single parallel walk of the data volume), then the cleanup list, storage
map and insights, then the git worktree checks and Docker/Homebrew/simulator probes. Delete
works while the scan is still running: every item already on screen can be deleted. Worktree rows
and the Docker and simulator command rows show "checking…" in place of their checkbox until their
check answers. Confirming Delete during the scan approves what is listed so far and the scan keeps
going: rows listed later can be deleted in a later round. The **first line of stdout is `RUN_DIR`**,
printed as soon as the run directory exists. Read it from the background task's output, then start
`wait` (below).

The run directory holds `scan.tsv` (cleanable items, appended as each one is listed on the page,
so an approval made mid-scan is validated against exactly what was shown; rows still being checked
are never in it), `map.tsv` (size tree), `disk.tsv` (volume
totals, snapshot count, and `too_deep`: folders nested too deep to read, also reported on stderr),
`insights.json` (home files by modified day, age per folder, kind, and the largest files), and one
numbered decision per approval: `decisions/<n>.json` (the selection, its mode and the plan the
confirm dialog showed) and a working folder `decisions/<n>/` for its cleanup. `session.json` (port,
token, pid) exists while the session is open. `clean.log` and `clean.events` are the one log of
record for the whole session: every approval, cleanup, Undo and Empty, from the page or the
terminal, is appended to both.

`HOME` is resolved to its real path once at startup and that path is used everywhere (scan, map,
safety rules, clean); when it differs (a symlinked home) the resolved path is printed on stderr.
Every command refuses to run with an empty, relative or missing `HOME`.

Tunable via environment variables: `DISK_CLEAN_MIN_BYTES` (default 10 MB floor per item),
`DISK_CLEAN_STALE_DAYS` (default 90), `DISK_CLEAN_BIGFILE_BYTES` (default 1 GB),
`DISK_CLEAN_OLD_DOWNLOAD_DAYS` (default 180), `DISK_CLEAN_MAP_DEPTH` (default 5),
`DISK_CLEAN_MAP_MIN_BYTES` (default 200 MB), `DISK_CLEAN_NM_DEPTH` (default 9),
`DISK_CLEAN_NM_MIN_BYTES` (default 5 MB), `DISK_CLEAN_SKIP_MAP=1` to skip the storage map
and walk only the home and temp folders instead of the whole volume.

The page has four tabs, a summary strip (disk donut, selected total, scan status) and a footer:

- **Cleanup** — sections grouped Safe / Review first / Report only, as a **List** (sidebar of
  sections plus a table of the open section) or **Cards** (one card per section). Each section has a checkbox for all its shown items, and its size and counts follow
  the filters (a path inside another selected path counts once). Live search, risk filters
  (safe / review / report only), minimum-size and minimum-idle filters, sort (size, natural name
  order, age), only-selected, and keyboard shortcuts (`/` search, `a` select shown, `d` deselect
  all, `r` reset, `v` switch view). Sections with more than three items get a quick-select row —
  **all N · idle 90+ days · idle 1+ year · none**. Banners warn when selected items are hidden by a
  filter and when anything marked `review` is selected.
- **Storage** — read-only. A **sunburst** or **treemap** of the whole data volume (click to zoom in,
  breadcrumbs to go back up, white outlines mark folders the Cleanup tab can delete), an inspector
  for the hovered folder, and the reconciliation of the whole disk (home folder + rest of the data
  volume + macOS system volume and APFS reserve + free = total). This is where the space this skill
  *cannot* reclaim shows up.
- **Insights** — read-only charts: bytes by last-modified day over the past year, the age of the
  largest folders under `~`, bytes by file kind, cleanup sections by idle time, and the largest files.
- **Trash** — every item disk-clean put in the Trash, across runs, from its record after a sync:
  path from `~`, size, when, which cleanup, and its state (in the Trash, put back by our Undo, put
  back in Finder or, on Linux, the file manager's Restore, or on Windows the Recycle Bin's
  Restore, emptied, or failed with the reason).
  Undo or Empty per item, per cleanup or for the ticked items; a cleanup filter. Empty always asks
  first and never touches anything else in the Trash.
- **Addresses** — everything you see is in the page address, so reload, Back/Forward and a copied
  link all restore it: the tab and the open section or zoomed folder are the path
  (`/cleanup/<section>`, `/storage/<folder path>`, `/insights`), filters, sort, view and the
  chart shape are query parameters (default values are left out), the Delete confirm is
  `/cleanup/<section>/confirm` (`?now` for Delete immediately), the Empty confirm is
  `/cleanup/<section>/empty` (and `/trash/empty` in the Trash tab, whose ticked items and cleanup
  filter are query parameters too), and the progress log
  and the movie are `?overlay=progress` / `?overlay=movie`. The ticked items are in the address too:
  `add` and `drop` hold only the changes from the recommended selection. Escape closes a dialog by
  going back to the address it was opened from. The local server answers every page address with
  the same page and token.
- **Clear selection** and **Reset to recommended** (footer, beside the "N items selected · X"
  count) do what the `d` and `r` shortcuts do. Each is disabled only when it would change nothing,
  and then its name says why. They are hidden while a cleanup runs.
- **Delete N items · X** (footer, also ⌘⌫ anywhere but a text field, or ⌫ / Delete while focus is
  in the item table): enabled whenever at least one
  selected item can be deleted, also while the scan runs. When it cannot be pressed its label says
  why: "Scanning… nothing found yet", "Select items to delete", "Nothing found to delete" or "The
  scan failed · nothing can be deleted". It opens a confirm dialog (Escape or Cancel closes it and
  changes nothing) built by the same validation code `clean` uses: the totals, then **Moved to the
  Trash (undo available)** with every path and its size, **Can't be undone** with the exact lines
  (items already inside a Trash, which are removed for good, git worktree removals, the fixed
  commands), and anything the safety checks rejected with the reason. While the scan is still
  running it also says so, and it approves exactly the list it shows. Its button ("Move N items to
  the Trash") sends the approval.
- **Delete immediately…** (beside Delete, ⌥⌘⌫ like Finder, or ⇧⌫, never in a text field): skips the Trash and removes
  for good. Its confirm says "can't be undone", gives the exact counts and bytes, its button names
  the action ("Delete N items immediately · X"), and focus starts on Cancel. Nothing deleted this
  way is recorded or undoable.
- **Cancel** (stop the scan and delete nothing more) still has a few-second undo window. It wakes
  you with `ended:`; then close the session with `stop`.
- After approval the page stays on the review app and locks the list while the round waits, is
  queued or runs. One phase drives the header line, the hero, the counter row, the status line and
  the summary, so they always agree: "Approved · waiting for Claude to run it" (you are showing the
  dry run), "queued" when an earlier cleanup still runs, "Moving to the Trash" (or "Deleting for
  good"), then **"Moved to Trash X · undo available"** with **Undo** (puts every item of this
  cleanup back exactly where it was) and **Empty these from Trash** (deletes only these items from
  the Trash for good, after its own confirm), then "Putting back" or "Emptying from the Trash" while
  those run. When a round finishes, the moved rows leave the list, the totals and disk numbers
  update, every other row can be selected again, and the footer keeps the last cleanup's result
  with its Undo and Empty; Undo brings the rows back. Moving to the Trash frees no space, so it is
  never shown as freed; the free-space line says the Trash keeps the space until it is emptied, and
  updates live while space comes back. If a cleanup finds nothing that passes the safety checks or
  its worker dies, the page says the cleanup did not start (or stopped) and why. **Details** opens a
  live log of every move, removal, kept worktree, failure (with its reason), command, undo and
  empty; "Watch the movie" plays the cleanup film. A reload keeps all of it, and a closed tab
  reopens at the same address while the session is open. When you stop the session the page says
  so.

Exit codes: `0` the session was stopped, `3` the run directory you passed has nothing to clean, `4`
a session is already open for that run directory. On a non-zero exit, stop and report — do not
delete anything.

## The loop — Claude stays in the loop for every cleanup

As soon as `review` printed `RUN_DIR`, run `wait` **in the background**. It blocks until there is
something you have not seen yet, prints one line and exits; that exit is what wakes you. Each
decision and each page notice is returned once.

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/run.sh" "${CLAUDE_PLUGIN_DATA}" wait "$RUN_DIR"
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/scripts/run.ps1" "${CLAUDE_PLUGIN_DATA}" wait "$RUN_DIR"
```

- `decision N PATH`, exit `0`: the user approved decision `N` (its selection is `PATH`). Show its
  dry run, run it (stage 3, always with `--decision N`), report the result, then start `wait` again.
- `page: ...`, exit `0`: the user ran Undo or Empty in the page; the line is its result. Tell the
  user, then start `wait` again.
- `ended: ...`, exit `5`: the user pressed Cancel in the page. Run `stop`.
- `stopped: ...`, exit `3`: the session is closed. Do not start `wait` again.

Approvals made while a cleanup runs queue and run in order. The session never ends on its own:
keep it open (and `wait` running) until the user says they are done or asks you to close it, then:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/run.sh" "${CLAUDE_PLUGIN_DATA}" stop "$RUN_DIR"
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/scripts/run.ps1" "${CLAUDE_PLUGIN_DATA}" stop "$RUN_DIR"
```

`stop` asks the session to close (`0` closed, `3` no session was open), the page says the session
is closed, and `review` exits `0`.

## Stage 3 — Background cleanup (to the Trash)

To print the plan without changing anything (same validation, same commands). It lists the Trash
moves (`trash -- '<path>'`) under `# moved to the Trash`, Delete immediately removals
(`rm -rf -- '<path>'`) under `# deleted immediately`, and the steps under `# can't be undone`
(git worktree removals, fixed commands):

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/run.sh" "${CLAUDE_PLUGIN_DATA}" clean --dry-run "$RUN_DIR" --decision N
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/scripts/run.ps1" "${CLAUDE_PLUGIN_DATA}" clean --dry-run "$RUN_DIR" --decision N
```

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/run.sh" "${CLAUDE_PLUGIN_DATA}" clean "$RUN_DIR" --decision N
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/scripts/run.ps1" "${CLAUDE_PLUGIN_DATA}" clean "$RUN_DIR" --decision N
```

`N` is the decision `wait` printed; `--decision` is required. Returns immediately with a pid and a
log path. The cleanup runs detached: each approved path is
resolved again and then moved to the macOS Trash through the system API (NSFileManager, the same
call Finder uses; a name clash in the Trash gets a new name, and Finder's Put Back works). On Linux
it goes to the freedesktop.org Trash (`~/.local/share/Trash`, or `.Trash-$UID` at the top of another
volume) with its `.trashinfo` written first, so the file manager's Restore works. On Windows it
goes to the Recycle Bin of its drive through the Shell (`IFileOperation`, the call Explorer uses),
so Restore in the Recycle Bin works. Each item
is written to `~/.cache/disk-clean/trashed.jsonl` before the move and completed after it, with where
it landed. A path the Trash refuses is reported `NOT TRASHED` with the reason and left where it is.
When the user chose Delete immediately (`"mode": "now"` in the decision), paths are removed for
good instead and never recorded. Items that already sit in a Trash are always removed for good.
Worktrees and the fixed commands run afterwards and can't be undone. Each decision works in
`$RUN_DIR/decisions/N/` (its lists, `rejected`, `status`, `worker.pid`). Cleanups run one at a
time per run directory: a decision approved while another runs is queued (it says so and exits `0`)
and starts when every earlier decision finished. Only one of clean, undo or empty touches the Trash
record at a time. Running a decision that is already queued, running or done says so and exits
`0`; it never runs twice. Exit codes (the dry run uses the same ones): `0` queued or started, `2` no
run directory / no such decision / no `--decision` / no `scan.tsv`, `3` nothing passed the safety
checks (see `$RUN_DIR/decisions/N/rejected`). Check progress with:

```bash
tail -20 "$RUN_DIR/clean.log"; cat "$RUN_DIR/decisions/N/status" 2>/dev/null
```

`status` reads `queued` while it waits for an earlier cleanup, `pending` while running, `done` when
finished, `interrupted` if the worker died before finishing, and `abandoned` when nothing passed
the safety checks. The tail of the log reports `removed: N items, X bytes` (what was freed),
`trashed: N items, X bytes, in the Trash until it is emptied (...)` and, separately, how much the
volume's free space changed since the worker started. `clean.log` and `clean.events` are appended
to, never cleared, and every worker line and event names its decision; the review tab shows each
round live from them.

### After approval: report, undo, empty

When `status` is `done`, tell the user what happened in these words: **"Moved X to the Trash (undo
available)"**, plus anything removed, kept or not trashed, taking X from the `trashed:` line of
`clean.log`. Moving to the Trash frees no space until the Trash is emptied; never call it freed.

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/run.sh" "${CLAUDE_PLUGIN_DATA}" undo "$RUN_DIR" --decision N
bash "${CLAUDE_SKILL_DIR}/scripts/run.sh" "${CLAUDE_PLUGIN_DATA}" empty "$RUN_DIR" --decision N
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/scripts/run.ps1" "${CLAUDE_PLUGIN_DATA}" undo "$RUN_DIR" --decision N
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/scripts/run.ps1" "${CLAUDE_PLUGIN_DATA}" empty "$RUN_DIR" --decision N
```

- Each round is its own cleanup in the Trash record. `--decision N` acts on that round only;
  without it, `undo` / `empty` act on every round of the run directory. Both append their result to
  `clean.log` and `clean.events`, so the open page shows it too.
- `undo` moves every item of that cleanup that is still in the Trash back to its original path (a
  same-volume rename that never overwrites: if something exists at the original path again, for
  example a reinstalled `node_modules`, that item stays in the Trash and the output says why).
- `empty` deletes that cleanup's items from the Trash for good and reports what was emptied. It never
  empties the whole Trash and never touches items disk-clean did not put there. Only run it when
  the user asks for it; it can't be undone.
- `undo --all` / `empty --all` act on every recorded item still in the Trash, across runs.
- Both act only on the record, re-check each item first (it must still be inside a Trash folder with
  the same file identity; a replaced item or a record entry outside the Trash is left alone and
  reported), and print `restored:` / `emptied:` and `still in the Trash: N`. Exit codes: `0` done,
  `2` no run directory, `3` nothing of that run is still in the Trash, `4` the record is busy
  (another clean, undo or empty). The review page offers the same actions, per item, per cleanup or
  for a selection, in the footer and the Trash tab.
- The record is synced on every `disk-clean` command and every page load: an item the user put back
  in Finder (on Linux, restored from the file manager; on Windows, restored from the Recycle Bin)
  becomes "put back", one that left the Trash
  becomes "emptied", anything ambiguous is marked failed with the reason and never acted on.
- Held runs from older versions (the `~/.cache/disk-clean/held` folder) are moved to the Trash item
  by item on the first command after the update, recorded like any other item (so Undo still puts
  them back), and the holding folder is removed once empty; it says so on stderr.

## What the scan covers

**node_modules is its own section**, listed by project directory, with the package manager and
days-since-install on every row, at any age (5 MB floor, searched 9 levels deep). Only entries
older than 90 days are preselected — the rest are one click away via the section quick-select.
This matters: a working machine can hold tens of GB of *fresh* node_modules that an
age-based rule never surfaces.

Deletable, preselected: Trash, `~/Library/Caches`, `~/Library/Logs` and crash reports,
package-manager download caches (npm, pnpm, yarn, bun, pip, uv, Homebrew, go-build, cargo,
Playwright, Puppeteer, CocoaPods, Electron), Xcode DerivedData / simulator caches /
device support, unavailable simulators, and build artifacts untouched for 90+ days
(`.venv`, Cargo `target`, `.next`, `.turbo`, `.svelte-kit`, `__pycache__`).

**Sizes are labelled by how they were measured.** Anything the walk measured directly (allocated
blocks, hard links counted once, the same accounting as `du -skx`) counts toward
the headline "reclaimable" figure. Two things do not, and render with a `≈` instead:
`docker system prune` reports space *inside* Docker's sparse VM disk image, which does not shrink
— pruning frees it for Docker but returns little or none of it to macOS (to get that back, reset
the Docker VM disk from Docker Desktop). The unavailable-simulator estimate is a rough guess.
The UI keeps these out of the main total and shows them separately as "+ N GB inside Docker's VM".

Deletable, **not** preselected: the pnpm content store (existing `node_modules` hard-link into
it, so clearing it breaks every checkout until reinstall), package-manager extracted stores
(`~/go/pkg/mod`, `~/.m2`, `~/.gradle/caches`, `~/.cargo/registry/src`, `~/.gem`), Xcode
Archives, iOS device backups, Docker prune.

Excluded on purpose: toolchain roots (`.nvm`, `.volta`, `.asdf`, `.pyenv`, `.rbenv`, `.local`)
are never treated as stale build artifacts — their `node_modules` hold globally installed CLIs.

Report only, never deletable through this skill: files over 1 GB outside `~/Library` (measured
by blocks actually allocated, so sparse disk images report their real footprint, not their
apparent size), and `~/Downloads` entries older than 180 days. They are shown with disabled
checkboxes so the user can act on them manually.

**Git worktrees**. Finds every repo under `$HOME` (6 levels deep,
`DISK_CLEAN_REPO_DEPTH`) and every worktree it has registered, wherever that worktree lives
(including `/private/tmp` scratchpads). A worktree is offered for removal only when ALL of these hold:
clean `git status` including untracked files, not locked, no process has its cwd inside, no
merge/rebase/cherry-pick/revert/bisect in progress, no submodules, no worktree-only refs, on a
named branch (or a detached HEAD some ref contains), no commit in its HEAD reflog that no
branch/tag/remote/stash holds, and every git-ignored file is known build output (`node_modules`,
`dist`, `.turbo`, caches, ...). Anything else, such as `.env`, `.idea` or plan folders, keeps it. Idle for
`DISK_CLEAN_WORKTREE_IDLE_DAYS` (default 2) means preselected. Everything else is listed report-only
with the reason. Removal re-runs every check per worktree, then calls `git worktree remove` without
`--force`, so git itself refuses anything dirty. Only the folder goes. The branch and all commits
stay, and `git worktree add <path> <branch>` restores it. The safety tests live in the plugin's
`cli/tests` and run with `cargo test`.

## Safety rules

- `clean` moves or deletes a path only if it appeared in that run's `scan.tsv` (the record of every
  item the page was shown, written as each one is listed). The UI cannot smuggle
  in an arbitrary path. Duplicate selections run once.
- Paths must be canonical: anything with `//`, a `.` or `..` component, or a trailing `/` is
  rejected, never normalised.
- Hard-blocked regardless of selection: `$HOME` itself and every folder above it, anything outside
  `$HOME` other than `/private/tmp` entries and the per-user `$TMPDIR` tree, and
  `Documents`, `Desktop`, `Pictures`, `Movies`, `Music`, `.ssh`, `.gnupg`, `.aws`, `.kube`,
  `.claude`, `Library/Mail`, `Library/Messages`, Keychains (names matched case-insensitively). On
  Linux the temp folders are `/tmp` and `/var/tmp`, and the protected folders are the XDG user
  folders read from `~/.config/user-dirs.dirs` (Desktop, Documents, Pictures, Music, Videos,
  Templates, Public, under their localized names and their English ones), `.ssh`, `.gnupg`, `.aws`,
  `.kube`, `.claude`, keyrings, KWallet, `.password-store`, `.pki`, browser and mail profiles,
  `.docker`, `.android` and Hugging Face tokens. These
  protections apply even when `$HOME` itself lives inside the temp folders. Rejects land in
  `$RUN_DIR/rejected`.
- Right before each removal (files, folders and worktrees alike) the path is resolved again: its
  parent's real path plus its name must still equal the scanned path, and that path must still be
  allowed. A path whose parent was swapped for a symlink after the scan is kept and logged `KEPT`
  with the reason. A symlink is removed itself, never followed.
- Only three shell commands can ever run, by fixed id: `xcrun simctl delete unavailable`,
  `docker system prune -f` (dangling only, never named volumes), `brew cleanup --prune=all -s`.
- Worktrees are never deleted directly: they are only removed with `git worktree remove`
  after a fresh re-check. A worktree that changed after the scan is kept and logged as `KEPT`.
- The review page answers only requests addressed to `127.0.0.1:<port>` or `localhost:<port>`;
  changes also need a JSON body from the page's own origin and its token (`stop` reads it from the
  owner-only `session.json`). The only changes to the Trash are Undo and Empty (`POST /undo`,
  `POST /empty`), which also require the page's `Origin` and act only on ids in the Trash record.
  Approving never deletes anything: you run each decision with `clean`.
- No `sudo`, ever. System-level caches under `/Library` and `/private/var` are out of scope.
- Approved paths go to the Trash (the macOS Trash, the freedesktop.org Trash on Linux, or the
  Recycle Bin on Windows), never
  deleted directly, unless the user chose Delete immediately, which is labelled "can't be undone"
  everywhere. Git worktree removals and the fixed commands (three on macOS, only Docker prune on
  Linux and Windows) can't go to the Trash and are labelled "can't be undone" too.

## Re-running

Each run gets its own directory under `~/.cache/disk-clean/`. Old run directories are kept for
audit and are safe to delete. To re-open the UI for a completed scan without rescanning, pass the
run directory: `review "$RUN_DIR"` (it starts in the finished state, prints `RUN_DIR` first and
runs the same loop: `wait`, `clean --decision N`, `stop`; rows already moved by an earlier round
stay out of the list). `scan [RUN_DIR]` still runs the scan alone, without a page.
