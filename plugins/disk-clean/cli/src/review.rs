use crate::clean;
use crate::http::{self, constant_eq, query_token, refuse, respond};
use crate::platform;
use crate::scan::{self, Sink};
use crate::selection::{self, Listed};
use crate::trash;
use crate::util;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io::{self, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, mpsc};
use std::time::{Duration, Instant};

const PAGE: &str = include_str!("../assets/page.html");
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
const HEARTBEAT: Duration = Duration::from_secs(15);
const PROBE_EVERY: Duration = Duration::from_secs(1);
const FOLLOW_EVERY: Duration = Duration::from_millis(250);
const FLUSH_BEFORE_EXIT: Duration = Duration::from_millis(300);
const SETTLED: [&str; 3] = ["done", "abandoned", "interrupted"];

#[derive(Serialize, Clone)]
pub struct Item {
    pub path: String,
    pub label: String,
    pub bytes: i64,
    pub action: String,
    pub cmd_id: String,
    pub note: String,
    pub age: Option<i64>,
    pub accuracy: String,
    pub preselect: bool,
    pub report: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub checking: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
}

#[derive(Serialize)]
pub struct Category {
    pub id: String,
    pub title: String,
    pub desc: String,
    pub risk: String,
    pub items: Vec<Item>,
    pub bytes: i64,
}

#[derive(Serialize)]
pub struct Node {
    pub name: String,
    pub path: String,
    pub bytes: i64,
    pub files: i64,
    pub mtime: i64,
    pub children: Vec<Node>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub rest: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub file: bool,
}

pub fn parse_row(f: &[&str]) -> Option<(Value, Item)> {
    let [
        id,
        title,
        desc,
        risk,
        pre,
        action,
        cmd_id,
        label,
        path,
        bytes,
        note,
        age,
        accuracy,
    ] = f
    else {
        return None;
    };
    let bytes = bytes.trim().parse::<i64>().ok()?;
    let item = Item {
        path: path.to_string(),
        label: label.to_string(),
        bytes,
        action: action.to_string(),
        cmd_id: cmd_id.to_string(),
        note: note.to_string(),
        age: if !age.is_empty() && age.bytes().all(|b| b.is_ascii_digit()) {
            age.parse().ok()
        } else {
            None
        },
        accuracy: if accuracy.is_empty() {
            "exact".to_string()
        } else {
            accuracy.to_string()
        },
        preselect: *pre == "1" && *risk != "report",
        report: *risk == "report",
        checking: false,
        line: None,
    };
    Some((
        json!({"id": id, "title": title, "desc": desc, "risk": risk}),
        item,
    ))
}

pub fn load_scan(run_dir: &Path) -> Vec<Category> {
    categories_of(&util::complete_lines(&run_dir.join("scan.tsv")))
}

pub fn categories_of(lines: &[String]) -> Vec<Category> {
    let mut latest: HashMap<String, ([String; 4], Item)> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for line in lines {
        let f: Vec<&str> = line.split('\t').collect();
        let Some((_, item)) = parse_row(&f) else {
            continue;
        };
        let head = [f[0], f[1], f[2], f[3]].map(str::to_string);
        if latest.insert(item.path.clone(), (head, item)).is_none() {
            order.push(f[8].to_string());
        }
    }
    let mut cats: Vec<Category> = Vec::new();
    for path in &order {
        let Some(([id, title, desc, risk], item)) = latest.remove(path) else {
            continue;
        };
        match cats.iter_mut().find(|c| c.id == id) {
            Some(c) => c.items.push(item),
            None => cats.push(Category {
                id,
                title,
                desc,
                risk,
                items: vec![item],
                bytes: 0,
            }),
        }
    }
    for c in &mut cats {
        c.items.sort_by_key(|i| -i.bytes);
        c.bytes = c.items.iter().map(|i| i.bytes).sum();
    }
    cats.sort_by_key(|c| (c.risk == "report", -c.bytes));
    cats
}

fn disk_stats() -> (u64, u64) {
    platform::volume_stats(&platform::data_mount()).map_or((0, 0), |s| (s.avail, s.total))
}

pub fn load_facts(run_dir: &Path) -> HashMap<String, i64> {
    util::read_lines(&run_dir.join("disk.tsv"))
        .iter()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            match parts.as_slice() {
                [k, v] => v.trim().parse().ok().map(|n| (k.to_string(), n)),
                _ => None,
            }
        })
        .collect()
}

fn dirname(p: &str) -> &str {
    let head = &p[..p.rfind('/').map_or(0, |i| i + 1)];
    let trimmed = head.trim_end_matches('/');
    if trimmed.is_empty() || util::is_root(head) {
        head
    } else {
        trimmed
    }
}

fn tsv_rows(path: &Path) -> Vec<(i64, i64, i64, String)> {
    util::read_lines(path)
        .iter()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            let (size, files, mtime, p) = match parts.as_slice() {
                [size, p] => (*size, "0", "0", *p),
                [size, files, mtime, p] => (*size, *files, *mtime, *p),
                _ => return None,
            };
            let n = size.trim().parse::<i64>().ok()?;
            Some((
                n,
                files.parse().unwrap_or(0),
                mtime.parse().unwrap_or(0),
                p.to_string(),
            ))
        })
        .collect()
}

pub fn load_map(run_dir: &Path, home: &str, used: i64) -> Option<Node> {
    let path = run_dir.join("map.tsv");
    if !path.exists() {
        return None;
    }
    map_tree(tsv_rows(&path), home, used)
}

const FILE_FLOOR: u64 = 1_048_576;

fn leaf(path: &str, bytes: i64, files: i64, mtime: i64, file: bool) -> Node {
    Node {
        name: path.rsplit('/').next().unwrap_or("").to_string(),
        path: path.to_string(),
        bytes,
        files,
        mtime,
        children: Vec::new(),
        rest: false,
        file,
    }
}

pub fn folder(run_dir: &Path, path: &str) -> Option<Node> {
    let rows = tsv_rows(&run_dir.join("index.tsv"));
    let (bytes, files, mtime, _) = rows.iter().find(|r| r.3 == path)?.clone();
    let mut kids: Vec<Node> = rows
        .iter()
        .filter(|r| r.3 != path && dirname(&r.3) == path)
        .map(|(b, f, m, p)| leaf(p, *b, *f, *m, false))
        .collect();
    let mut entries = 0i64;
    for entry in std::fs::read_dir(path).into_iter().flatten().flatten() {
        entries += 1;
        let Ok(m) = entry.metadata() else { continue };
        let meta = platform::meta_of(&m);
        let allocated = meta.blocks * 512;
        if meta.kind != crate::walk::Kind::File || meta.nlink > 1 || allocated < FILE_FLOOR {
            continue;
        }
        if let Some(p) = platform::path_text(&entry.path()) {
            kids.push(leaf(&p, allocated as i64, 1, meta.mtime, true));
        }
    }
    kids.sort_by_key(|k| -k.bytes);
    let shown: i64 = kids.iter().map(|k| k.bytes).sum();
    let shown_files: i64 = kids.iter().map(|k| k.files).sum();
    let rest = (bytes - shown).max(0);
    if rest > 0 {
        let hidden = (entries - kids.len() as i64).max(0);
        kids.push(Node {
            name: format!("{hidden} smaller items"),
            path: format!("{path}/*"),
            bytes: rest,
            files: (files - shown_files).max(0),
            mtime: 0,
            children: Vec::new(),
            rest: true,
            file: false,
        });
    }
    let mut node = leaf(path, bytes, files, mtime, false);
    node.children = kids;
    Some(node)
}

pub fn map_tree(rows: Vec<(i64, i64, i64, String)>, home: &str, used: i64) -> Option<Node> {
    let mut sizes: HashMap<String, i64> = HashMap::new();
    let mut stats: HashMap<String, (i64, i64)> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for (n, files, mtime, p) in rows {
        stats.insert(p.clone(), (files, mtime));
        if sizes.insert(p.clone(), n).is_none() {
            order.push(p);
        }
    }
    let root = order
        .iter()
        .find(|p| util::is_root(p))
        .cloned()
        .unwrap_or_else(|| home.to_string());
    let root_size = *sizes.get(&root)?;
    if util::is_root(&root) && used > root_size {
        sizes.insert(root.clone(), used);
    }
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for p in &order {
        let parent = dirname(p);
        if *p != root && sizes.contains_key(parent) {
            children
                .entry(parent.to_string())
                .or_default()
                .push(p.clone());
        }
    }
    Some(build(&root, home, &sizes, &stats, &children))
}

fn build(
    p: &str,
    home: &str,
    sizes: &HashMap<String, i64>,
    stats: &HashMap<String, (i64, i64)>,
    children: &HashMap<String, Vec<String>>,
) -> Node {
    let name = if p == home {
        "~".to_string()
    } else if util::is_root(p) {
        "Whole disk (apparent sizes)".to_string()
    } else {
        p.rsplit('/').next().unwrap_or("").to_string()
    };
    let bytes = sizes.get(p).copied().unwrap_or(0);
    let mut kids: Vec<&String> = children
        .get(p)
        .map(|k| k.iter().collect())
        .unwrap_or_default();
    kids.sort_by_key(|k| -sizes.get(*k).copied().unwrap_or(0));
    let mut nodes: Vec<Node> = kids
        .into_iter()
        .map(|k| build(k, home, sizes, stats, children))
        .collect();
    let (files, mtime) = stats.get(p).copied().unwrap_or((0, 0));
    let shown: i64 = nodes.iter().map(|n| n.bytes).sum();
    let shown_files: i64 = nodes.iter().map(|n| n.files).sum();
    let rest = bytes - shown;
    if !nodes.is_empty() && rest > 0 {
        nodes.push(Node {
            name: if util::is_root(p) {
                "unreadable or system-protected"
            } else {
                "everything else in this folder"
            }
            .to_string(),
            path: format!("{p}/*"),
            bytes: rest,
            files: (files - shown_files).max(0),
            mtime: 0,
            children: Vec::new(),
            rest: true,
            file: false,
        });
    }
    Node {
        name,
        path: p.to_string(),
        bytes,
        files,
        mtime,
        children: nodes,
        rest: false,
        file: false,
    }
}

pub fn token() -> String {
    let mut raw = [0u8; 16];
    platform::fill_random(&mut raw);
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in raw.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..=chunk.len() {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

fn attribute(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub fn render(data: &Value, token: &str) -> String {
    let json = data.to_string().replace('<', "\\u003c");
    PAGE.replacen("__TOKEN__", token, 1)
        .replacen("__PLATFORM__", platform::PAGE_PLATFORM, 1)
        .replacen("__HOME__", &attribute(&util::home()), 1)
        .replacen("__DATA__", &json, 1)
}

struct Finished {
    lines: Vec<String>,
    index: clean::ScanIndex,
}

fn listed_in(dir: &Path) -> Finished {
    let lines = util::complete_lines(&dir.join("scan.tsv"));
    Finished {
        index: clean::index_scan(&lines),
        lines,
    }
}

#[derive(Default)]
struct Log {
    generation: u64,
    events: Vec<String>,
}

struct Decided {
    number: u64,
    paths: Vec<String>,
}

pub struct Live {
    dir: PathBuf,
    log: Mutex<Log>,
    changed: Condvar,
    finished: Mutex<Option<Arc<Finished>>>,
    scanning: AtomicBool,
    last_progress: Mutex<Option<Instant>>,
    cancel: Arc<AtomicBool>,
    decided: Mutex<Vec<Decided>>,
    elapsed_ms: AtomicU64,
    snapshots: AtomicI64,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn decided_in(dir: &Path) -> Vec<Decided> {
    clean::decisions(dir)
        .into_iter()
        .map(|number| Decided {
            number,
            paths: clean::read_decision(dir, number)
                .and_then(|d| d.get("items").and_then(Value::as_array).cloned())
                .unwrap_or_default()
                .iter()
                .filter_map(|i| i.get("path").and_then(Value::as_str).map(str::to_string))
                .collect(),
        })
        .collect()
}

fn is_at_or_inside(path: &str, outer: &str) -> bool {
    path.strip_prefix(outer)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(['/', std::path::MAIN_SEPARATOR]))
}

fn is_gone(path: &str) -> bool {
    !path.starts_with("cmd:") && platform::is_link(Path::new(path)).is_none()
}

fn settled(status: &str) -> bool {
    SETTLED.contains(&status)
}

impl Live {
    fn new(dir: &Path) -> Live {
        Live {
            dir: dir.to_path_buf(),
            log: Mutex::default(),
            changed: Condvar::new(),
            finished: Mutex::new(None),
            scanning: AtomicBool::new(true),
            last_progress: Mutex::new(None),
            cancel: Arc::new(AtomicBool::new(false)),
            decided: Mutex::new(decided_in(dir)),
            elapsed_ms: AtomicU64::new(0),
            snapshots: AtomicI64::new(0),
        }
    }

    fn finished(&self) -> Option<Arc<Finished>> {
        lock(&self.finished).clone()
    }

    fn restart(&self) {
        *lock(&self.finished) = None;
        if let Err(e) = std::fs::write(self.dir.join("scan.tsv"), "") {
            eprintln!("could not reset scan.tsv for the rescan: {e}");
        }
        *lock(&self.last_progress) = None;
        let mut log = lock(&self.log);
        log.generation += 1;
        log.events = vec![format!(
            "event: rescan\ndata: {}\n\n",
            json!({"elapsed_ms": 0})
        )];
        self.changed.notify_all();
    }

    fn held_back(&self, path: &str) -> bool {
        let decided = lock(&self.decided);
        decided.iter().any(|d| {
            d.paths.iter().any(|outer| {
                is_at_or_inside(path, outer)
                    && (is_gone(outer) || !settled(&clean::run_status(&self.dir, d.number)))
            })
        })
    }

    fn unfinished(&self) -> bool {
        lock(&self.decided)
            .iter()
            .any(|d| !settled(&clean::run_status(&self.dir, d.number)))
    }

    fn emit_now(&self, event: &str, mut data: Value) {
        data["elapsed_ms"] = json!(self.elapsed_ms.load(Ordering::Relaxed));
        self.emit(event, data);
    }
}

impl Sink for Live {
    fn emit(&self, event: &str, data: Value) {
        if event == "progress" {
            let mut last = lock(&self.last_progress);
            if last.is_some_and(|t| t.elapsed() < PROGRESS_EVERY) {
                return;
            }
            *last = Some(Instant::now());
        }
        if event == "item"
            && data["item"]["path"]
                .as_str()
                .is_some_and(|p| self.held_back(p))
        {
            return;
        }
        if event == "disk"
            && let Some(n) = data["snapshots"].as_i64()
        {
            self.snapshots.store(n, Ordering::Relaxed);
        }
        if let Some(ms) = data["elapsed_ms"].as_u64() {
            self.elapsed_ms.fetch_max(ms, Ordering::Relaxed);
        }
        if event == "done" {
            *lock(&self.finished) = Some(Arc::new(listed_in(&self.dir)));
        }
        let mut log = lock(&self.log);
        if event == "growing"
            && let Some(i) = log
                .events
                .iter()
                .rposition(|e| e.starts_with("event: growing\n"))
        {
            log.events[i].clear();
        }
        log.events.push(format!("event: {event}\ndata: {data}\n\n"));
        if event == "done" || event == "error" {
            self.scanning.store(false, Ordering::SeqCst);
        }
        drop(log);
        self.changed.notify_all();
    }
}

fn backlog(live: &Live) -> (u64, usize, String) {
    let log = lock(&live.log);
    (log.generation, log.events.len(), log.events.concat())
}

fn stream_events(out: &mut TcpStream, live: &Live) {
    let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\nconnection: close\r\n\r\n";
    let (mut generation, mut sent, replay) = backlog(live);
    let caught_up = format!("event: replayed\ndata: {}\n\n", json!({"elapsed_ms": 0}));
    if out
        .write_all(format!("{head}{replay}{caught_up}").as_bytes())
        .is_err()
    {
        return;
    }
    let mut quiet = Instant::now();
    loop {
        let batch = {
            let log = lock(&live.log);
            let (log, _) = live
                .changed
                .wait_timeout_while(log, PROBE_EVERY, |l| {
                    l.generation == generation && l.events.len() == sent
                })
                .unwrap_or_else(PoisonError::into_inner);
            if log.generation != generation {
                (generation, sent) = (log.generation, 0);
            }
            let batch = log.events[sent..].concat();
            sent = log.events.len();
            batch
        };
        let chunk = if !batch.is_empty() {
            batch
        } else if http::client_gone(out) {
            return;
        } else if quiet.elapsed() >= HEARTBEAT {
            ":\n\n".to_string()
        } else {
            continue;
        };
        if out.write_all(chunk.as_bytes()).is_err() {
            return;
        }
        quiet = Instant::now();
    }
}

struct Pages {
    first: Value,
    live: Value,
}

pub fn with_trash(mut data: Value, run_dir: &Path, emit: trash::Emit) -> Value {
    let home = util::home();
    data["trash"] = json!(trash::synced(&home, emit));
    data["run"] = json!(trash::run_id(run_dir));
    data
}

fn run_trash_job(
    name: &str,
    payload: &Value,
    run_dir: &Path,
    emit: trash::Emit,
) -> Result<(Value, String), &'static str> {
    let ids = trash::ids_of(payload);
    if ids.is_empty() {
        return Err("400 Bad Request");
    }
    let home = util::home();
    let Ok(Some(mut record)) = trash::Record::open(&home, 1) else {
        return Err("409 Conflict");
    };
    if record.trashed(&ids).is_empty() {
        return Err("404 Not Found");
    }
    let run = trash::run_id(run_dir);
    let job = if name == "/empty" { "empty" } else { "undo" };
    let result = if job == "empty" {
        trash::empty(&mut record, &ids, &run, emit)
    } else {
        trash::undo(&mut record, &ids, &run, emit)
    };
    match result {
        Ok(report) => Ok((
            trash::rows(&report.changed),
            trash::result_line(job, &report),
        )),
        Err(e) => {
            eprintln!("disk-clean: {e}");
            Err("500 Internal Server Error")
        }
    }
}

fn post_payload(body: &[u8]) -> Option<Value> {
    if body.is_empty() {
        return Some(json!({}));
    }
    match serde_json::from_slice(body) {
        Ok(v @ Value::Object(_)) => Some(v),
        _ => None,
    }
}

fn page_job(stream: &mut TcpStream, target: &str, payload: &Value, live: &Live) {
    let events = clean::Events::append(&live.dir);
    let emit = |event: &str, data: Value| events.emit(event, data);
    let name = target.trim_start_matches('/');
    match run_trash_job(target, payload, &live.dir, &emit) {
        Ok((rows, line)) => {
            let line = format!("page: {name} from the page: {line}");
            clean::log_line(&live.dir, &line);
            crate::session::notice(&live.dir, name, &line);
            respond(
                stream,
                "200 OK",
                "application/json",
                rows.to_string().as_bytes(),
            );
        }
        Err(status) => refuse(stream, status),
    }
}

fn rescan(stream: &mut TcpStream, live: &Arc<Live>) {
    if live.unfinished() {
        let reason = b"a cleanup is waiting or running; rescan when it finishes";
        return respond(stream, "409 Conflict", "text/plain", reason);
    }
    if live
        .scanning
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return respond(stream, "409 Conflict", "text/plain", b"scan running");
    }
    live.restart();
    start_scan(Arc::clone(live));
    respond(stream, "202 Accepted", "application/json", b"{}");
}

fn end_in_page(stream: &mut TcpStream, live: &Live) {
    live.cancel.store(true, Ordering::Relaxed);
    let line = format!(
        "ended: the user pressed Cancel in the page, so nothing more is deleted; close the session with disk-clean stop {}",
        util::shown(&live.dir)
    );
    clean::log_line(&live.dir, "the user pressed Cancel in the page");
    crate::session::notice(&live.dir, "ended", &line);
    respond(stream, "200 OK", "application/json", b"{}");
}

fn pick_row(live: &Live, path: &str) -> Result<String, &'static str> {
    if live.finished().is_none() {
        return Err("the scan is still running; add it once the scan finishes");
    }
    let home = util::home();
    clean::safe_to_remove("rm", path, &home, platform::user_tmp_base().as_deref())?;
    if platform::is_link(Path::new(path)).is_none() {
        return Err("already gone");
    }
    let lines = lines_now(live, None);
    if lines
        .iter()
        .any(|l| l.split('\t').nth(3) != Some("report") && is_at_or_inside(path, path_of(l)))
    {
        return Err("already in the cleanup list");
    }
    let bytes = crate::walk::size_of(Path::new(path)).map_or(0, |b| b.div_ceil(2) * 1024);
    Ok(scan::picked_row(&home, util::now(), path, bytes).join("\t"))
}

fn add_pick(stream: &mut TcpStream, live: &Live, path: &str) {
    let line = match pick_row(live, path) {
        Ok(line) => line,
        Err(reason) => return respond(stream, "409 Conflict", "text/plain", reason.as_bytes()),
    };
    let written = std::fs::OpenOptions::new()
        .append(true)
        .open(live.dir.join("scan.tsv"))
        .and_then(|mut f| writeln!(f, "{line}"));
    if let Err(e) = written {
        let reason = format!("could not record it in scan.tsv: {e}");
        return respond(
            stream,
            "500 Internal Server Error",
            "text/plain",
            reason.as_bytes(),
        );
    }
    let finished = listed_in(&live.dir);
    let count = finished.lines.len();
    *lock(&live.finished) = Some(Arc::new(finished));
    let fields: Vec<&str> = line.split('\t').collect();
    let Some((category, mut item)) = parse_row(&fields) else {
        return refuse(stream, "500 Internal Server Error");
    };
    item.line = Some(count);
    let body = json!({"category": category, "item": item});
    live.emit_now("item", body.clone());
    respond(
        stream,
        "200 OK",
        "application/json",
        body.to_string().as_bytes(),
    );
}

fn approve(stream: &mut TcpStream, live: &Live, payload: &Value) {
    let items = match picked(live, payload) {
        Ok(items) => items,
        Err(reason) => {
            return respond(stream, "409 Conflict", "text/plain", reason.as_bytes());
        }
    };
    let mode = if text_of(payload, "mode") == "now" {
        "now"
    } else {
        "trash"
    };
    match record_decision(live, &items, mode) {
        Ok(Some(n)) => respond(
            stream,
            "200 OK",
            "application/json",
            json!({"decision": n}).to_string().as_bytes(),
        ),
        Ok(None) => respond(
            stream,
            "409 Conflict",
            "text/plain",
            b"nothing selected can be deleted: it is not listed yet, already approved or gone",
        ),
        Err(e) => {
            eprintln!("disk-clean: could not record the decision: {e}");
            refuse(stream, "500 Internal Server Error");
        }
    }
}

fn stop_session(stream: &mut TcpStream, live: &Live, stop: &mpsc::Sender<()>) {
    live.cancel.store(true, Ordering::Relaxed);
    live.emit_now("closed", json!({}));
    clean::log_line(&live.dir, "the session was stopped");
    respond(stream, "200 OK", "application/json", b"{}");
    let _ = stop.send(());
}

fn handle(
    mut stream: TcpStream,
    port: u16,
    pages: &Pages,
    token: &str,
    stop: &mpsc::Sender<()>,
    live: &Arc<Live>,
) {
    let req = match http::read_request(&mut stream) {
        Ok(req) => req,
        Err(Some(status)) => return refuse(&mut stream, status),
        Err(None) => return,
    };
    if !http::is_local_host(&req, port) {
        return refuse(&mut stream, "403 Forbidden");
    }
    let target = req.target.as_str();
    match req.method.as_str() {
        "GET" => {
            let route = target.split('?').next().unwrap_or("");
            let tokened = constant_eq(query_token(target).as_bytes(), token.as_bytes());
            if route == "/favicon.ico" {
                respond(&mut stream, "204 No Content", "text/plain", b"");
            } else if http::STREAMS.contains(&route) && !tokened {
                refuse(&mut stream, "403 Forbidden");
            } else if route == "/events" {
                stream_events(&mut stream, live);
            } else if route == "/clean-events" {
                crate::session::stream_events(&mut stream, &live.dir);
            } else if http::is_page_route(route) {
                let data = if lock(&live.log).generation > 0 {
                    &pages.live
                } else {
                    &pages.first
                };
                let emit = |event: &str, data: Value| live.emit(event, data);
                let html = render(&with_trash(data.clone(), &live.dir, &emit), token);
                respond(
                    &mut stream,
                    "200 OK",
                    "text/html; charset=utf-8",
                    html.as_bytes(),
                );
            } else {
                refuse(&mut stream, "404 Not Found");
            }
        }
        "POST" => {
            if !http::POST_ROUTES.contains(&target) {
                return refuse(&mut stream, "404 Not Found");
            }
            if !http::is_trusted_post(&req) {
                return refuse(&mut stream, "403 Forbidden");
            }
            let Some(payload) = post_payload(&req.body) else {
                return refuse(&mut stream, "400 Bad Request");
            };
            let sent = match payload.get("token") {
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(),
                None => String::new(),
            };
            if !constant_eq(sent.as_bytes(), token.as_bytes()) {
                return refuse(&mut stream, "403 Forbidden");
            }
            match target {
                "/undo" | "/empty" if !http::is_own_origin_post(&req, port) => {
                    refuse(&mut stream, "403 Forbidden")
                }
                "/undo" | "/empty" => page_job(&mut stream, target, &payload, live),
                "/rescan" => rescan(&mut stream, live),
                "/children" => match folder(&live.dir, text_of(&payload, "path")) {
                    Some(node) => {
                        let body = json!(node).to_string();
                        respond(&mut stream, "200 OK", "application/json", body.as_bytes())
                    }
                    None => refuse(&mut stream, "404 Not Found"),
                },
                "/pick" => add_pick(&mut stream, live, text_of(&payload, "path")),
                "/stop" => stop_session(&mut stream, live, stop),
                "/preview" => match picked(live, &payload) {
                    Ok(items) => {
                        let finished = live.finished();
                        let lines = lines_now(live, None);
                        let index = finished
                            .as_ref()
                            .map_or_else(|| clean::index_scan(&lines), |f| f.index.clone());
                        let body =
                            preview(&categories_now(live, &lines), &index, &items, &util::home())
                                .to_string();
                        respond(&mut stream, "200 OK", "application/json", body.as_bytes());
                    }
                    Err(reason) => {
                        respond(&mut stream, "409 Conflict", "text/plain", reason.as_bytes())
                    }
                },
                _ if text_of(&payload, "decision") == "approve" => {
                    approve(&mut stream, live, &payload)
                }
                _ => end_in_page(&mut stream, live),
            }
        }
        _ => refuse(&mut stream, "501 Not Implemented"),
    }
}

const CHANGED: &str =
    "the list changed while this request was on its way; check the selection and try again";

fn listed_of(categories: &[Category]) -> Vec<Listed<'_>> {
    categories
        .iter()
        .flat_map(|c| {
            c.items.iter().filter(|i| !i.report).map(|i| Listed {
                path: &i.path,
                section: &c.id,
                preselect: i.preselect,
            })
        })
        .collect()
}

fn text_of<'a>(payload: &'a Value, key: &str) -> &'a str {
    payload.get(key).and_then(Value::as_str).unwrap_or("")
}

fn decoded(categories: &[Category], payload: &Value) -> Vec<String> {
    selection::decode(
        &listed_of(categories),
        text_of(payload, "add"),
        text_of(payload, "drop"),
    )
}

fn path_of(line: &str) -> &str {
    line.split('\t').nth(8).unwrap_or("")
}

fn lines_now(live: &Live, listed: Option<usize>) -> Vec<String> {
    if let Some(done) = live.finished() {
        return done.lines.clone();
    }
    let mut lines = util::complete_lines(&live.dir.join("scan.tsv"));
    if let Some(count) = listed {
        lines.truncate(count);
    }
    lines
}

fn categories_now(live: &Live, lines: &[String]) -> Vec<Category> {
    if lock(&live.decided).is_empty() {
        return categories_of(lines);
    }
    let shown: Vec<String> = lines
        .iter()
        .filter(|l| !live.held_back(path_of(l)))
        .cloned()
        .collect();
    categories_of(&shown)
}

fn picked(live: &Live, payload: &Value) -> Result<Vec<Value>, &'static str> {
    let listed = payload
        .get("listed")
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok());
    let categories = categories_now(live, &lines_now(live, listed));
    let paths = decoded(&categories, payload);
    if selection::fingerprint(&paths) != text_of(payload, "fingerprint") {
        return Err(CHANGED);
    }
    Ok(paths
        .into_iter()
        .map(|path| json!({"path": path}))
        .collect())
}

fn record_decision(live: &Live, items: &[Value], mode: &str) -> io::Result<Option<u64>> {
    let lines = lines_now(live, None);
    let categories = categories_now(live, &lines);
    let Some(mut chosen) = selection(&categories, items) else {
        return Ok(None);
    };
    let index = live
        .finished()
        .map_or_else(|| clean::index_scan(&lines), |f| f.index.clone());
    let mut decided = lock(&live.decided);
    let n = clean::decisions(&live.dir)
        .into_iter()
        .chain(decided.iter().map(|d| d.number))
        .max()
        .unwrap_or(0)
        + 1;
    chosen["decision"] = json!(n);
    chosen["mode"] = json!(mode);
    chosen["plan"] = preview(&categories, &index, items, &util::home());
    let path = clean::decision_path(&live.dir, n);
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder)?;
    }
    util::write_atomic(
        &path,
        serde_json::to_string_pretty(&chosen)
            .map_err(io::Error::other)?
            .as_bytes(),
    )?;
    let chosen_items = chosen["items"].as_array().cloned().unwrap_or_default();
    let planned: Vec<Value> = chosen_items
        .iter()
        .map(|i| {
            json!({
                "path": i["path"],
                "label": i["label"],
                "bytes": i["bytes"],
                "section": i["category"],
                "exact": i["exact"],
            })
        })
        .collect();
    let total = chosen["total_bytes"].as_i64().unwrap_or(0);
    clean::Events::round(&live.dir, n).emit(
        "approved",
        json!({
            "items": planned,
            "bytes": total,
            "mode": mode,
            "trash_run": trash::round_run(&live.dir, n),
        }),
    );
    clean::log_line(
        &live.dir,
        &format!(
            "approved decision {n}: {} items, {total} bytes, {} (waiting for Claude to run it)",
            planned.len(),
            if mode == "now" {
                "delete immediately"
            } else {
                "to the Trash"
            }
        ),
    );
    decided.push(Decided {
        number: n,
        paths: chosen_items
            .iter()
            .filter_map(|i| i["path"].as_str().map(str::to_string))
            .collect(),
    });
    Ok(Some(n))
}

pub fn selection(categories: &[Category], items: &[Value]) -> Option<Value> {
    let mut valid: HashMap<&str, (&Item, &str)> = HashMap::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for c in categories {
        for item in c.items.iter().filter(|i| !i.report) {
            valid.insert(&item.path, (item, &c.id));
        }
    }
    let mut chosen: Vec<Value> = Vec::new();
    for item in items {
        let Some((known, section)) = item
            .get("path")
            .and_then(Value::as_str)
            .and_then(|p| valid.get(p))
            .filter(|(known, _)| seen.insert(&known.path))
        else {
            continue;
        };
        chosen.push(json!({
            "path": known.path,
            "label": known.label,
            "bytes": known.bytes,
            "action": known.action,
            "cmd_id": known.cmd_id,
            "category": section,
            "exact": known.accuracy == "exact",
        }));
    }
    if chosen.is_empty() {
        return None;
    }
    chosen.sort_by_key(|i| -i["bytes"].as_i64().unwrap_or(0));
    let total: i64 = chosen
        .iter()
        .map(|i| i["bytes"].as_i64().unwrap_or(0))
        .sum();
    Some(json!({"items": chosen, "total_bytes": total}))
}

pub fn preview(
    categories: &[Category],
    index: &clean::ScanIndex,
    items: &[Value],
    home: &str,
) -> Value {
    let chosen = selection(categories, items)
        .and_then(|s| s.get("items").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    let plan = clean::plan_in(index, &chosen, home);
    let rejected: Vec<Value> = plan
        .rejected
        .iter()
        .map(|(reason, path)| json!({"reason": reason, "path": path}))
        .collect();
    let paths: Vec<Value> = plan
        .rm
        .iter()
        .map(|path| json!({"path": path, "bytes": plan.size_of(path), "trashed": clean::already_trashed(path, home)}))
        .collect();
    let undoable: Vec<&String> = plan.worktrees.iter().chain(&plan.cmds).collect();
    json!({
        "paths": paths,
        "paths_bytes": plan.rm.iter().map(|p| plan.size_of(p)).sum::<i64>(),
        "final": plan.final_steps(),
        "final_bytes": undoable.iter().map(|k| plan.size_of(k)).sum::<i64>(),
        "final_count": undoable.len(),
        "rejected": rejected,
        "count": plan.count(),
        "bytes": plan.bytes,
    })
}

fn reclaimable(categories: &[Category]) -> i64 {
    categories
        .iter()
        .filter(|c| c.risk != "report")
        .flat_map(|c| &c.items)
        .filter(|i| i.accuracy == "exact")
        .map(|i| i.bytes)
        .sum()
}

fn finished_run(dir: &Path) -> Option<(Value, Live)> {
    let live = Live::new(dir);
    let categories = categories_now(&live, &util::complete_lines(&dir.join("scan.tsv")));
    if categories.is_empty() && lock(&live.decided).is_empty() {
        return None;
    }
    let (free, total) = disk_stats();
    let (free, total) = (free as i64, total as i64);
    let facts = load_facts(dir);
    let fact = |k: &str| facts.get(k).copied().filter(|v| *v != 0);
    let home = util::home();
    let used = fact("used").unwrap_or((total - free).max(0));
    let tree = load_map(dir, &home, used);
    let insights: Value = std::fs::read(dir.join("insights.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    let reclaimable = reclaimable(&categories);
    let at_zero = |mut data: Value| {
        data["elapsed_ms"] = json!(0);
        data
    };
    let snapshots = fact("snapshots").unwrap_or(0);
    let home_bytes = fact("home").unwrap_or(0);
    live.emit(
        "disk",
        at_zero(json!({"total": fact("total").unwrap_or(total), "used": used, "free": free, "snapshots": snapshots})),
    );
    for c in &categories {
        let category = json!({"id": c.id, "title": c.title, "desc": c.desc, "risk": c.risk});
        for item in &c.items {
            live.emit("item", at_zero(json!({"category": category, "item": item})));
        }
    }
    live.emit(
        "walked",
        at_zero(json!({"home": home_bytes, "tree": tree, "insights": insights, "worktrees": 0})),
    );
    live.emit("done", at_zero(json!({"reclaimable": reclaimable})));
    let data = json!({
        "categories": categories,
        "reclaimable": reclaimable,
        "free": free,
        "total": fact("total").unwrap_or(total),
        "used": used,
        "home": home_bytes,
        "snapshots": snapshots,
        "tree": tree,
        "insights": insights,
    });
    Some((data, live))
}

fn serve(data: &Value, live: Arc<Live>, stop: mpsc::Sender<()>) -> io::Result<(u16, String)> {
    let token = token();
    let pages = Arc::new(Pages {
        first: data.clone(),
        live: json!({"live": true}),
    });
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let url = format!("http://127.0.0.1:{port}/");
    let served = (port, token.clone());
    std::thread::spawn(move || {
        http::serve(listener, move |stream| {
            handle(stream, port, &pages, &token, &stop, &live)
        });
    });
    eprintln!("review UI: {url}");
    if std::env::var("DISK_CLEAN_NO_BROWSER").is_ok_and(|v| v == "1") {
        eprintln!("DISK_CLEAN_NO_BROWSER=1, not opening a browser");
    } else {
        let _ = platform::open_in_browser(&url);
    }
    Ok(served)
}

fn start_scan(live: Arc<Live>) {
    std::thread::spawn(move || {
        let started = Instant::now();
        match scan::scan(&live.dir, &*live, Arc::clone(&live.cancel)) {
            Ok(()) => {}
            Err(e) if e.kind() != io::ErrorKind::Interrupted => {
                let elapsed_ms = started.elapsed().as_millis() as u64;
                live.emit(
                    "error",
                    json!({"message": e.to_string(), "elapsed_ms": elapsed_ms}),
                );
            }
            Err(_) => {}
        }
    });
}

fn disk_now(live: &Live) {
    let Some(stats) = platform::volume_stats(&platform::data_mount()) else {
        return;
    };
    live.emit_now(
        "disk",
        json!({
            "total": stats.total,
            "used": stats.used,
            "free": stats.avail,
            "snapshots": live.snapshots.load(Ordering::Relaxed),
        }),
    );
}

fn round_finished(live: &Live, n: u64) {
    let gone: Vec<String> = lock(&live.decided)
        .iter()
        .filter(|d| d.number == n)
        .flat_map(|d| d.paths.iter().filter(|p| is_gone(p)).cloned())
        .collect();
    if !gone.is_empty() {
        let mut leaving: Vec<String> = util::complete_lines(&live.dir.join("scan.tsv"))
            .iter()
            .map(|l| path_of(l).to_string())
            .filter(|p| gone.iter().any(|g| is_at_or_inside(p, g)))
            .chain(gone.iter().cloned())
            .collect();
        leaving.sort();
        leaving.dedup();
        for path in leaving {
            live.emit_now("unlisted", json!({"path": path}));
        }
    }
    disk_now(live);
}

fn relist(live: &Live, path: &str) {
    let lines = util::complete_lines(&live.dir.join("scan.tsv"));
    let Some(line) = lines.iter().rev().find(|l| path_of(l) == path) else {
        return;
    };
    let fields: Vec<&str> = line.split('\t').collect();
    if let Some((category, item)) = parse_row(&fields) {
        live.emit_now("item", json!({"category": category, "item": item}));
    }
}

fn follow(live: Arc<Live>) {
    let mut follower = crate::session::follower(&live.dir, true);
    loop {
        std::thread::sleep(FOLLOW_EVERY);
        for (name, event) in crate::session::next_events(&mut follower) {
            let decision = event.get("decision").and_then(Value::as_u64);
            match (name.as_str(), decision) {
                ("done" | "abandoned", Some(n)) => round_finished(&live, n),
                ("undone", _) if event["outcome"] == "restored" => {
                    if let Some(path) = event["path"].as_str() {
                        relist(&live, path);
                    }
                }
                ("undo_done" | "empty_done", _) => disk_now(&live),
                _ => {}
            }
        }
        let numbers: Vec<u64> = lock(&live.decided).iter().map(|d| d.number).collect();
        for n in numbers {
            clean::run_status(&live.dir, n);
        }
    }
}

pub fn run(run_dir: Option<String>) -> io::Result<i32> {
    let (dir, data, live, fresh) = match run_dir {
        None => {
            let dir = scan::new_run_dir(None)?;
            let live = Live::new(&dir);
            (dir, json!({"live": true}), live, true)
        }
        Some(dir) => {
            let Some((data, live)) = finished_run(Path::new(&dir)) else {
                eprintln!("nothing to clean");
                return Ok(3);
            };
            (PathBuf::from(dir), data, live, false)
        }
    };
    let Some(_session) = crate::session::claim(&dir)? else {
        eprintln!(
            "a disk-clean session is already open for {}",
            util::shown(&dir)
        );
        return Ok(4);
    };
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{}", util::shown(&dir))?;
    stdout.flush()?;
    drop(stdout);
    let live = Arc::new(live);
    let (stop, stopped) = mpsc::channel();
    let (port, token) = serve(&data, Arc::clone(&live), stop)?;
    crate::session::write(&dir, port, &token)?;
    let following = Arc::clone(&live);
    std::thread::spawn(move || follow(following));
    if fresh {
        start_scan(Arc::clone(&live));
    }
    let _ = stopped.recv();
    std::thread::sleep(FLUSH_BEFORE_EXIT);
    crate::session::close(&dir);
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_keeps_one_growing_snapshot_in_the_backlog() {
        let live = Live::new(Path::new("."));
        for n in 0..4 {
            live.emit("growing", json!({"n": n}));
            live.emit("unlisted", json!({"path": n}));
        }
        let (_, len, replay) = backlog(&live);
        assert_eq!(len, 8);
        assert_eq!(replay.matches("event: growing").count(), 1);
        assert!(replay.contains(r#"data: {"n":3}"#));
        assert_eq!(replay.matches("event: unlisted").count(), 4);
    }

    #[test]
    fn approved_paths_and_paths_inside_them_are_never_listed_again() {
        let dir = std::env::temp_dir().join(format!("disk-clean-held-{}", std::process::id()));
        let (kept, gone) = (dir.join("kept"), dir.join("gone"));
        std::fs::create_dir_all(&kept).unwrap();
        std::fs::create_dir_all(clean::decision_dir(&dir, 1)).unwrap();
        std::fs::create_dir_all(clean::decision_dir(&dir, 2)).unwrap();
        let text = |p: &Path| p.to_str().unwrap().to_string();
        let decision = |paths: &[String]| {
            json!({"items": paths.iter().map(|p| json!({"path": p})).collect::<Vec<_>>()})
                .to_string()
        };
        std::fs::write(
            clean::decision_path(&dir, 1),
            decision(&[text(&kept), text(&gone)]),
        )
        .unwrap();
        std::fs::write(clean::decision_dir(&dir, 1).join("status"), "done\n").unwrap();
        let waiting = dir.join("waiting");
        std::fs::write(clean::decision_path(&dir, 2), decision(&[text(&waiting)])).unwrap();
        let live = Live::new(&dir);
        let item = |p: &Path| json!({"item": {"path": text(p)}});
        for path in [
            &gone,
            &gone.join("inner"),
            &waiting,
            &waiting.join("x"),
            &kept,
            &kept.join("x"),
            &dir.join("gone-too"),
        ] {
            live.emit("item", item(path));
        }
        let (_, len, replay) = backlog(&live);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(len, 3, "{replay}");
        assert!(replay.contains(&format!("\"{}\"", text(&kept))));
        assert!(replay.contains(&text(&kept.join("x"))));
        assert!(replay.contains(&text(&dir.join("gone-too"))));
        assert!(live.unfinished(), "decision 2 waits for Claude");
    }
}
