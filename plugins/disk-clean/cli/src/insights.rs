use crate::platform;
use crate::util::tilde;
use crate::walk::Meta;
use serde_json::{Value, json};
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

const KINDS: [&str; 11] = [
    "video",
    "images",
    "audio",
    "archives",
    "disk-images",
    "documents",
    "code",
    "dependencies",
    "git",
    "caches",
    "other",
];
const DEPS: u8 = 7;
const GIT: u8 = 8;
const CACHES: u8 = 9;
const OTHER: u8 = 10;
const BUCKETS: [&str; 7] = ["<1w", "<1m", "<3m", "<6m", "<1y", "<2y", "older"];
const BUCKET_DAYS: [i64; 6] = [7, 30, 91, 182, 365, 730];
const DAYS: usize = 365;
const TOP_FOLDERS: usize = 12;
const TOP_FILES: usize = 25;

// Per-directory state inherited by everything under ~: its age_by_folder row and folder-based kind.
#[derive(Clone, Copy)]
pub struct Ins {
    depth: usize,
    folder: usize,
    kind: Option<u8>,
}

#[derive(Default)]
pub struct Insights {
    started: bool,
    days: Vec<(u64, u64)>,
    folders: Vec<(String, [u64; 7])>,
    kinds: [(u64, u64); 11],
    largest: BinaryHeap<Reverse<(u64, PathBuf, i64)>>,
}

// Local midnights for today and the DAYS-1 days before it, newest first.
pub fn midnights(now: i64) -> Vec<i64> {
    platform::local_midnights(now, DAYS)
}

fn dir_kind(name: &[u8], parent: &Path, depth: usize) -> Option<u8> {
    match name {
        b"node_modules" | b".venv" | b"venv" | b"target" | b".gradle" | b"Pods" => Some(DEPS),
        b"bundle" if parent.file_name().is_some_and(|n| n == "vendor") => Some(DEPS),
        b".git" => Some(GIT),
        b".cache" => Some(CACHES),
        b"Caches" if depth == 2 && parent.file_name().is_some_and(|n| n == "Library") => {
            Some(CACHES)
        }
        _ => None,
    }
}

fn ext_kind(name: &[u8]) -> u8 {
    let Some(dot) = name.iter().rposition(|b| *b == b'.') else {
        return OTHER;
    };
    let ext = &name[dot + 1..];
    if dot == 0 || ext.len() > 5 {
        return OTHER;
    }
    let mut buf = [0u8; 5];
    let low = &mut buf[..ext.len()];
    low.copy_from_slice(ext);
    low.make_ascii_lowercase();
    match &*low {
        b"mp4" | b"mov" | b"mkv" | b"avi" | b"webm" | b"m4v" => 0,
        b"jpg" | b"jpeg" | b"png" | b"gif" | b"heic" | b"webp" | b"tiff" | b"psd" | b"raw" => 1,
        b"mp3" | b"wav" | b"flac" | b"aac" | b"m4a" | b"aiff" | b"ogg" => 2,
        b"zip" | b"tar" | b"gz" | b"tgz" | b"bz2" | b"xz" | b"7z" | b"rar" | b"zst" => 3,
        b"dmg" | b"iso" | b"img" | b"vmdk" | b"qcow2" | b"vdi" | b"ipsw" => 4,
        b"pdf" | b"doc" | b"docx" | b"xls" | b"xlsx" | b"ppt" | b"pptx" | b"key" | b"pages"
        | b"txt" | b"md" | b"csv" => 5,
        b"rs" | b"ts" | b"tsx" | b"js" | b"jsx" | b"py" | b"go" | b"java" | b"c" | b"h"
        | b"cpp" | b"swift" | b"rb" | b"sh" | b"json" | b"html" | b"css" => 6,
        _ => OTHER,
    }
}

// State for ~ itself; None after the first time so a second walk root can't double count.
pub fn start(acc: &mut Insights) -> Option<Ins> {
    if acc.started {
        return None;
    }
    acc.started = true;
    acc.days = vec![(0, 0); DAYS];
    acc.folders.push(("~".to_string(), [0; 7]));
    Some(Ins {
        depth: 0,
        folder: 0,
        kind: None,
    })
}

pub fn enter(acc: &mut Insights, parent: Ins, parent_path: &Path, name: &OsStr) -> Ins {
    let depth = parent.depth + 1;
    let mut folder = parent.folder;
    if depth <= 2 {
        let label = format!("{}/{}", acc.folders[folder].0, name.to_string_lossy());
        acc.folders.push((label, [0; 7]));
        folder = acc.folders.len() - 1;
    }
    Ins {
        depth,
        folder,
        kind: parent
            .kind
            .or_else(|| dir_kind(name.as_encoded_bytes(), parent_path, depth)),
    }
}

pub fn add(
    acc: &mut Insights,
    ins: Ins,
    days: &[i64],
    now: i64,
    name: &OsStr,
    meta: &Meta,
    path: impl FnOnce() -> PathBuf,
) {
    let bytes = meta.blocks * 512;
    let kind = ins
        .kind
        .unwrap_or_else(|| ext_kind(name.as_encoded_bytes()));
    let k = &mut acc.kinds[kind as usize];
    *k = (k.0 + bytes, k.1 + 1);
    let age = (now - meta.mtime) / 86400;
    let bucket = BUCKET_DAYS.partition_point(|d| age >= *d);
    acc.folders[ins.folder].1[bucket] += bytes;
    let day = days.partition_point(|m| *m > meta.mtime);
    if let Some(d) = acc.days.get_mut(day) {
        *d = (d.0 + bytes, d.1 + 1);
    }
    let min = acc.largest.peek().map(|Reverse(f)| f.0);
    if acc.largest.len() < TOP_FILES || min.is_some_and(|m| bytes > m) {
        acc.largest.push(Reverse((bytes, path(), meta.mtime)));
        if acc.largest.len() > TOP_FILES {
            acc.largest.pop();
        }
    }
}

pub fn to_json(acc: &Insights, days: &[i64], now: i64, home: &str) -> Value {
    let modified_by_day: Vec<Value> = acc
        .days
        .iter()
        .zip(days)
        .filter(|((_, files), _)| *files > 0)
        .map(|((bytes, files), m)| json!({"day": platform::day_label(*m), "bytes": bytes, "files": files}))
        .collect();
    let mut folders: Vec<&(String, [u64; 7])> = acc.folders.iter().collect();
    folders.sort_by_key(|(_, b)| Reverse(b.iter().sum::<u64>()));
    let folders: Vec<Value> = folders
        .into_iter()
        .take(TOP_FOLDERS)
        .map(|(path, bytes)| json!({"path": path, "bytes": bytes}))
        .collect();
    let mut by_kind: Vec<(&str, (u64, u64))> = KINDS.into_iter().zip(acc.kinds).collect();
    by_kind.sort_by_key(|(_, (bytes, _))| Reverse(*bytes));
    let by_kind: Vec<Value> = by_kind
        .into_iter()
        .map(|(kind, (bytes, files))| json!({"kind": kind, "bytes": bytes, "files": files}))
        .collect();
    let largest: Vec<Value> = acc
        .largest
        .clone()
        .into_sorted_vec()
        .into_iter()
        .map(|Reverse((bytes, path, mtime))| {
            json!({"path": tilde(&crate::util::shown(&path), home), "bytes": bytes, "mtime": mtime})
        })
        .collect();
    json!({
        "generated_at": now,
        "modified_by_day": modified_by_day,
        "age_by_folder": {"buckets": BUCKETS, "folders": folders},
        "by_kind": by_kind,
        "largest_files": largest,
    })
}
