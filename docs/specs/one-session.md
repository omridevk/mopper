# disk-clean: one session, the scan keeps going, Claude stays in the loop

Decided 2026-10-05 (the user, relayed from another session: "why do we have to kill the UI while we
delete stuff? can't we keep it running?"; then chose "Keep Claude in the loop" and "Never on its
own"). Rechecked against the code on 2026-11-09 (after trash.md, rescan.md, live-scan.md and
delete-while-scanning.md landed) and built as part B of scan-speed-rounds-full-map.md.

## Today (checked against review.rs, clean.rs, trash.rs, watch.rs, main.rs and the page at 5e37d7e)

- `review` serves the page and runs the scan thread. `decide()` waits up to `TIMEOUT` (1800 s) for
  a single decision, then `review` exits: 0 approved (`selection.json` written), 3 nothing found
  (first scan only, rescan.md), 4 timed out, 5 cancelled. It prints `RUN_DIR` only when it exits,
  so Claude cannot know the run directory while the session is open.
- On approval it spawns a detached `watch RUN_DIR`, handing over its port and token through
  `DISK_CLEAN_WATCH_PORT` / `DISK_CLEAN_WATCH_TOKEN`. `watch` rebinds the port, serves the page
  rendered from the run dir with `approved: true` and the selection, tails `clean.events` as
  `/events`, and accepts only `/undo` and `/empty`. It exits a minute after the tab closes
  (`DISK_CLEAN_WATCH_IDLE`), after `DISK_CLEAN_WATCH_MAX` (2700 s), or marks the run `abandoned`
  when `clean` never ran within `DISK_CLEAN_WATCH_START` (1800 s). The scan thread dies with
  `review`.
- Approving mid-scan cancels the scan on purpose (delete-while-scanning.md: "confirming stops it
  and uses what was found so far"; `/decide` sets the scan's cancel flag). Anything the walk would
  have listed later is never listed.
- One approval per run directory: `selection.json` is overwritten by the next approval, which also
  deletes the previous `clean.events` and `status`. `clean` allows one worker per run directory
  (`clean.lock`) and answers exit 4, "another clean is already running", which the user has to
  retry. Each worker recreates `clean.events` and truncates `clean.log`.
- The page locks every row after approval (`locked={progress !== null}` in data-table.tsx and
  cleanup.tsx), hides Rescan, and its footer says "a new cleanup starts with /disk-clean": a new
  12-minute scan.
- The Trash record (trash.md) names one `run` per run directory (`trash::run_id`), so a second
  cleanup in the same run directory could not be undone or emptied on its own.
- Logs disagree: Undo and Empty started from the page append to `clean.events` (through `watch`)
  but never to `clean.log`; `undo` / `empty` in the terminal print to stdout and append to
  `clean.events` but not to `clean.log`. Nothing tells Claude about an Undo or Empty started from
  the page.

## The shape

- **`review` is the one server for the whole session.** `watch` (the command, its env and
  `approved_page`) goes away. `review` prints `RUN_DIR` as its first stdout line as soon as the run
  directory exists, so Claude can start `wait` right away. It holds `RUN_DIR/session.lock` for its
  whole life and writes `RUN_DIR/session.json` (`{port, token, pid}`, owner-only); a second
  `review` of the same run directory exits 4. The page's cleanup stream is `GET
  /clean-events?token=..`, the tail of `clean.events`; `/events` stays the scan stream.
- **Approval never cancels the scan.** The walk keeps listing. Paths already approved, trashed or
  removed are never listed again, nor anything inside them: while a decision is queued or running
  every path in it is held back, and once it finished every approved path that is gone from disk
  is. A kept or failed path stays listed and can be approved again in a later round. Approval is
  still validated only against rows already shown (delete-while-scanning.md), minus held-back
  paths.
- **Claude stays in the loop for every cleanup:**
  - Each approval is written as a numbered decision, `RUN_DIR/decisions/<n>.json` (the selection,
    its mode and the validated plan the confirm dialog showed), and recorded in `clean.events`
    (`approved`: decision, items, bytes, mode, its Trash run) and `clean.log`. `/decide` answers
    `{decision: n}`. The page shows "Approved · waiting for Claude to run it" until the worker
    starts.
  - A new command, `disk-clean wait RUN_DIR`, blocks until there is something Claude hasn't seen
    yet, prints one line and exits. Claude Code wakes only when a background task exits, so this
    exit is the wake signal. Each decision and notice is returned once (`decisions/<n>.woke`,
    `notices/<k>.woke`):
    - `decision N PATH`, exit 0: a new approval to run;
    - `page: ...`, exit 0: an Undo or Empty started from the page, with its result;
    - `ended: ...`, exit 5: the user pressed Cancel in the page (Claude runs `stop`);
    - `stopped: ...`, exit 3: no session is open for this run directory any more.
  - The loop in SKILL.md: launch `review` in the background, read `RUN_DIR`, then `wait` in the
    background. On each `decision`, run `clean --dry-run RUN_DIR --decision N` (show the plan in the
    terminal), then `clean RUN_DIR --decision N`. Report the result, then start `wait` again.
  - `clean` takes `--decision N` (required). Each decision works in `RUN_DIR/decisions/<n>/`
    (lists, `rejected`, `status`, `worker.pid`, its own lock). Cleanups run one at a time per run
    directory: a second approval while one runs waits in order (status `queued`, a `queued` event,
    the page shows it as queued) and starts when every earlier decision finished. Exit 4 is gone;
    running a decision that is already queued, running or done says so and exits 0.
  - Each round is its own cleanup in the Trash record: its `run` is `<run id>-<n>`, so Undo and
    Empty act per round (the page footer, the Trash tab), and `undo` / `empty RUN_DIR` act on every
    round of the run directory, `--decision N` on one.
- **After a round the page is live again.** When the worker finishes, `review` sends `unlisted`
  for every approved path that is gone (and every listed path inside it) and a fresh `disk` event,
  so the moved rows leave the list, the totals and the disk numbers update, every other row is
  selectable again, and the user can select and delete again, any number of rounds. Undo sends the
  restored rows back. The page locks only while a round waits, is queued or runs (and while an Undo
  or Empty runs); Rescan is refused (409) while a decision is unfinished.
- **The session never ends on its own.** No approval timeout, no exit on tab close, no exit when the
  scan finds nothing. It runs until Claude stops it with `disk-clean stop RUN_DIR` (POST `/stop`
  with the session token, local only), when the user asks or says they're done; `review` then
  exits 0 and the page says the session is closed. Cancel in the page stops the scan, deletes
  nothing more and wakes Claude (`ended`). The page shows "Session open", and a closed tab can
  reopen to the same address.
- **One log of record.** Every action, wherever it was started (approvals, Claude's `clean`, Undo /
  Empty from the page or the terminal, Delete immediately), appends to `clean.log` and
  `clean.events` alike (both append-only for the session; every worker event carries its
  `decision`), so the terminal and the page always agree. `wait` also wakes Claude for page-started
  actions, so Claude can report them in the terminal.

## Tests

- **Rust:**
  - Approval mid-scan doesn't stop the walk, and items listed after approval still arrive.
  - Approved paths, and paths inside them, are never re-listed.
  - Two approvals queue and run in order.
  - `wait` returns each decision once.
  - `stop` ends the session cleanly.
  - clean.log records page-started actions.
  - Every safety test stays green.
- **Browser (Chromium and Firefox):**
  - Approve mid-scan: the scan keeps going and the hero shows both phases correctly (one phase
    source, per the Trash lane's work).
  - A second approval shows as queued.
  - Reloading during a cleanup restores it.
  - Two cleanup rounds in one session without reload: the moved rows leave, the rest unlock, the
    totals and disk numbers update, Undo and Empty act on each round.
- All tests run in sandboxes (RAM disk for the Trash), never against the real HOME.

## Order

This runs after the Trash lane (trash.md) lands. It changes the same worker, events and SKILL.md.
