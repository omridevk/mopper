use crate::platform;
use crate::scan::Row;
use crate::util::{self, realpath};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::mpsc::{Receiver, Sender};

const REGENERABLE_DIRS: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "out",
    ".turbo",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".output",
    ".vinxi",
    ".tanstack",
    "coverage",
    "test-results",
    "playwright-report",
    "storybook-static",
    ".cache",
    ".parcel-cache",
    ".vite",
    ".fallow",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "target",
    ".venv",
    "venv",
    ".gradle",
    "DerivedData",
];
const REGENERABLE_SUFFIXES: &[&str] = &[".tsbuildinfo", ".log", ".pyc", ".DS_Store"];
const IN_PROGRESS: &[&str] = &[
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
];

pub type Entry = HashMap<String, String>;

#[derive(Clone)]
pub struct Info {
    pub branch: String,
    pub unpushed: Option<i64>,
    pub idle: f64,
}

pub fn repo_depth() -> usize {
    util::env_num("DISK_CLEAN_REPO_DEPTH", 6)
}

fn idle_days() -> f64 {
    util::env_num("DISK_CLEAN_WORKTREE_IDLE_DAYS", 2.0)
}

pub fn git(cwd: &Path, args: &[&str]) -> (i32, String, String) {
    match util::captured(
        Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::piped()),
    ) {
        Ok(out) => (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ),
        Err(e) => (-1, String::new(), e.to_string()),
    }
}

pub fn list_worktrees(repo: &Path) -> Vec<Entry> {
    let (code, out, _) = git(repo, &["worktree", "list", "--porcelain"]);
    if code != 0 {
        return Vec::new();
    }
    let entries: Vec<Entry> = out
        .trim()
        .split("\n\n")
        .map(|block| {
            block
                .lines()
                .map(|line| {
                    let (k, v) = line.split_once(' ').unwrap_or((line, ""));
                    (k.to_string(), v.to_string())
                })
                .collect::<Entry>()
        })
        .filter(|e| e.get("worktree").is_some_and(|w| !w.is_empty()))
        .collect();
    entries.into_iter().skip(1).collect()
}

pub fn real_cwds(cwds: &[String]) -> Vec<String> {
    cwds.par_iter()
        .map(|c| realpath(Path::new(c)).to_string_lossy().into_owned())
        .collect()
}

pub fn is_regenerable(entry: &str) -> bool {
    let parts: Vec<&str> = entry.trim_end_matches('/').split('/').collect();
    parts.iter().any(|p| REGENERABLE_DIRS.contains(p))
        || parts
            .last()
            .is_some_and(|last| REGENERABLE_SUFFIXES.iter().any(|s| last.ends_with(s)))
}

fn last_activity(git_dir: &Path) -> f64 {
    let stamps: Vec<f64> = ["HEAD", "index", "logs/HEAD"]
        .iter()
        .filter_map(|name| std::fs::metadata(git_dir.join(name)).ok())
        .filter_map(|m| m.modified().ok())
        .filter_map(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .collect();
    match stamps.iter().cloned().reduce(f64::max) {
        Some(max) => (util::now_f64() - max) / 86400.0,
        None => 0.0,
    }
}

fn reflog_hashes(path: &Path) -> Vec<String> {
    let (code, out, _) = git(
        path,
        &["reflog", "show", "--format=%H", "-n", "500", "HEAD"],
    );
    let mut hashes: Vec<String> = if code == 0 {
        out.split_whitespace().map(str::to_string).collect()
    } else {
        Vec::new()
    };
    hashes.sort();
    hashes.dedup();
    hashes
}

const NOT_HELD: &[&str] = &[
    "--not",
    "--branches",
    "--tags",
    "--remotes",
    "--glob=refs/stash",
];

pub fn orphaned_reflog_commits(path: &Path) -> i64 {
    let hashes = reflog_hashes(path);
    if hashes.is_empty() {
        return 0;
    }
    let mut args = vec!["rev-list", "--count"];
    args.extend(hashes.iter().map(String::as_str));
    args.extend(NOT_HELD);
    let (code, out, _) = git(path, &args);
    if code != 0 {
        return -1;
    }
    let out = out.trim();
    if out.is_empty() {
        0
    } else {
        out.parse().unwrap_or(-1)
    }
}

pub fn orphan_counts(paths: &[PathBuf]) -> Vec<i64> {
    let reflogs: Vec<Vec<String>> = paths.par_iter().map(|p| reflog_hashes(p)).collect();
    let mut union: Vec<&str> = reflogs.iter().flatten().map(String::as_str).collect();
    union.sort();
    union.dedup();
    let Some(first) = paths.first() else {
        return Vec::new();
    };
    if union.is_empty() {
        return vec![0; paths.len()];
    }
    let mut args = vec!["rev-list", "--parents"];
    args.extend(union);
    args.extend(NOT_HELD);
    let (code, out, _) = git(first, &args);
    if code != 0 {
        return paths
            .par_iter()
            .map(|p| orphaned_reflog_commits(p))
            .collect();
    }
    let parents: HashMap<&str, Vec<&str>> = out
        .lines()
        .filter_map(|line| {
            let mut ids = line.split_whitespace();
            Some((ids.next()?, ids.collect()))
        })
        .collect();
    reflogs
        .iter()
        .map(|hashes| {
            let mut seen: HashSet<&str> = HashSet::new();
            let mut todo: Vec<&str> = hashes
                .iter()
                .map(String::as_str)
                .filter(|h| parents.contains_key(h))
                .collect();
            while let Some(c) = todo.pop() {
                if seen.insert(c) {
                    todo.extend(parents[c].iter().filter(|p| parents.contains_key(*p)));
                }
            }
            seen.len() as i64
        })
        .collect()
}

pub fn evaluate(
    entry: &Entry,
    real_cwds: &[String],
    orphans: Option<i64>,
) -> (Vec<String>, Option<Info>) {
    let path_s = entry.get("worktree").cloned().unwrap_or_default();
    let path = Path::new(&path_s);
    let mut blockers = Vec::new();
    if !path.is_dir() {
        return (
            vec!["folder missing (stale entry, cleared by git worktree prune)".to_string()],
            None,
        );
    }
    if entry.contains_key("locked") {
        blockers.push("locked".to_string());
    }
    let (code, git_dir, _) = git(path, &["rev-parse", "--absolute-git-dir"]);
    let git_dir = git_dir.trim().to_string();
    if code != 0 || git_dir.is_empty() {
        return (vec!["not a readable git worktree".to_string()], None);
    }
    let git_dir = PathBuf::from(git_dir);
    let real = realpath(path).to_string_lossy().into_owned();
    let prefix = format!("{real}/");
    if real_cwds
        .iter()
        .any(|c| *c == real || c.starts_with(&prefix))
    {
        blockers.push("a running process is inside it".to_string());
    }
    for marker in IN_PROGRESS {
        if git_dir.join(marker).exists() {
            blockers.push(format!("git operation in progress ({marker})"));
        }
    }
    if path.join(".gitmodules").exists() {
        blockers.push("has submodules".to_string());
    }
    let (code, status, _) = git(
        path,
        &[
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    );
    let changes = status.lines().filter(|l| !l.trim().is_empty()).count();
    if code != 0 {
        blockers.push("git status failed".to_string());
    } else if changes > 0 {
        blockers.push(format!("{changes} uncommitted or untracked files"));
    }
    let (code, ignored, _) = git(
        path,
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
        ],
    );
    let kept: Vec<&str> = ignored
        .split('\0')
        .filter(|e| !e.is_empty() && !is_regenerable(e))
        .collect();
    if code != 0 {
        blockers.push("could not list ignored files".to_string());
    } else if !kept.is_empty() {
        let mut msg = format!(
            "ignored files that are not build output: {}",
            kept[..kept.len().min(3)].join(", ")
        );
        if kept.len() > 3 {
            msg.push_str(&format!(" +{} more", kept.len() - 3));
        }
        blockers.push(msg);
    }
    let (_, worktree_refs, _) = git(
        path,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/worktree",
            "refs/bisect",
        ],
    );
    if !worktree_refs.trim().is_empty() {
        blockers.push("has worktree-only refs".to_string());
    }
    let branch = entry
        .get("branch")
        .map(|b| b.replace("refs/heads/", ""))
        .unwrap_or_default();
    if branch.is_empty() {
        let (_, holders, _) = git(
            path,
            &[
                "for-each-ref",
                "--contains",
                "HEAD",
                "--format=%(refname)",
                "refs/heads",
                "refs/remotes",
                "refs/tags",
            ],
        );
        if holders.trim().is_empty() {
            blockers.push("detached HEAD with commits on no branch".to_string());
        }
    }
    let orphans = orphans.unwrap_or_else(|| orphaned_reflog_commits(path));
    if orphans != 0 {
        let count = if orphans < 0 {
            "some".to_string()
        } else {
            orphans.to_string()
        };
        blockers.push(format!(
            "{count} commits exist only in this worktree's history"
        ));
    }
    let (code, _, _) = git(path, &["rev-parse", "--abbrev-ref", "@{u}"]);
    let mut unpushed = None;
    if code == 0 {
        let (code, count, _) = git(path, &["rev-list", "--count", "@{u}..HEAD"]);
        if code == 0 {
            let count = count.trim();
            unpushed = Some(if count.is_empty() {
                0
            } else {
                count.parse().unwrap_or(0)
            });
        }
    }
    let info = Info {
        branch: if branch.is_empty() {
            "detached".to_string()
        } else {
            branch
        },
        unpushed,
        idle: last_activity(&git_dir),
    };
    (blockers, Some(info))
}

#[allow(clippy::too_many_arguments)]
fn emit(
    cat_id: &str,
    title: &str,
    desc: &str,
    risk: &str,
    pre: &str,
    label: &str,
    path: &str,
    size: u64,
    note: &str,
    age: &str,
) -> Option<Row> {
    let fields = [
        cat_id.to_string(),
        title.to_string(),
        desc.to_string(),
        risk.to_string(),
        pre.to_string(),
        "worktree".to_string(),
        "-".to_string(),
        label.to_string(),
        path.to_string(),
        size.to_string(),
        note.to_string(),
        age.to_string(),
        "exact".to_string(),
    ];
    (!fields.iter().any(|f| f.contains(['\t', '\n']))).then_some(fields)
}

#[derive(Clone)]
pub struct Checked {
    pub entry: Entry,
    pub blockers: Vec<String>,
    pub info: Option<Info>,
}

fn listed_worktrees(repo: &Path) -> Vec<Entry> {
    list_worktrees(repo)
        .into_iter()
        .filter(|e| e.get("worktree").is_some_and(|p| Path::new(p).is_dir()))
        .collect()
}

fn check_entries(
    entries: Vec<Entry>,
    real: &[String],
    on_checked: &(dyn Fn(&Checked) + Sync),
) -> Vec<Checked> {
    let paths: Vec<PathBuf> = entries
        .iter()
        .map(|e| PathBuf::from(&e["worktree"]))
        .collect();
    let orphans = orphan_counts(&paths);
    entries
        .into_par_iter()
        .zip(orphans)
        .map(|(entry, orphans)| {
            let (blockers, info) = evaluate(&entry, real, Some(orphans));
            let checked = Checked {
                entry,
                blockers,
                info,
            };
            on_checked(&checked);
            checked
        })
        .collect()
}

pub fn check_repos(
    repos: Receiver<PathBuf>,
    listed: Sender<usize>,
    on_listed: &(dyn Fn(&[Entry]) + Sync),
    on_checked: &(dyn Fn(&Checked) + Sync),
) -> Vec<Checked> {
    let real = real_cwds(&platform::process_cwds());
    let done: Mutex<Vec<(usize, Vec<Checked>)>> = Mutex::new(Vec::new());
    let threads = std::thread::available_parallelism().map_or(4, |n| (n.get() / 2).max(2));
    let Ok(pool) = rayon::ThreadPoolBuilder::new().num_threads(threads).build() else {
        return Vec::new();
    };
    pool.in_place_scope(|s| {
        let mut total = 0;
        let mut seen = HashSet::new();
        for (i, repo) in repos
            .into_iter()
            .filter(|r| seen.insert(r.clone()))
            .enumerate()
        {
            let entries = listed_worktrees(&repo);
            total += entries.len();
            on_listed(&entries);
            let (real, done) = (&real, &done);
            s.spawn(move |_| {
                let checked = check_entries(entries, real, on_checked);
                if let Ok(mut d) = done.lock() {
                    d.push((i, checked));
                }
            });
        }
        let _ = listed.send(total);
    });
    let mut done = done.into_inner().unwrap_or_default();
    done.sort_by_key(|(i, _)| *i);
    done.into_iter().flat_map(|(_, c)| c).collect()
}

const CLEAN_TITLE: &str = "Git worktrees with no leftover work";
const CLEAN_DESC: &str = "Clean worktrees: no uncommitted, untracked or local-only ignored files, no process inside, nothing that exists only in the worktree. Only the folder goes; the branch and every commit stay. Every check is repeated right before removal.";

pub fn checking_rows(entries: &[Entry], home: &str) -> Vec<Row> {
    entries
        .iter()
        .filter_map(|e| {
            let path = e.get("worktree")?;
            let label = if home.is_empty() {
                path.clone()
            } else {
                path.replacen(home, "~", 1)
            };
            emit(
                "worktrees",
                CLEAN_TITLE,
                CLEAN_DESC,
                "safe",
                "0",
                &label,
                path,
                0,
                "Checking that nothing in this worktree would be lost.",
                "-",
            )
        })
        .collect()
}

pub fn rows(checked: &[Checked], home: &str, size_of: impl Fn(&Path) -> u64 + Sync) -> Vec<Row> {
    let idle_limit = idle_days();
    checked
        .par_iter()
        .filter_map(|c| {
            let path = c.entry.get("worktree")?;
            let label = if home.is_empty() {
                path.clone()
            } else {
                path.replacen(home, "~", 1)
            };
            let age = c
                .info
                .as_ref()
                .map(|i| (i.idle as i64).to_string())
                .unwrap_or_else(|| "-".to_string());
            let size = size_of(Path::new(path));
            let info = match &c.info {
                Some(info) if c.blockers.is_empty() => info,
                _ => {
                    return emit(
                        "worktrees-kept",
                        "Git worktrees kept (report only)",
                        "Worktrees that still hold work or are in use. Never removed.",
                        "report",
                        "0",
                        &label,
                        path,
                        size,
                        &format!("Kept: {}", c.blockers.join("; ")),
                        &age,
                    );
                }
            };
            let push = match info.unpushed {
                None => "branch never pushed; its commits stay on the local branch".to_string(),
                Some(0) => "branch is pushed".to_string(),
                Some(n) => format!("{n} unpushed commits stay on the local branch"),
            };
            let idle = info.idle >= idle_limit;
            let mut note = format!(
                "Branch {} is kept, {push}. Re-create with: git worktree add {label} {}",
                info.branch, info.branch
            );
            if !idle {
                note = format!("Active {:.1} days ago. {note}", info.idle);
            }
            emit(
                "worktrees",
                CLEAN_TITLE,
                CLEAN_DESC,
                "safe",
                if idle { "1" } else { "0" },
                &label,
                path,
                size,
                &note,
                &age,
            )
        })
        .collect()
}

fn common_repo(path: &Path) -> Option<PathBuf> {
    let (code, common, _) = git(
        path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    );
    let common = common.trim();
    if code != 0 || common.is_empty() {
        return None;
    }
    Some(
        Path::new(common)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default(),
    )
}

pub fn owning_repo(path: &Path) -> Option<PathBuf> {
    let link = std::fs::read_to_string(path.join(".git")).ok()?;
    let gitdir = path.join(link.strip_prefix("gitdir:")?.trim());
    let worktrees = gitdir.parent()?;
    if worktrees.file_name()? != "worktrees" {
        return None;
    }
    Some(worktrees.parent()?.parent()?.to_path_buf())
}

pub fn removable(path_s: &str, real: &[String]) -> Result<PathBuf, String> {
    let path = Path::new(path_s);
    let repo = if path.is_dir() {
        common_repo(path)
    } else {
        None
    };
    let target = realpath(path);
    let entry = repo.as_ref().and_then(|r| {
        list_worktrees(r).into_iter().find(|e| {
            e.get("worktree")
                .is_some_and(|w| realpath(Path::new(w)) == target)
        })
    });
    let (Some(repo), Some(entry)) = (repo, entry) else {
        return Err("not a registered worktree".to_string());
    };
    let (blockers, _) = evaluate(&entry, real, None);
    if blockers.is_empty() {
        Ok(repo)
    } else {
        Err(blockers.join("; "))
    }
}

pub fn remove(
    paths: &[String],
    out: &mut impl Write,
    still_safe: &dyn Fn(&str) -> Result<(), String>,
    on_outcome: &mut dyn FnMut(&str, Option<&str>),
) -> std::io::Result<()> {
    let real = real_cwds(&platform::process_cwds());
    let mut touched: Vec<PathBuf> = Vec::new();
    for path_s in paths {
        let repo = match removable(path_s, &real).and_then(|repo| still_safe(path_s).map(|()| repo))
        {
            Ok(repo) => repo,
            Err(reason) => {
                writeln!(out, "KEPT    {path_s} ({reason})")?;
                on_outcome(path_s, Some(&reason));
                continue;
            }
        };
        let (code, _, stderr) = git(&repo, &["worktree", "remove", path_s]);
        if code == 0 && !Path::new(path_s).exists() {
            writeln!(out, "removed worktree {path_s}")?;
            on_outcome(path_s, None);
            if !touched.contains(&repo) {
                touched.push(repo);
            }
        } else {
            let reason = format!(
                "git refused: {}",
                stderr.trim().lines().last().unwrap_or("?")
            );
            writeln!(out, "KEPT    {path_s} ({reason})")?;
            on_outcome(path_s, Some(&reason));
        }
    }
    for repo in touched {
        git(&repo, &["worktree", "prune"]);
    }
    Ok(())
}
