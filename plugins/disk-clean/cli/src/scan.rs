use crate::insights;
use crate::platform;
use crate::review;
use crate::trash;
use crate::util::{self, tilde};
use crate::walk::{self, Plan, Walk};
use crate::worktrees;
use serde_json::{Value, json};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

pub type Row = [String; 13];

pub struct Config {
    pub min_bytes: u64,
    pub stale_days: i64,
    pub bigfile_bytes: u64,
    pub old_download_days: i64,
    pub max_report_items: usize,
    pub map_min_bytes: u64,
    pub map_depth: usize,
    pub nm_depth: usize,
    pub nm_min_bytes: u64,
    pub skip_map: bool,
}

impl Config {
    pub fn from_env() -> Config {
        Config {
            min_bytes: util::env_num("DISK_CLEAN_MIN_BYTES", 10_485_760),
            stale_days: util::env_num("DISK_CLEAN_STALE_DAYS", 90),
            bigfile_bytes: util::env_num("DISK_CLEAN_BIGFILE_BYTES", 1_073_741_824),
            old_download_days: util::env_num("DISK_CLEAN_OLD_DOWNLOAD_DAYS", 180),
            max_report_items: util::env_num("DISK_CLEAN_MAX_REPORT_ITEMS", 40),
            map_min_bytes: util::env_num("DISK_CLEAN_MAP_MIN_BYTES", 209_715_200),
            map_depth: util::env_num("DISK_CLEAN_MAP_DEPTH", 5),
            nm_depth: util::env_num("DISK_CLEAN_NM_DEPTH", 9),
            nm_min_bytes: util::env_num("DISK_CLEAN_NM_MIN_BYTES", 5_242_880),
            skip_map: std::env::var("DISK_CLEAN_SKIP_MAP").is_ok_and(|v| v == "1"),
        }
    }
}

pub(crate) struct Ctx {
    pub(crate) home: String,
    now: i64,
    walk: Walk,
    parallel: bool,
}

fn early(home: &str, now: i64, parallel: bool) -> Ctx {
    Ctx {
        home: home.to_string(),
        now,
        walk: Walk::default(),
        parallel,
    }
}

pub(crate) struct Cat<'a> {
    pub(crate) id: &'a str,
    pub(crate) title: &'a str,
    pub(crate) desc: &'a str,
    pub(crate) risk: &'a str,
    pub(crate) pre: &'a str,
}

fn kb_bytes(blocks: u64) -> u64 {
    blocks.div_ceil(2) * 1024
}

pub(crate) fn size_bytes(ctx: &Ctx, path: &Path) -> Option<u64> {
    if let Some(r) = ctx.walk.sizes.get(path) {
        return Some(kb_bytes(*r));
    }
    let is_link = fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink());
    if !is_link
        && let Some(r) = fs::canonicalize(path).ok().and_then(|c| {
            ctx.walk.sizes.get(&c).or_else(|| {
                platform::path_text(&c).and_then(|text| ctx.walk.sizes.get(Path::new(&text)))
            })
        })
    {
        return Some(kb_bytes(*r));
    }
    walk::size_with(path, ctx.parallel).map(kb_bytes)
}

pub(crate) fn age_of(ctx: &Ctx, path: &Path) -> String {
    match fs::symlink_metadata(path) {
        Ok(m) => ((ctx.now - platform::meta_of(&m).mtime) / 86400).to_string(),
        Err(_) => "-".to_string(),
    }
}

pub(crate) fn artifacts(ctx: &Ctx) -> &[PathBuf] {
    &ctx.walk.artifacts
}

pub(crate) fn children_of(ctx: &Ctx, dir: &Path) -> Vec<PathBuf> {
    if let Some(list) = ctx.walk.children.get(dir) {
        return list.clone();
    }
    fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).collect())
        .unwrap_or_default()
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn row(
    cat: &Cat,
    action: &str,
    cmd_id: &str,
    label: &str,
    path: &str,
    bytes: u64,
    note: &str,
    age: &str,
    accuracy: &str,
) -> Row {
    [
        cat.id.to_string(),
        cat.title.to_string(),
        cat.desc.to_string(),
        cat.risk.to_string(),
        cat.pre.to_string(),
        action.to_string(),
        cmd_id.to_string(),
        label.to_string(),
        path.to_string(),
        bytes.to_string(),
        note.to_string(),
        age.to_string(),
        accuracy.to_string(),
    ]
}

pub(crate) fn sized(
    ctx: &Ctx,
    out: &mut Vec<Row>,
    cat: &Cat,
    paths: &[PathBuf],
    note: &str,
    min: u64,
) {
    for p in paths {
        if !p.exists() {
            continue;
        }
        let Some(s) = platform::path_text(p) else {
            continue;
        };
        let s = s.as_str();
        let Some(bytes) = size_bytes(ctx, p) else {
            continue;
        };
        if bytes < min {
            continue;
        }
        out.push(row(
            cat,
            "rm",
            "-",
            &tilde(s, &ctx.home),
            s,
            bytes,
            note,
            &age_of(ctx, p),
            "exact",
        ));
    }
}

pub(crate) fn h(ctx: &Ctx, rel: &str) -> PathBuf {
    PathBuf::from(format!("{}/{rel}", ctx.home))
}

pub(crate) fn existing(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    paths.into_iter().filter(|p| p.exists()).collect()
}

pub fn parse_docker_bytes(s: &str) -> u64 {
    let b = s.as_bytes();
    let numeric = |c: u8| c.is_ascii_digit() || c == b'.';
    let mut i = 0;
    while i < b.len() {
        if !numeric(b[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && numeric(b[i]) {
            i += 1;
        }
        let mut j = i;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        let unit = match (b.get(j), b.get(j + 1)) {
            (Some(b'K'), Some(b'B')) => Some(1u64 << 10),
            (Some(b'M'), Some(b'B')) => Some(1 << 20),
            (Some(b'G'), Some(b'B')) => Some(1 << 30),
            (Some(b'T'), Some(b'B')) => Some(1 << 40),
            (Some(b'B'), _) => Some(1),
            _ => None,
        };
        if let Some(unit) = unit {
            return s[start..i]
                .parse::<f64>()
                .map(|v| (v * unit as f64) as u64)
                .unwrap_or(0);
        }
    }
    0
}

fn probe_docker() -> Option<u64> {
    if !platform::which("docker") || !util::output("docker", &["info"])?.0 {
        return None;
    }
    let (_, out) = util::output("docker", &["system", "df", "--format", "{{.Reclaimable}}"])?;
    Some(parse_docker_bytes(out.lines().next().unwrap_or("")))
}

fn plan(cfg: &Config, home: &str, now: i64, tmp_base: Option<&str>) -> Plan {
    let (mut exact, parents) = platform::plan_locations(home, tmp_base);
    exact.insert(PathBuf::from(home));
    let (roots, never) = platform::drives_to_walk(home);
    Plan {
        home: PathBuf::from(home),
        map_depth: (!cfg.skip_map).then_some(cfg.map_depth),
        map_min_kb: cfg.map_min_bytes / 1024,
        nm_depth: cfg.nm_depth,
        dev_depth: 7,
        big_depth: 6,
        repo_depth: worktrees::repo_depth(),
        stale_days: cfg.stale_days,
        now,
        big_bytes: cfg.bigfile_bytes,
        exact,
        parents,
        roots,
        never,
        held: trash::legacy_held_root(home),
        repo_tx: None,
        days: insights::midnights(now),
        cancel: Arc::default(),
    }
}

pub trait Sink: Sync {
    fn emit(&self, event: &str, data: Value);
}

pub struct FilesOnly;

impl Sink for FilesOnly {
    fn emit(&self, _: &str, _: Value) {}
}

fn run_walk(
    cfg: &Config,
    mut plan: Plan,
    home: &str,
    tmp_base: Option<&str>,
    mount: &Path,
    progress: &dyn Fn(&Walk, &Path, &[walk::Open]),
) -> Walk {
    let mut out = Walk::default();
    let mut seen = HashSet::new();
    let home_root = Path::new(platform::split_root(home).map_or("/", |(root, _)| root));
    let on_a_drive = |p: &Path| plan.roots.iter().any(|root| p.starts_with(root));
    let mut drives: Vec<PathBuf> = plan.roots.clone();
    if cfg.skip_map {
        let mut roots = vec![PathBuf::from(home), PathBuf::from(platform::SYSTEM_TMP)];
        roots.extend(tmp_base.map(PathBuf::from));
        roots.retain(|r| r.is_dir() && !on_a_drive(r));
        for root in &roots {
            walk::walk(root, root, &plan, true, &mut seen, &mut out, progress);
        }
    } else {
        walk::walk(mount, home_root, &plan, true, &mut seen, &mut out, progress);
        drives.retain(|root| root != home_root);
        plan.map_depth = None;
    }
    for root in &drives {
        walk::walk(root, root, &plan, true, &mut seen, &mut out, progress);
    }
    out
}

pub fn new_run_dir(run_dir: Option<String>) -> io::Result<PathBuf> {
    let run_dir = match run_dir.filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => PathBuf::from(format!(
            "{}/.cache/disk-clean/run-{}",
            util::home(),
            platform::local_time(c"%Y%m%d-%H%M%S")
        )),
    };
    fs::create_dir_all(&run_dir)?;
    Ok(run_dir)
}

pub fn run(run_dir: Option<String>) -> io::Result<i32> {
    let run_dir = new_run_dir(run_dir)?;
    scan(&run_dir, &FilesOnly, Arc::new(AtomicBool::new(false)))?;
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{}", util::shown(&run_dir))?;
    Ok(0)
}

static IN_ORDER: Mutex<()> = Mutex::new(());

fn emit(sink: &dyn Sink, started: Instant, event: &str, mut data: Value) {
    let _in_order = IN_ORDER.lock().unwrap_or_else(PoisonError::into_inner);
    data["elapsed_ms"] = json!(started.elapsed().as_millis() as u64);
    sink.emit(event, data);
}

struct Published {
    shown: HashMap<String, Row>,
    order: Vec<Row>,
    settled: HashSet<String>,
    checking: HashSet<String>,
    record: fs::File,
    lines: usize,
    cancel: Arc<AtomicBool>,
    started: Instant,
}

fn valid(rows: &[Row]) -> impl Iterator<Item = &Row> {
    rows.iter().filter(|r| !r[8].contains(['\t', '\n']))
}

fn show(out: &mut Published, row: &Row, sink: &dyn Sink) {
    if out.cancel.load(Ordering::Relaxed) || out.shown.get(&row[8]) == Some(row) {
        return;
    }
    out.shown.insert(row[8].clone(), row.clone());
    out.checking.remove(&row[8]);
    let fields: Vec<&str> = row.iter().map(String::as_str).collect();
    let Some((category, mut item)) = review::parse_row(&fields) else {
        return;
    };
    if let Err(e) = out
        .record
        .write_all(format!("{}\n", row.join("\t")).as_bytes())
    {
        eprintln!("  could not record {} in scan.tsv: {e}", row[8]);
        return;
    }
    out.lines += 1;
    item.line = Some(out.lines);
    emit(
        sink,
        out.started,
        "item",
        json!({"category": category, "item": item}),
    );
}

fn pend(rows: &[Row], out: &Mutex<Published>, sink: &dyn Sink) {
    let mut out = out.lock().unwrap_or_else(PoisonError::into_inner);
    if out.cancel.load(Ordering::Relaxed) {
        return;
    }
    for r in valid(rows) {
        if out.shown.contains_key(&r[8]) || out.settled.contains(&r[8]) {
            continue;
        }
        if !out.checking.insert(r[8].clone()) {
            continue;
        }
        let fields: Vec<&str> = r.iter().map(String::as_str).collect();
        if let Some((category, mut item)) = review::parse_row(&fields) {
            item.checking = true;
            emit(
                sink,
                out.started,
                "item",
                json!({"category": category, "item": item}),
            );
        }
    }
}

fn unpend(paths: impl IntoIterator<Item = String>, out: &Mutex<Published>, sink: &dyn Sink) {
    let mut out = out.lock().unwrap_or_else(PoisonError::into_inner);
    for path in paths {
        if out.checking.remove(&path) && !out.cancel.load(Ordering::Relaxed) {
            emit(sink, out.started, "unlisted", json!({"path": path}));
        }
    }
}

fn preview(rows: &[Row], out: &Mutex<Published>, sink: &dyn Sink) {
    let mut out = out.lock().unwrap_or_else(PoisonError::into_inner);
    for r in valid(rows) {
        let taken = out.shown.get(&r[8]).is_some_and(|s| s[0] != r[0]);
        if !taken && !out.settled.contains(&r[8]) {
            show(&mut out, r, sink);
        }
    }
}

fn settle(rows: &[Row], out: &Mutex<Published>, sink: &dyn Sink) {
    let mut out = out.lock().unwrap_or_else(PoisonError::into_inner);
    for r in valid(rows) {
        if out.settled.insert(r[8].clone()) {
            out.order.push(r.clone());
            show(&mut out, r, sink);
        }
    }
}

fn unsettled(ctx: &Ctx, out: &Mutex<Published>) -> Vec<Row> {
    let out = out.lock().unwrap_or_else(PoisonError::into_inner);
    let mut rows: Vec<Row> = out
        .shown
        .values()
        .filter(|r| !out.settled.contains(&r[8]))
        .cloned()
        .collect();
    rows.sort_by(|a, b| a[8].cmp(&b[8]));
    for r in &mut rows {
        if let Some(bytes) = size_bytes(ctx, Path::new(&r[8])) {
            r[9] = bytes.to_string();
        }
    }
    rows
}

fn users(rows: Vec<Row>, home: &str) -> Vec<Row> {
    rows.into_iter()
        .filter(|r| platform::belongs_to_user(Path::new(&r[8]), home))
        .collect()
}

fn map_rows<'a>(
    map: impl IntoIterator<Item = walk::Open<'a>>,
    min_kb: u64,
) -> Vec<(i64, i64, i64, String)> {
    map.into_iter()
        .filter_map(|(p, blocks, files, mtime)| {
            let kb = blocks.div_ceil(2);
            let s = platform::path_text(p)?;
            (kb >= min_kb || util::is_root(&s))
                .then(|| ((kb * 1024) as i64, files as i64, mtime, s))
        })
        .collect()
}

fn interrupted() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "scan cancelled")
}

pub fn scan(run_dir: &Path, sink: &dyn Sink, cancel: Arc<AtomicBool>) -> io::Result<()> {
    platform::utility_qos();
    let _ = rayon::ThreadPoolBuilder::new()
        .start_handler(|_| platform::utility_qos())
        .build_global();
    let cfg = Config::from_env();
    let home = util::home();
    let now = util::now();
    let started = Instant::now();
    eprintln!("  scanning (one parallel walk of the data volume)...");

    let tmp_base = platform::user_tmp_base();
    let mount = platform::data_mount();
    let start = platform::volume_stats(&mount);
    let used = start.as_ref().map_or(0, |s| s.used);
    let snapshots = platform::probe_snapshots();
    emit(
        sink,
        started,
        "disk",
        json!({
            "total": start.as_ref().map_or(0, |s| s.total),
            "used": used,
            "free": start.as_ref().map_or(0, |s| s.avail),
            "snapshots": snapshots,
        }),
    );
    let mut plan = plan(&cfg, &home, now, tmp_base.as_deref());
    plan.cancel = Arc::clone(&cancel);
    let (repo_tx, repo_rx) = std::sync::mpsc::channel();
    plan.repo_tx = Some(repo_tx);
    let days = plan.days.clone();
    let out = Mutex::new(Published {
        shown: HashMap::new(),
        order: Vec::new(),
        settled: HashSet::new(),
        checking: HashSet::new(),
        record: fs::File::create(run_dir.join("scan.tsv"))?,
        lines: 0,
        cancel: Arc::clone(&cancel),
        started,
    });
    let min_kb = cfg.map_min_bytes / 1024;
    let grown = Cell::new(Instant::now());
    let progress = |w: &Walk, dir: &Path, open: &[walk::Open]| {
        emit(
            sink,
            started,
            "progress",
            json!({"files": w.files, "bytes": w.bytes, "dir": dir.to_string_lossy()}),
        );
        if grown.get().elapsed() < GROWING_EVERY {
            return;
        }
        grown.set(Instant::now());
        let finished = w.map.iter().map(|(p, b, f, m)| (p.as_path(), *b, *f, *m));
        let tree = (!open.is_empty())
            .then(|| {
                review::map_tree(
                    map_rows(finished.chain(open.iter().copied()), min_kb),
                    &home,
                    0,
                )
            })
            .flatten();
        emit(
            sink,
            started,
            "growing",
            json!({"tree": tree, "insights": insights::to_json(&w.insights, &days, now, &home)}),
        );
    };
    let walk_ctx: OnceLock<Ctx> = OnceLock::new();
    let waiting: Mutex<Vec<worktrees::Checked>> = Mutex::new(Vec::new());
    let checked_so_far = AtomicUsize::new(0);
    let show_worktrees = |ctx: &Ctx, checked: &[worktrees::Checked]| {
        let rows = users(
            worktrees::rows(checked, &home, |p| size_bytes(ctx, p).unwrap_or(0)),
            &home,
        );
        preview(&rows, &out, sink);
        unpend(
            checked
                .iter()
                .filter_map(|c| c.entry.get("worktree").cloned()),
            &out,
            sink,
        );
    };
    let on_listed = |entries: &[worktrees::Entry]| {
        pend(
            &users(worktrees::checking_rows(entries, &home), &home),
            &out,
            sink,
        );
    };
    let on_checked = |c: &worktrees::Checked| {
        checked_so_far.fetch_add(1, Ordering::Relaxed);
        let mut waiting = waiting.lock().unwrap_or_else(PoisonError::into_inner);
        match walk_ctx.get() {
            Some(ctx) => {
                drop(waiting);
                show_worktrees(ctx, std::slice::from_ref(c));
            }
            None => waiting.push(c.clone()),
        }
    };
    let (listed_tx, listed_rx) = std::sync::mpsc::channel();
    std::thread::scope(|s| {
        let (out, cfg, home) = (&out, &cfg, &home);
        let docker = s.spawn(move || {
            platform::utility_qos();
            if platform::which("docker") {
                pend(&[docker_row(0)], out, sink);
            }
            let bytes = probe_docker();
            let mut rows = Vec::new();
            scan_docker(&mut rows, cfg, bytes);
            preview(&rows, out, sink);
            unpend([DOCKER_KEY.to_string()], out, sink);
            bytes
        });
        let sims = s.spawn(move || {
            platform::utility_qos();
            if platform::has_sims(home) {
                pend(&[platform::sims_row(platform::SIMS_COMMAND, 0)], out, sink);
            }
            let sims = platform::probe_sims(home);
            let mut rows = Vec::new();
            platform::scan_sims(&early(home, now, true), &mut rows, sims);
            preview(&rows, out, sink);
            unpend([SIMS_KEY.to_string()], out, sink);
            sims
        });
        let (on_listed, on_checked) = (&on_listed, &on_checked);
        let checks = s.spawn(move || {
            platform::utility_qos();
            worktrees::check_repos(repo_rx, listed_tx, on_listed, on_checked)
        });

        let pkg_cache = platform::probe_pkg_cache();
        let fixed = early(home, now, true);
        let mut rows: Vec<Row> = Vec::new();
        platform::scan_trash_and_tools(&fixed, &mut rows, cfg, pkg_cache.as_deref());
        platform::scan_app_data(&fixed, &mut rows, cfg);
        preview(&rows, out, sink);
        eprintln!(
            "  sized {} fixed locations in {:.1}s",
            rows.len(),
            started.elapsed().as_secs_f64()
        );

        let mut walked = run_walk(cfg, plan, home, tmp_base.as_deref(), &mount, &progress);
        if cancel.load(Ordering::Relaxed) {
            return Err(interrupted());
        }
        walked
            .node_modules
            .retain(|p| platform::belongs_to_user(p, home));
        walked
            .artifacts
            .retain(|p| platform::belongs_to_user(p, home));
        walked
            .big_files
            .retain(|(p, ..)| platform::belongs_to_user(p, home));
        eprintln!("  walked the disk in {}s", started.elapsed().as_secs());
        let too_deep = walked.too_deep;
        if too_deep > 0 {
            eprintln!("  skipped {too_deep} folders nested too deep to read");
        }
        let insights = insights::to_json(&walked.insights, &days, now, home);
        let finished_early = {
            let mut waiting = waiting.lock().unwrap_or_else(PoisonError::into_inner);
            let _ = walk_ctx.set(Ctx {
                home: home.clone(),
                now,
                walk: walked,
                parallel: false,
            });
            std::mem::take(&mut *waiting)
        };
        let Some(ctx) = walk_ctx.get() else {
            return Err(interrupted());
        };

        let mut rows: Vec<Row> = Vec::new();
        platform::scan_trash_and_tools(ctx, &mut rows, cfg, pkg_cache.as_deref());
        scan_node_modules(ctx, &mut rows, cfg);
        scan_dev_artifacts(ctx, &mut rows, cfg);
        platform::scan_app_data(ctx, &mut rows, cfg);
        platform::scan_temp(ctx, &mut rows, cfg, tmp_base.as_deref());
        scan_big_files(ctx, &mut rows, cfg);
        settle(&rows, out, sink);
        show_worktrees(ctx, &finished_early);

        let finished = ctx
            .walk
            .map
            .iter()
            .map(|(p, b, f, m)| (p.as_path(), *b, *f, *m));
        let map: String = map_rows(finished, min_kb)
            .into_iter()
            .map(|(bytes, files, mtime, s)| format!("{bytes}\t{files}\t{mtime}\t{s}\n"))
            .collect();
        util::write_atomic(&run_dir.join("map.tsv"), map.as_bytes())?;
        util::write_atomic(
            &run_dir.join("insights.json"),
            insights.to_string().as_bytes(),
        )?;
        let home_bytes = size_bytes(ctx, Path::new(home)).unwrap_or(0);
        let listed = listed_rx.recv().unwrap_or(0);
        let running = listed.saturating_sub(checked_so_far.load(Ordering::Relaxed));
        emit(
            sink,
            started,
            "walked",
            json!({
                "home": home_bytes,
                "tree": review::load_map(run_dir, home, used as i64),
                "insights": insights,
                "worktrees": running,
            }),
        );

        let checked = checks.join().unwrap_or_default();
        eprintln!(
            "  checked {} git worktrees by {}s",
            checked.len(),
            started.elapsed().as_secs()
        );
        let mut rows = users(
            worktrees::rows(&checked, home, |p| size_bytes(ctx, p).unwrap_or(0)),
            home,
        );
        scan_old_downloads(ctx, &mut rows, cfg);
        platform::scan_sims(ctx, &mut rows, sims.join().unwrap_or(0));
        scan_docker(&mut rows, cfg, docker.join().ok().flatten());
        settle(&rows, out, sink);
        settle(&unsettled(ctx, out), out, sink);
        if cancel.load(Ordering::Relaxed) {
            return Err(interrupted());
        }
        let leftover: Vec<String> = out
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .checking
            .iter()
            .cloned()
            .collect();
        unpend(leftover, out, sink);

        let out = out.lock().unwrap_or_else(PoisonError::into_inner);
        let mut scan = String::new();
        let mut reclaimable = 0;
        for r in &out.order {
            scan.push_str(&r.join("\t"));
            scan.push('\n');
            let fields: Vec<&str> = r.iter().map(String::as_str).collect();
            if let Some((_, item)) = review::parse_row(&fields)
                && !item.report
                && item.accuracy == "exact"
            {
                reclaimable += item.bytes;
            }
        }
        util::write_atomic(&run_dir.join("scan.tsv"), scan.as_bytes())?;
        let stats = platform::volume_stats(&mount);
        let (total, used, free) = stats
            .as_ref()
            .map(|s| (s.total, s.used, s.avail))
            .unwrap_or((0, 0, 0));
        util::write_atomic(
            &run_dir.join("disk.tsv"),
            format!(
                "total\t{total}\nused\t{used}\nfree\t{free}\nhome\t{home_bytes}\nsnapshots\t{snapshots}\ntoo_deep\t{too_deep}\n"
            )
            .as_bytes(),
        )?;
        eprintln!("  found {} items", out.order.len());
        emit(sink, started, "done", json!({"reclaimable": reclaimable}));
        Ok(())
    })
}

const GROWING_EVERY: Duration = Duration::from_secs(1);
const DOCKER_KEY: &str = "cmd:docker-prune";
pub(crate) const SIMS_KEY: &str = "cmd:xcode-unavailable-sims";

fn scan_dev_artifacts(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let list: Vec<PathBuf> = artifacts(ctx)
        .iter()
        .filter(|d| platform::is_build_output(d))
        .cloned()
        .collect();
    let desc = format!(
        "Virtualenvs and build output untouched for over {} days. node_modules has its own section below.",
        cfg.stale_days
    );
    let cat = Cat {
        id: "dev-artifacts",
        title: "Stale build artifacts",
        desc: &desc,
        risk: "safe",
        pre: "1",
    };
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Restored by re-running the project's install or build.",
        cfg.min_bytes,
    );
}

fn scan_node_modules(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let desc = format!(
        "Every node_modules folder on {}, whatever its age. Each one is fully rebuildable from its lockfile.",
        platform::THIS_COMPUTER
    );
    for p in &ctx.walk.node_modules {
        let Some(bytes) = size_bytes(ctx, p) else {
            continue;
        };
        if bytes < cfg.nm_min_bytes {
            continue;
        }
        let parent = p.parent().unwrap_or(Path::new("/"));
        let mut mgr = "npm";
        if parent.join("pnpm-lock.yaml").is_file() {
            mgr = "pnpm";
        }
        if parent.join("yarn.lock").is_file() {
            mgr = "yarn";
        }
        if parent.join("bun.lockb").is_file() || parent.join("bun.lock").is_file() {
            mgr = "bun";
        }
        let age = age_of(ctx, p);
        let pre = age.parse::<i64>().is_ok_and(|a| a > cfg.stale_days);
        let mut note =
            format!("{mgr} project, last installed {age} days ago. Restore with: {mgr} install");
        let mut measurement = "exact";
        if mgr == "pnpm" {
            measurement = "estimate";
            note.push_str(platform::PNPM_STORE_NOTE);
        }
        let (Some(s), Some(ps)) = (platform::path_text(p), platform::path_text(parent)) else {
            continue;
        };
        let (s, ps) = (s.as_str(), ps.as_str());
        let cat = Cat {
            id: "node-modules",
            title: "node_modules",
            desc: &desc,
            risk: "safe",
            pre: if pre { "1" } else { "0" },
        };
        rows.push(row(
            &cat,
            "rm",
            "-",
            &tilde(ps, &ctx.home),
            s,
            bytes,
            &note,
            &age,
            measurement,
        ));
    }
}

fn scan_docker(rows: &mut Vec<Row>, cfg: &Config, bytes: Option<u64>) {
    if let Some(bytes) = bytes.filter(|b| *b >= cfg.min_bytes) {
        rows.push(docker_row(bytes));
    }
}

fn docker_row(bytes: u64) -> Row {
    let cat = Cat {
        id: "docker",
        title: "Docker",
        desc: "Dangling images, stopped containers and build cache.",
        risk: "review",
        pre: "0",
    };
    row(
        &cat,
        "cmd",
        "docker-prune",
        "docker system prune -f",
        DOCKER_KEY,
        bytes,
        platform::DOCKER_NOTE,
        "-",
        "vm",
    )
}

fn scan_big_files(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let gb = 1_073_741_824u64;
    let desc = format!(
        "Files over {} GB, measured by space actually allocated on disk. Listed for awareness — never deleted by this skill.",
        cfg.bigfile_bytes / gb
    );
    let cat = Cat {
        id: "big-files",
        title: "Large files (report only)",
        desc: &desc,
        risk: "report",
        pre: "0",
    };
    for (f, apparent, blocks) in ctx.walk.big_files.iter().take(cfg.max_report_items) {
        let sz = blocks * 512;
        if sz < cfg.bigfile_bytes {
            continue;
        }
        let note = if *apparent > sz * 2 {
            format!(
                "Sparse file — {} GB apparent, {} GB actually on disk.",
                apparent / gb,
                sz / gb
            )
        } else {
            "Review manually.".to_string()
        };
        let Some(s) = platform::path_text(f) else {
            continue;
        };
        let s = s.as_str();
        rows.push(row(
            &cat,
            "rm",
            "-",
            &tilde(s, &ctx.home),
            s,
            sz,
            &note,
            &age_of(ctx, f),
            "exact",
        ));
    }
}

fn scan_old_downloads(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let list: Vec<PathBuf> = children_of(ctx, &platform::downloads_dir(&ctx.home))
        .into_iter()
        .filter(|p| {
            fs::symlink_metadata(p).is_ok_and(|m| {
                (ctx.now - platform::meta_of(&m).mtime) / 86400 > cfg.old_download_days
            })
        })
        .take(cfg.max_report_items)
        .collect();
    let desc = format!(
        "~/Downloads entries untouched for over {} days. Listed for awareness — never deleted by this skill.",
        cfg.old_download_days
    );
    let cat = Cat {
        id: "old-downloads",
        title: "Old downloads (report only)",
        desc: &desc,
        risk: "report",
        pre: "0",
    };
    sized(ctx, rows, &cat, &list, "Review manually.", cfg.min_bytes);
}
