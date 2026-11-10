use crate::clean;
use crate::platform;
pub use crate::platform::is_trash_dir;
use crate::util;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::Duration;

const RECORD: &str = "trashed.jsonl";
const LOCK: &str = "trashed.lock";
const LOCK_TRIES: usize = 50;
pub const BATCH: usize = 64;
const FREE_EVERY: Duration = Duration::from_millis(500);
pub const STILL_THERE: &str = "the original path exists again, so it stays in the Trash";

pub const TRASHED: &str = "trashed";
pub const RESTORED: &str = "restored";
pub const PUT_BACK: &str = "put-back";
pub const EMPTIED: &str = "emptied";
pub const FAILED: &str = "failed";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub run: String,
    pub original: String,
    pub trashed: String,
    pub bytes: i64,
    pub at: i64,
    pub dev: u64,
    pub ino: u64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub ino_hi: u64,
    pub state: String,
    #[serde(default)]
    pub reason: String,
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}

pub type Emit<'a> = &'a (dyn Fn(&str, Value) + Sync);

pub fn cache_dir(home: &str) -> PathBuf {
    PathBuf::from(format!("{home}/.cache/disk-clean"))
}

pub fn record_path(home: &str) -> PathBuf {
    cache_dir(home).join(RECORD)
}

pub fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_dir())
        && fs::canonicalize(path).is_ok_and(|real| resolves_to(&real, path))
}

fn resolves_to(real: &Path, path: &Path) -> bool {
    real == path || platform::path_text(real).is_some_and(|text| Path::new(&text) == path)
}

fn make_dir(dir: &Path) -> io::Result<()> {
    platform::create_private_dir(dir)?;
    if is_real_dir(dir) {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "{} is not a plain folder (a symlink or moved), not touched",
            dir.display()
        )))
    }
}

pub fn lock_file(path: &Path, tries: usize) -> io::Result<Option<fs::File>> {
    let file = platform::no_follow()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)?;
    for attempt in 0..tries.max(1) {
        if file.try_lock().is_ok() {
            return Ok(Some(file));
        }
        if attempt + 1 < tries {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    Ok(None)
}

pub struct Record {
    home: String,
    pub entries: Vec<Entry>,
    _lock: fs::File,
}

pub fn read(home: &str) -> Vec<Entry> {
    let mut order: Vec<String> = Vec::new();
    let mut latest: HashMap<String, Entry> = HashMap::new();
    for line in util::read_lines(&record_path(home)) {
        let Ok(entry) = serde_json::from_str::<Entry>(&line) else {
            continue;
        };
        if !latest.contains_key(&entry.id) {
            order.push(entry.id.clone());
        }
        latest.insert(entry.id.clone(), entry);
    }
    order
        .into_iter()
        .filter_map(|id| latest.remove(&id))
        .collect()
}

impl Record {
    pub fn open(home: &str, tries: usize) -> io::Result<Option<Record>> {
        make_dir(&cache_dir(home))?;
        let Some(lock) = lock_file(&cache_dir(home).join(LOCK), tries)? else {
            return Ok(None);
        };
        Ok(Some(Record {
            home: home.to_string(),
            entries: read(home),
            _lock: lock,
        }))
    }

    pub fn wait(home: &str) -> io::Result<Record> {
        Record::open(home, LOCK_TRIES)?.ok_or_else(|| {
            io::Error::other("the Trash record is busy (another clean, undo or empty is running)")
        })
    }

    fn append(&self, entries: &[Entry]) -> io::Result<()> {
        let mut file = platform::no_follow()
            .create(true)
            .append(true)
            .open(record_path(&self.home))?;
        let text: String = entries
            .iter()
            .filter_map(|e| serde_json::to_string(e).ok())
            .map(|line| line + "\n")
            .collect();
        file.write_all(text.as_bytes())
    }

    fn save(&self) -> io::Result<()> {
        let text: String = self
            .entries
            .iter()
            .filter_map(|e| serde_json::to_string(e).ok())
            .map(|line| line + "\n")
            .collect();
        let path = record_path(&self.home);
        let tmp = cache_dir(&self.home).join(format!("{RECORD}.tmp"));
        let _ = fs::remove_file(&tmp);
        platform::no_follow()
            .create_new(true)
            .write(true)
            .open(&tmp)?
            .write_all(text.as_bytes())?;
        fs::rename(tmp, path)
    }

    fn put(&mut self, changed: &[Entry]) -> io::Result<()> {
        for entry in changed {
            match self.entries.iter_mut().find(|e| e.id == entry.id) {
                Some(known) => *known = entry.clone(),
                None => self.entries.push(entry.clone()),
            }
        }
        self.save()
    }

    pub fn trashed(&self, ids: &[String]) -> Vec<Entry> {
        self.entries
            .iter()
            .filter(|e| e.state == TRASHED && ids.contains(&e.id))
            .cloned()
            .collect()
    }

    pub fn of_run(&self, run: &str) -> Vec<String> {
        self.entries
            .iter()
            .filter(|e| e.state == TRASHED && (run.is_empty() || of_round(&e.run, run)))
            .map(|e| e.id.clone())
            .collect()
    }
}

fn fnv(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    })
}

pub fn of_round(entry_run: &str, run: &str) -> bool {
    entry_run == run
        || entry_run
            .strip_prefix(run)
            .and_then(|rest| rest.strip_prefix('-'))
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

pub fn round_run(run_dir: &Path, decision: u64) -> String {
    format!("{}-{decision}", run_id(run_dir))
}

pub fn run_id(run_dir: &Path) -> String {
    let real = util::realpath(run_dir);
    let name = real
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| {
            n.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
        .unwrap_or_else(|| "run".to_string());
    format!("{name}-{:08x}", fnv(&real.to_string_lossy()) as u32)
}

fn new_id(original: &str, n: usize) -> String {
    format!(
        "{:016x}",
        fnv(&format!(
            "{original}\n{}\n{}\n{n}",
            util::now_f64(),
            std::process::id()
        ))
    )
}

fn still_in_trash(entry: &Entry, home: &str) -> Result<(), String> {
    let trashed = Path::new(&entry.trashed);
    if !trashed.parent().is_some_and(|dir| is_trash_dir(dir, home)) {
        return Err("the record names a path outside the Trash, not touched".to_string());
    }
    match platform::same_item(&entry.trashed, entry.dev, entry.ino, entry.ino_hi) {
        Some(true) => Ok(()),
        Some(false) => Err("the item in the Trash was replaced, not touched".to_string()),
        None => Err("no longer in the Trash".to_string()),
    }
}

fn classify(entry: &Entry, home: &str) -> Option<Entry> {
    if entry.state != TRASHED || still_in_trash(entry, home).is_ok() {
        return None;
    }
    let in_trash = platform::same_item(&entry.trashed, entry.dev, entry.ino, entry.ino_hi);
    let at_original = platform::same_item(&entry.original, entry.dev, entry.ino, entry.ino_hi);
    let (state, reason) = match (in_trash, at_original) {
        (_, Some(true)) => (PUT_BACK, ""),
        (None, None) => (EMPTIED, ""),
        (Some(false), _) => (FAILED, "the item in the Trash was replaced, not touched"),
        _ => (
            FAILED,
            "gone from the Trash, and something else is at the original path now",
        ),
    };
    Some(Entry {
        state: state.to_string(),
        reason: reason.to_string(),
        ..entry.clone()
    })
}

pub fn rows(entries: &[Entry]) -> Value {
    json!({"entries": entries})
}

pub fn sync(home: &str) -> io::Result<Vec<Entry>> {
    if !record_path(home).exists() {
        return Ok(Vec::new());
    }
    let Some(mut record) = Record::open(home, 1)? else {
        return Ok(Vec::new());
    };
    let changed: Vec<Entry> = record
        .entries
        .iter()
        .filter_map(|e| classify(e, home))
        .collect();
    if !changed.is_empty() {
        record.put(&changed)?;
    }
    Ok(changed)
}

pub fn synced(home: &str, emit: Emit) -> Vec<Entry> {
    match sync(home) {
        Ok(changed) if !changed.is_empty() => emit("trash", rows(&changed)),
        Ok(_) => {}
        Err(e) => eprintln!("disk-clean: could not check the Trash record: {e}"),
    }
    read(home)
}

fn move_batch(paths: &[platform::Checked]) -> Vec<Result<String, String>> {
    let mut landed = platform::call_trash(paths);
    let again: Vec<usize> = landed
        .iter()
        .enumerate()
        .filter(|(i, l)| {
            l.is_err()
                && platform::same_item(
                    &paths[*i].path,
                    paths[*i].dev,
                    paths[*i].ino,
                    paths[*i].ino_hi,
                ) == Some(true)
        })
        .map(|(i, _)| i)
        .collect();
    if again.is_empty() {
        return landed;
    }
    let retry: Vec<platform::Checked> = again.iter().map(|i| paths[*i].clone()).collect();
    for (i, result) in again.into_iter().zip(platform::call_trash(&retry)) {
        landed[i] = result;
    }
    landed
}

pub struct Wanted {
    pub original: String,
    pub bytes: i64,
}

pub enum Moved {
    Trashed(Entry),
    Failed(Entry),
}

pub type Check<'a> = &'a (dyn Fn(&str) -> Result<(), String> + Sync);

fn pending(record_run: &str, wanted: &Wanted, n: usize) -> Result<Entry, String> {
    let (dev, ino, ino_hi) =
        platform::dev_and_ino(&wanted.original).map_err(|e| e.kind().to_string())?;
    Ok(Entry {
        id: new_id(&wanted.original, n),
        run: record_run.to_string(),
        original: wanted.original.clone(),
        trashed: String::new(),
        bytes: wanted.bytes,
        at: util::now(),
        dev,
        ino,
        ino_hi,
        state: FAILED.to_string(),
        reason: format!(
            "the move to the Trash did not finish; if it landed there, {} can restore it",
            platform::RESTORE_BY_HAND
        ),
    })
}

fn settle(entry: Entry, landed: Result<String, String>, home: &str) -> Moved {
    let trashed = match landed {
        Err(why) => {
            return Moved::Failed(Entry {
                reason: format!("not moved to the Trash: {why}"),
                ..entry
            });
        }
        Ok(trashed) => trashed,
    };
    let placed = |trashed: String| Entry {
        trashed,
        state: TRASHED.to_string(),
        reason: String::new(),
        ..entry.clone()
    };
    let reported = placed(trashed.clone());
    let Err(why) = still_in_trash(&reported, home) else {
        return Moved::Trashed(reported);
    };
    let seen = match platform::find_trashed(&checked(&entry), &trashed) {
        Ok(found) => {
            let found = placed(found);
            match still_in_trash(&found, home) {
                Ok(()) => return Moved::Trashed(found),
                Err(again) => format!("; found {} by its identity, but {again}", found.trashed),
            }
        }
        Err(seen) => seen,
    };
    Moved::Failed(Entry {
        trashed,
        reason: format!("moved, but {why}{seen}"),
        ..entry
    })
}

fn checked(entry: &Entry) -> platform::Checked {
    platform::Checked {
        path: entry.original.clone(),
        dev: entry.dev,
        ino: entry.ino,
        ino_hi: entry.ino_hi,
        bytes: u64::try_from(entry.bytes).unwrap_or(0),
    }
}

impl Record {
    pub fn move_to_trash(&mut self, run: &str, wanted: &[Wanted], check: Check) -> Vec<Moved> {
        let mut out = Vec::new();
        for batch in wanted.chunks(BATCH) {
            out.extend(self.move_batch(run, batch, check));
        }
        out
    }

    fn move_batch(&mut self, run: &str, batch: &[Wanted], check: Check) -> Vec<Moved> {
        let mut out = Vec::new();
        let mut ready: Vec<Entry> = Vec::new();
        for (n, wanted) in batch.iter().enumerate() {
            let entry = check(&wanted.original).and_then(|()| pending(run, wanted, n));
            match entry {
                Ok(entry) => ready.push(entry),
                Err(reason) => out.push(Moved::Failed(Entry {
                    id: String::new(),
                    run: run.to_string(),
                    original: wanted.original.clone(),
                    trashed: String::new(),
                    bytes: wanted.bytes,
                    at: util::now(),
                    dev: 0,
                    ino: 0,
                    ino_hi: 0,
                    state: FAILED.to_string(),
                    reason,
                })),
            }
        }
        if ready.is_empty() {
            return out;
        }
        if let Err(e) = self.append(&ready) {
            let reason = format!("the Trash record could not be written: {e}");
            out.extend(ready.into_iter().map(|entry| {
                Moved::Failed(Entry {
                    id: String::new(),
                    reason: reason.clone(),
                    ..entry
                })
            }));
            return out;
        }
        self.entries.extend(ready.iter().cloned());
        let paths: Vec<platform::Checked> = ready.iter().map(checked).collect();
        let settled: Vec<Moved> = ready
            .into_iter()
            .zip(move_batch(&paths))
            .map(|(entry, landed)| settle(entry, landed, &self.home))
            .collect();
        let changed: Vec<Entry> = settled
            .iter()
            .map(|m| match m {
                Moved::Trashed(e) | Moved::Failed(e) => e.clone(),
            })
            .collect();
        if let Err(e) = self.put(&changed) {
            eprintln!("disk-clean: could not complete the Trash record: {e}");
        }
        out.extend(settled);
        out
    }
}

pub struct Report {
    pub done: usize,
    pub done_bytes: i64,
    pub kept: usize,
    pub changed: Vec<Entry>,
}

fn job_id() -> String {
    format!("{}-{}", util::now(), std::process::id())
}

fn item(entry: &Entry, job: &str, outcome: &str, reason: &str) -> Value {
    json!({
        "job": job,
        "id": entry.id,
        "path": entry.original,
        "trashed_path": entry.trashed,
        "bytes": entry.bytes,
        "outcome": outcome,
        "reason": reason,
    })
}

fn restore_problem(entry: &Entry, home: &str, tmp_base: Option<&str>) -> Option<&'static str> {
    if !clean::is_allowed(&entry.original, home, tmp_base) {
        return Some("the original path is protected, so it stays in the Trash");
    }
    let original = Path::new(&entry.original);
    let (Some(parent), Some(name)) = (original.parent(), original.file_name()) else {
        return Some("not a canonical path");
    };
    match fs::canonicalize(parent) {
        Ok(real) if resolves_to(&real.join(name), original) => None,
        Ok(_) => Some("the original folder now resolves elsewhere, so it stays in the Trash"),
        Err(_) => Some("the original folder is gone, so it stays in the Trash"),
    }
}

fn why_not_restored(e: &io::Error) -> String {
    match e.kind() {
        io::ErrorKind::AlreadyExists | io::ErrorKind::DirectoryNotEmpty => STILL_THERE.to_string(),
        io::ErrorKind::PermissionDenied => {
            "permission denied, so it stays in the Trash".to_string()
        }
        _ => format!("{e}, so it stays in the Trash"),
    }
}

fn restore(entry: &Entry, home: &str, tmp_base: Option<&str>) -> Result<(), String> {
    still_in_trash(entry, home)?;
    if let Some(problem) = restore_problem(entry, home, tmp_base) {
        return Err(problem.to_string());
    }
    platform::rename_excl(Path::new(&entry.trashed), Path::new(&entry.original))
        .map_err(|e| why_not_restored(&e))?;
    platform::drop_trash_info(Path::new(&entry.trashed));
    Ok(())
}

fn finished(entry: &Entry, home: &str, state: &str) -> Entry {
    classify(entry, home).unwrap_or_else(|| Entry {
        state: state.to_string(),
        reason: String::new(),
        ..entry.clone()
    })
}

fn left_bytes(record: &Record, run: &str) -> (usize, i64) {
    let left: Vec<&Entry> = record
        .entries
        .iter()
        .filter(|e| e.state == TRASHED && of_round(&e.run, run))
        .collect();
    (left.len(), left.iter().map(|e| e.bytes).sum())
}

pub fn undo(record: &mut Record, ids: &[String], run: &str, emit: Emit) -> io::Result<Report> {
    let home = record.home.clone();
    let tmp_base = platform::user_tmp_base();
    let chosen = record.trashed(ids);
    let job = job_id();
    emit(
        "undo_started",
        json!({"job": job, "count": chosen.len(), "bytes": chosen.iter().map(|e| e.bytes).sum::<i64>()}),
    );
    let mut report = Report {
        done: 0,
        done_bytes: 0,
        kept: 0,
        changed: Vec::new(),
    };
    let mut changed = Vec::new();
    for entry in &chosen {
        match restore(entry, &home, tmp_base.as_deref()) {
            Ok(()) => {
                emit("undone", item(entry, &job, "restored", ""));
                report.done += 1;
                report.done_bytes += entry.bytes;
                changed.push(Entry {
                    state: RESTORED.to_string(),
                    reason: String::new(),
                    ..entry.clone()
                });
            }
            Err(reason) => {
                emit("undone", item(entry, &job, "kept", &reason));
                report.kept += 1;
                let updated = classify(entry, &home).unwrap_or_else(|| Entry {
                    reason: reason.clone(),
                    ..entry.clone()
                });
                changed.push(updated);
            }
        }
    }
    record.put(&changed)?;
    emit("trash", rows(&changed));
    report.changed = changed;
    let (left, left_bytes) = left_bytes(record, run);
    emit(
        "undo_done",
        json!({"job": job, "restored": report.done, "restored_bytes": report.done_bytes, "kept": report.kept, "trashed": left, "trashed_bytes": left_bytes}),
    );
    Ok(report)
}

fn sample_free(emit: Emit, stop: mpsc::Receiver<()>) {
    while let Err(mpsc::RecvTimeoutError::Timeout) = stop.recv_timeout(FREE_EVERY) {
        emit("free", json!({"free": util::free_bytes()}));
    }
}

pub fn with_free_samples<T>(emit: Emit, work: impl FnOnce() -> T) -> T {
    let (working, stop) = mpsc::channel::<()>();
    std::thread::scope(|s| {
        s.spawn(move || sample_free(emit, stop));
        let out = work();
        drop(working);
        out
    })
}

pub fn remove_for_good(path: &Path, home: &str) -> io::Result<()> {
    platform::make_removable(path);
    let result = clean::remove_path(path);
    if fs::symlink_metadata(path).is_err() && path.parent().is_some_and(|d| is_trash_dir(d, home)) {
        platform::drop_trash_info(path);
    }
    result
}

fn empty_one(entry: &Entry, home: &str) -> Result<(), String> {
    still_in_trash(entry, home)?;
    let result = remove_for_good(Path::new(&entry.trashed), home);
    match (fs::symlink_metadata(&entry.trashed).is_ok(), result) {
        (false, _) => Ok(()),
        (true, Err(e)) => Err(format!("could not delete: {}", e.kind())),
        (true, Ok(())) => Err("still present after removal".to_string()),
    }
}

pub fn empty(record: &mut Record, ids: &[String], run: &str, emit: Emit) -> io::Result<Report> {
    let home = record.home.clone();
    let chosen = record.trashed(ids);
    let job = job_id();
    let parallel = util::env_num("DISK_CLEAN_PARALLEL", 4usize).max(1);
    let free_before = util::free_bytes() as i64;
    emit(
        "empty_started",
        json!({"job": job, "count": chosen.len(), "bytes": chosen.iter().map(|e| e.bytes).sum::<i64>(), "free": free_before}),
    );
    let changed = Mutex::new(Vec::new());
    let (done, done_bytes, kept) = (AtomicUsize::new(0), AtomicI64::new(0), AtomicUsize::new(0));
    with_free_samples(emit, || {
        util::in_parallel(&chosen, parallel, |entry| {
            let outcome = empty_one(entry, &home);
            let updated = match &outcome {
                Ok(()) => {
                    done.fetch_add(1, Ordering::SeqCst);
                    done_bytes.fetch_add(entry.bytes, Ordering::SeqCst);
                    emit("emptied", item(entry, &job, "emptied", ""));
                    Entry {
                        state: EMPTIED.to_string(),
                        reason: String::new(),
                        ..entry.clone()
                    }
                }
                Err(reason) => {
                    kept.fetch_add(1, Ordering::SeqCst);
                    emit("emptied", item(entry, &job, "kept", reason));
                    let still = finished(entry, &home, TRASHED);
                    Entry {
                        reason: if still.state == TRASHED {
                            reason.clone()
                        } else {
                            still.reason.clone()
                        },
                        ..still
                    }
                }
            };
            if let Ok(mut changed) = changed.lock() {
                changed.push(updated);
            }
        });
    });
    let changed: Vec<Entry> = changed.into_inner().unwrap_or_default();
    record.put(&changed)?;
    emit("trash", rows(&changed));
    let report = Report {
        done: done.into_inner(),
        done_bytes: done_bytes.into_inner(),
        kept: kept.into_inner(),
        changed,
    };
    let (left, left_bytes) = left_bytes(record, run);
    emit(
        "empty_done",
        json!({
            "job": job,
            "emptied": report.done,
            "emptied_bytes": report.done_bytes,
            "kept": report.kept,
            "trashed": left,
            "trashed_bytes": left_bytes,
            "free_before": free_before,
            "free_after": util::free_bytes() as i64,
        }),
    );
    Ok(report)
}

pub fn legacy_held_root(home: &str) -> PathBuf {
    cache_dir(home).join("held")
}

#[derive(Deserialize)]
struct Held {
    original: String,
    held: String,
    bytes: i64,
    dev: u64,
    ino: u64,
}

const BOOKKEEPING: [&str; 3] = ["manifest.jsonl", "manifest.jsonl.tmp", "lock"];

fn locate(dir: &Path, held: &Held) -> Option<PathBuf> {
    let numbered = Path::new(&held.held);
    let is_numbered = numbered
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    let readable = Path::new(&held.original)
        .file_name()
        .map(|name| dir.join(name));
    [is_numbered.then(|| numbered.to_path_buf()), readable]
        .into_iter()
        .flatten()
        .find(|path| {
            path.parent() == Some(dir)
                && !BOOKKEEPING.iter().any(|b| path.ends_with(b))
                && platform::same_item(&path.to_string_lossy(), held.dev, held.ino, 0) == Some(true)
        })
}

fn readable_name(dir: &Path, found: &Path, held: &Held) -> PathBuf {
    let Some(name) = Path::new(&held.original).file_name() else {
        return found.to_path_buf();
    };
    let target = dir.join(name);
    if target != found
        && !BOOKKEEPING.iter().any(|b| target.ends_with(b))
        && fs::symlink_metadata(&target).is_err()
        && platform::rename_excl(found, &target).is_ok()
    {
        return target;
    }
    found.to_path_buf()
}

fn only_bookkeeping(dir: &Path) -> bool {
    fs::read_dir(dir).is_ok_and(|list| {
        list.flatten()
            .all(|e| BOOKKEEPING.iter().any(|b| e.file_name() == *b))
    })
}

fn migrate_run(record: &mut Record, dir: &Path) -> (usize, usize) {
    let manifest = dir.join("manifest.jsonl");
    let Ok(Some(_lock)) = lock_file(&dir.join("lock"), 1) else {
        return (0, 0);
    };
    let held: Vec<Held> = util::read_lines(&manifest)
        .iter()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let run = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let check = |path: &str| -> Result<(), String> {
        (Path::new(path).parent() == Some(dir) && is_real_dir(dir))
            .then_some(())
            .ok_or_else(|| "the holding folder changed, not touched".to_string())
    };
    let mut left = 0;
    let mut moved = 0;
    for copy in held.iter() {
        let Some(found) = locate(dir, copy) else {
            if fs::symlink_metadata(&copy.held).is_ok() {
                left += 1;
            }
            continue;
        };
        let current = readable_name(dir, &found, copy);
        let wanted = [Wanted {
            original: current.to_string_lossy().into_owned(),
            bytes: copy.bytes,
        }];
        for result in record.move_to_trash(&run, &wanted, &check) {
            match result {
                Moved::Trashed(entry) => {
                    moved += 1;
                    let restored_to = Entry {
                        original: copy.original.clone(),
                        ..entry
                    };
                    let _ = record.put(&[restored_to]);
                }
                Moved::Failed(entry) => {
                    eprintln!(
                        "disk-clean: could not move {} to the Trash: {}",
                        copy.original, entry.reason
                    );
                    if current != found {
                        let _ = platform::rename_excl(&current, &found);
                    }
                    left += 1;
                }
            }
        }
    }
    if left == 0 && only_bookkeeping(dir) {
        let _ = fs::remove_file(&manifest);
        let _ = fs::remove_file(dir.join("lock"));
        let _ = fs::remove_file(dir.join("manifest.jsonl.tmp"));
        let _ = fs::remove_dir(dir);
    }
    (moved, left)
}

pub fn migrate(home: &str) {
    let root = legacy_held_root(home);
    if !is_real_dir(&root) {
        return;
    }
    let Ok(list) = fs::read_dir(&root) else {
        return;
    };
    let runs: Vec<PathBuf> = list
        .flatten()
        .map(|e| e.path())
        .filter(|p| is_real_dir(p))
        .collect();
    let mut record = match Record::wait(home) {
        Ok(record) => record,
        Err(e) => {
            eprintln!("disk-clean: the old holding folder stays for now: {e}");
            return;
        }
    };
    let (mut moved, mut left) = (0, 0);
    for dir in runs {
        let (m, l) = migrate_run(&mut record, &dir);
        moved += m;
        left += l;
    }
    let _ = fs::remove_dir(&root);
    if moved > 0 || left > 0 {
        eprintln!(
            "disk-clean: moved {moved} held items from the old holding folder to the Trash{}",
            if left > 0 {
                format!(", {left} stay in {}", root.display())
            } else {
                String::new()
            }
        );
    }
}

fn ids_for(
    record: &Record,
    target: &str,
    decision: Option<u64>,
) -> Result<(String, Vec<String>), String> {
    if target == "--all" {
        return Ok((String::new(), record.of_run("")));
    }
    let run = Path::new(target);
    if !run.is_dir() {
        return Err(format!("no run directory at {target}"));
    }
    let id = match decision {
        Some(n) => round_run(run, n),
        None => run_id(run),
    };
    let ids = record.of_run(&id);
    Ok((id, ids))
}

pub fn result_line(name: &str, r: &Report) -> String {
    let verb = if name == "undo" {
        "restored"
    } else {
        "emptied"
    };
    format!(
        "{verb}: {} items, {} bytes; still in the Trash: {}",
        r.done, r.done_bytes, r.kept
    )
}

fn job(name: &str, target: Option<String>, decision: Option<u64>) -> io::Result<i32> {
    let Some(target) = target.filter(|d| !d.is_empty()) else {
        eprintln!("usage: disk-clean {name} RUN_DIR [--decision N] | --all");
        return Ok(2);
    };
    let home = util::home();
    let Some(mut record) = Record::open(&home, LOCK_TRIES)? else {
        eprintln!("the Trash record is busy (another clean, undo or empty is running)");
        return Ok(4);
    };
    let (run, ids) = match ids_for(&record, &target, decision) {
        Ok(found) => found,
        Err(e) => {
            eprintln!("{e}");
            return Ok(2);
        }
    };
    if ids.is_empty() {
        eprintln!("nothing disk-clean put in the Trash is still there for {target}");
        return Ok(3);
    }
    let dir = (target != "--all").then(|| Path::new(&target));
    let events = dir.map(clean::Events::append);
    let emit = |event: &str, data: Value| {
        if let Some(events) = &events {
            events.emit(event, data);
        }
    };
    let r = if name == "undo" {
        undo(&mut record, &ids, &run, &emit)?
    } else {
        empty(&mut record, &ids, &run, &emit)?
    };
    let line = result_line(name, &r);
    if let Some(dir) = dir {
        clean::log_line(dir, &format!("{name} from the terminal: {line}"));
    }
    let verb = if name == "undo" {
        "restored"
    } else {
        "emptied"
    };
    println!("{verb}: {} items, {} bytes", r.done, r.done_bytes);
    println!("still in the Trash: {}", r.kept);
    Ok(0)
}

pub fn run_undo(target: Option<String>, decision: Option<u64>) -> io::Result<i32> {
    job("undo", target, decision)
}

pub fn run_empty(target: Option<String>, decision: Option<u64>) -> io::Result<i32> {
    job("empty", target, decision)
}

pub fn ids_of(payload: &Value) -> Vec<String> {
    payload
        .get("ids")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .filter(|id| id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}
