# disk-clean

Ask Claude to clean up your disk. Review every path in your browser. Delete only what you approve.

disk-clean finds reclaimable disk space on macOS, Linux and Windows: caches, logs, package-manager
caches, Xcode data, every `node_modules`, stale build output, temp folders, Docker, and git
worktrees with no leftover work. It opens a local review page that lists exactly what would be
deleted, and deletes only what you approve. Approved items go to the system Trash (the Recycle Bin
on Windows), so you can put them back.

## Install

In Claude Code:

```
/plugin marketplace add omridevk/mopper
/plugin install disk-clean@mopper
```

Or from a shell:

```bash
claude plugin marketplace add omridevk/mopper
claude plugin install disk-clean@mopper
```

Requirements: macOS, Linux or Windows, and `git`. Rust only if building from source.

## Use

Run `/disk-clean`, or ask Claude to "clean up my disk". A review page opens in your browser and
fills in while the scan runs. Tick or untick anything, then click **Delete**. The confirm dialog
lists every path, its size, and the exact commands that will run. Claude shows the dry run, then
runs the cleanup in the background. **Undo** puts a whole cleanup back; **Empty these from Trash**
removes only disk-clean's items for good.

On Windows, `/disk-clean C D` scans your profile plus only drives C and D. `/disk-clean all`, or
no argument, scans every fixed drive.

## What it runs and changes

- **Binary download.** The skill runs one `disk-clean` binary through `scripts/run.sh`
  (`scripts/run.ps1` on Windows). On first use it downloads the release for the installed plugin
  version from [GitHub releases](https://github.com/omridevk/mopper/releases), checks its sha256,
  and refuses to run it on a mismatch. If no release exists for that version, it builds the bundled
  Rust source with `cargo build --release --locked` instead (cargo may fetch the locked crates from
  crates.io). The binary is cached in the plugin data folder.
- **Local review page.** The binary serves the page on `127.0.0.1` on a random port and opens it in
  your default browser. It answers only requests addressed to `127.0.0.1` or `localhost`, and
  every change needs the page's own origin and a random per-session token.
- **Moves to the Trash.** Only the items you approve are moved: to the macOS Trash, the
  freedesktop.org Trash on Linux, or the Recycle Bin on Windows, so Undo works until the Trash is
  emptied. **Delete immediately…** is optional, skips the Trash, says "can't be undone" first, and
  can't be undone. Items that already sit in a Trash are always removed for good.
- **Git worktrees.** Clean worktrees are removed only with `git worktree remove` (never `--force`),
  followed by `git worktree prune`. The branch and every commit stay, and
  `git worktree add <path> <branch>` restores it.
- **Fixed commands.** Only three commands can ever run, by fixed id, and only if you tick them:
  `xcrun simctl delete unavailable` and `brew cleanup --prune=all -s` (macOS only), and
  `docker system prune -f` (dangling only, never named volumes).
- **Network.** Nothing is sent anywhere. The only network access is the binary download above
  (or the cargo fallback). The page is a single self-contained file served by the binary.

## Safety

- Only paths from that run's scan can be deleted. Paths must be canonical; anything with `//`,
  `.`, `..` or a trailing `/` is rejected.
- `$HOME` itself, everything outside `$HOME` except the temp folders, and personal folders such as
  `Documents`, `Desktop`, `Pictures`, `.ssh`, `.gnupg`, `.aws`, `.claude` and keychains are
  hard-blocked.
- Right before each removal the path is resolved again; a path whose parent was swapped for a
  symlink is kept and logged.
- A worktree is removed only when every check passes again right before removal: a clean
  `git status` including untracked files, no process running inside it, no merge or rebase in
  progress, no commits that exist only in that worktree, and no ignored files except known build
  output.
- There is no `sudo`, and nothing asks for administrator rights.

## Logs and records

- Each run gets its own directory under `~/.cache/disk-clean/` with the scan (`scan.tsv`), every
  approval (`decisions/<n>.json`), and the session log (`clean.log`, `clean.events`). Old run
  directories are kept for audit and are safe to delete.
- Every item moved to the Trash is recorded in `~/.cache/disk-clean/trashed.jsonl`, which Undo and
  Empty act on. Items removed with Delete immediately are not recorded.
- The binary and any cargo build output live in the plugin data folder.

## Links

- [Full documentation](https://github.com/omridevk/mopper#readme)
- [Report a bug](https://github.com/omridevk/mopper/issues)
- License: MIT
