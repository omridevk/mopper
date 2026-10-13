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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, mpsc};
use std::time::{Duration, Instant};

const PAGE: &str = include_str!("../assets/page.html");
const TIMEOUT: Duration = Duration::from_secs(1800);
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
const HEARTBEAT: Duration = Duration::from_secs(15);
const PROBE_EVERY: Duration = Duration::from_secs(1);
const NOTHING_FOUND: &str = "nothing-found";
const REVIEW_POSTS: [&str; 5] = ["/decide", "/preview", "/rescan", "/undo", "/empty"];

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

pub fn load_map(run_dir: &Path, home: &str, used: i64) -> Option<Node> {
    let path = run_dir.join("map.tsv");
    if !path.exists() {
        return None;
    }
    let rows = util::read_lines(&path)
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
        .collect();
    map_tree(rows, home, used)
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
    categories: Vec<Category>,
    index: clean::ScanIndex,
}

fn listed_in(dir: &Path) -> Finished {
    Finished {
        categories: load_scan(dir),
        index: clean::index_scan(&util::complete_lines(&dir.join("scan.tsv"))),
    }
}

#[derive(Default)]
struct Log {
    generation: u64,
    events: Vec<String>,
}

pub struct Live {
    dir: PathBuf,
    log: Mutex<Log>,
    changed: Condvar,
    finished: Mutex<Option<Arc<Finished>>>,
    scanning: AtomicBool,
    last_progress: Mutex<Option<Instant>>,
    cancel: Arc<AtomicBool>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
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
        }
    }

    fn finished(&self) -> Option<Arc<Finished>> {
        lock(&self.finished).clone()
    }

    fn listed(&self) -> Arc<Finished> {
        self.finished()
            .unwrap_or_else(|| Arc::new(listed_in(&self.dir)))
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

pub fn run_trash_job(
    name: &str,
    payload: &Value,
    run_dir: &Path,
    emit: trash::Emit,
) -> Result<Value, &'static str> {
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
    let result = if name == "/empty" {
        trash::empty(&mut record, &ids, &run, emit)
    } else {
        trash::undo(&mut record, &ids, &run, emit)
    };
    match result {
        Ok(report) => Ok(trash::rows(&report.changed)),
        Err(e) => {
            eprintln!("disk-clean: {e}");
            Err("500 Internal Server Error")
        }
    }
}

pub fn answer_trash_job(stream: &mut TcpStream, result: Result<Value, &'static str>) {
    match result {
        Ok(rows) => respond(
            stream,
            "200 OK",
            "application/json",
            rows.to_string().as_bytes(),
        ),
        Err(status) => refuse(stream, status),
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

fn handle(
    mut stream: TcpStream,
    port: u16,
    pages: &Pages,
    token: &str,
    decided: &mpsc::Sender<Value>,
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
            if route == "/favicon.ico" {
                respond(&mut stream, "204 No Content", "text/plain", b"");
            } else if route == "/events" {
                if constant_eq(query_token(target).as_bytes(), token.as_bytes()) {
                    stream_events(&mut stream, live);
                } else {
                    refuse(&mut stream, "403 Forbidden");
                }
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
            if !REVIEW_POSTS.contains(&target) {
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
            if target == "/undo" || target == "/empty" {
                if !http::is_own_origin_post(&req, port) {
                    return refuse(&mut stream, "403 Forbidden");
                }
                let emit = |event: &str, data: Value| live.emit(event, data);
                let result = run_trash_job(target, &payload, &live.dir, &emit);
                return answer_trash_job(&mut stream, result);
            }
            if target == "/rescan" {
                if live
                    .scanning
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_err()
                {
                    respond(&mut stream, "409 Conflict", "text/plain", b"scan running");
                    return;
                }
                live.restart();
                start_scan(Arc::clone(live), decided.clone(), false);
                respond(&mut stream, "202 Accepted", "application/json", b"{}");
                return;
            }
            let approve = payload.get("decision").and_then(Value::as_str) == Some("approve");
            let items = if target == "/preview" || approve {
                match picked(live, &payload) {
                    Ok(items) => items,
                    Err(reason) => {
                        respond(&mut stream, "409 Conflict", "text/plain", reason.as_bytes());
                        return;
                    }
                }
            } else {
                Vec::new()
            };
            if target == "/preview" {
                let listed = live.listed();
                let body =
                    preview(&listed.categories, &listed.index, &items, &util::home()).to_string();
                respond(&mut stream, "200 OK", "application/json", body.as_bytes());
                return;
            }
            let scanning = live.finished().is_none();
            if approve && scanning && selection(&live.listed().categories, &items).is_none() {
                respond(
                    &mut stream,
                    "409 Conflict",
                    "text/plain",
                    b"nothing selected has been listed by the scan yet",
                );
                return;
            }
            if !approve || scanning {
                live.cancel.store(true, Ordering::Relaxed);
            }
            respond(&mut stream, "200 OK", "application/json", b"{}");
            drop(stream);
            let mode = if payload.get("mode").and_then(Value::as_str) == Some("now") {
                "now"
            } else {
                "trash"
            };
            let _ = decided.send(if approve {
                json!({"decision": "approve", "items": items, "mode": mode})
            } else {
                json!({"decision": "cancel"})
            });
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

fn first_lines(dir: &Path, count: usize) -> Vec<String> {
    let mut lines = util::complete_lines(&dir.join("scan.tsv"));
    lines.truncate(count);
    lines
}

fn picked(live: &Live, payload: &Value) -> Result<Vec<Value>, &'static str> {
    let listed = payload
        .get("listed")
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok());
    let paths = match (live.finished(), listed) {
        (Some(done), _) => decoded(&done.categories, payload),
        (None, Some(count)) => decoded(&categories_of(&first_lines(&live.dir, count)), payload),
        (None, None) => decoded(&live.listed().categories, payload),
    };
    if selection::fingerprint(&paths) != text_of(payload, "fingerprint") {
        return Err(CHANGED);
    }
    Ok(paths
        .into_iter()
        .map(|path| json!({"path": path}))
        .collect())
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
    let categories = load_scan(dir);
    if categories.is_empty() {
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
    let live = Live::new(dir);
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

pub(crate) fn approved_page(dir: &Path, token: &str, emit: trash::Emit) -> Option<String> {
    let (mut data, _) = finished_run(dir)?;
    let selection: Value = std::fs::read(dir.join("selection.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())?;
    let paths: Vec<Value> = selection
        .get("items")?
        .as_array()?
        .iter()
        .filter_map(|i| i.get("path").cloned())
        .collect();
    data["approved"] = json!(true);
    data["selection"] = json!(paths);
    Some(render(&with_trash(data, dir, emit), token))
}

fn serve(data: &Value, live: Arc<Live>, tx: mpsc::Sender<Value>) -> io::Result<(u16, String)> {
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
            handle(stream, port, &pages, &token, &tx, &live)
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

fn watch_after_approval(dir: &Path, (port, token): (u16, String)) {
    let spawned = std::env::current_exe().and_then(|exe| {
        platform::spawn_detached(
            std::process::Command::new(exe)
                .arg("watch")
                .arg(dir)
                .env("DISK_CLEAN_WATCH_TOKEN", token)
                .env("DISK_CLEAN_WATCH_PORT", port.to_string())
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null()),
        )
    });
    if let Err(e) = spawned {
        eprintln!("could not start the cleanup page watcher: {e}");
    }
}

fn decide(rx: &mpsc::Receiver<Value>, live: &Live) -> io::Result<(i32, Option<PathBuf>)> {
    let Ok(payload) = rx.recv_timeout(TIMEOUT) else {
        eprintln!("timed out waiting for approval");
        return Ok((4, None));
    };
    match payload.get("decision").and_then(Value::as_str) {
        Some("approve") => {}
        Some(NOTHING_FOUND) => {
            eprintln!("nothing to clean");
            return Ok((3, None));
        }
        _ => {
            eprintln!("cancelled in the UI");
            return Ok((5, None));
        }
    }
    let items = payload
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let Some(mut selection) = selection(&live.listed().categories, &items) else {
        eprintln!("no deletable items were selected");
        return Ok((5, None));
    };
    selection["mode"] = payload.get("mode").cloned().unwrap_or(json!("trash"));
    clean::clear_previous_run(&live.dir)?;
    let out = live.dir.join("selection.json");
    std::fs::write(
        &out,
        serde_json::to_string_pretty(&selection).map_err(io::Error::other)?,
    )?;
    Ok((0, Some(out)))
}

fn start_scan(live: Arc<Live>, tx: mpsc::Sender<Value>, first: bool) {
    std::thread::spawn(move || {
        let started = Instant::now();
        match scan::scan(&live.dir, &*live, Arc::clone(&live.cancel)) {
            Ok(()) => {
                if first && live.finished().is_some_and(|f| f.categories.is_empty()) {
                    let _ = tx.send(json!({"decision": NOTHING_FOUND}));
                }
            }
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

fn live_scan() -> io::Result<i32> {
    let dir = scan::new_run_dir(None)?;
    let live = Arc::new(Live::new(&dir));
    let (tx, rx) = mpsc::channel();
    let served = serve(&json!({"live": true}), Arc::clone(&live), tx.clone())?;
    start_scan(Arc::clone(&live), tx, true);
    let (code, selection) = decide(&rx, &live)?;
    if selection.is_some() {
        watch_after_approval(&dir, served);
    }
    println!("{}", util::shown(&dir));
    if let Some(path) = selection {
        println!("{}", util::shown(&path));
    }
    Ok(code)
}

pub fn run(run_dir: Option<String>) -> io::Result<i32> {
    let Some(dir) = run_dir else {
        return live_scan();
    };
    let Some((data, live)) = finished_run(Path::new(&dir)) else {
        eprintln!("nothing to clean");
        return Ok(3);
    };
    let live = Arc::new(live);
    let (tx, rx) = mpsc::channel();
    let served = serve(&data, Arc::clone(&live), tx)?;
    let (code, selection) = decide(&rx, &live)?;
    if selection.is_some() {
        watch_after_approval(&live.dir, served);
    }
    if let Some(path) = selection {
        println!("{}", util::shown(&path));
    }
    Ok(code)
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
}
