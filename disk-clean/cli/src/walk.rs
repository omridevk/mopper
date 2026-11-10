use crate::insights::{self, Ins, Insights};
use crate::platform;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub enum Kind {
    #[default]
    Other,
    File,
    Dir,
    Symlink,
}

#[derive(Clone, Copy, Default, Debug)]
pub struct Meta {
    pub dev: u64,
    pub ino: u64,
    pub ino_hi: u64,
    pub nlink: u64,
    pub blocks: u64,
    pub size: u64,
    pub mtime: i64,
    pub kind: Kind,
}

#[derive(Default)]
pub struct Plan {
    pub home: PathBuf,
    pub map_depth: Option<usize>,
    pub map_min_kb: u64,
    pub nm_depth: usize,
    pub dev_depth: usize,
    pub big_depth: usize,
    pub repo_depth: usize,
    pub stale_days: i64,
    pub now: i64,
    pub big_bytes: u64,
    pub exact: HashSet<PathBuf>,
    pub parents: HashSet<PathBuf>,
    pub roots: Vec<PathBuf>,
    pub never: HashSet<PathBuf>,
    pub held: PathBuf,
    pub repo_tx: Option<std::sync::mpsc::Sender<PathBuf>>,
    pub days: Vec<i64>,
    pub cancel: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Walk {
    pub sizes: HashMap<PathBuf, u64>,
    pub children: HashMap<PathBuf, Vec<PathBuf>>,
    pub map: Vec<(PathBuf, u64, u64, i64)>,
    pub node_modules: Vec<PathBuf>,
    pub artifacts: Vec<PathBuf>,
    pub big_files: Vec<(PathBuf, u64, u64)>,
    pub insights: Insights,
    pub files: u64,
    pub bytes: u64,
    pub too_deep: u64,
}

pub type Open<'a> = (&'a Path, u64, u64, i64);

const DAY: i64 = 86_400;

fn plausible(mtime: i64, now: i64) -> i64 {
    if mtime > now + DAY { 0 } else { mtime }
}

const NM_TOP: &[&str] = &[
    "Applications",
    ".claude",
    ".nvm",
    ".volta",
    ".asdf",
    ".local",
    ".bun",
    ".npm",
    ".cache",
    ".cursor",
    ".vscode",
    ".codex",
    ".rustup",
    "Documents",
    "Desktop",
];
const DEV_TOP: &[&str] = &[
    "Applications",
    ".cargo",
    ".gradle",
    ".m2",
    ".npm",
    ".bun",
    ".nvm",
    ".volta",
    ".asdf",
    ".local",
    ".rbenv",
    ".pyenv",
    ".docker",
    ".orbstack",
];
const REPO_SKIP: &[&str] = &[
    "node_modules",
    ".cache",
    ".npm",
    ".nvm",
    ".cargo",
    ".rustup",
    ".local",
    ".docker",
    ".orbstack",
    "go",
    ".gradle",
    ".m2",
    "Applications",
];

#[derive(Clone, Copy)]
struct Home {
    depth: usize,
    nm: bool,
    dev: bool,
    big: bool,
    repo: bool,
    is_go: bool,
}

struct Frame {
    depth: usize,
    path: PathBuf,
    blocks: u64,
    files: u64,
    mtime: i64,
    track: bool,
    collect_children: bool,
    home: Option<Home>,
    ins: Option<Ins>,
}

struct Found {
    home: Option<Home>,
    node_modules: bool,
    artifact: bool,
    big_file: bool,
    repo: bool,
}

fn repo_step(repo_depth: usize, parent_depth: usize, name: Option<&str>) -> bool {
    let hidden_top =
        parent_depth == 0 && name.is_some_and(|n| n.starts_with('.') && n != ".claude");
    name.is_none_or(|n| {
        n != ".git" && !platform::HOME_SYSTEM_DIRS.contains(&n) && !REPO_SKIP.contains(&n)
    }) && parent_depth < repo_depth
        && !hidden_top
}

struct Scout {
    repos: Sender<PathBuf>,
    root: PathBuf,
    logical: PathBuf,
    home: PathBuf,
    repo_depth: usize,
}

fn scout_repo(scout: &Scout, dir: &Path, found: &[(OsString, Meta)]) {
    let has_git = found.iter().any(|(name, meta)| {
        name == ".git"
            && (meta.kind == Kind::Dir || (meta.kind == Kind::Symlink && dir.join(".git").is_dir()))
    });
    let Some(logical) = logical_of(scout, dir).filter(|_| has_git) else {
        return;
    };
    if reaches(scout, &logical) {
        let _ = scout.repos.send(logical);
    }
}

fn logical_of(scout: &Scout, dir: &Path) -> Option<PathBuf> {
    dir.strip_prefix(&scout.root)
        .ok()
        .map(|rest| scout.logical.join(rest))
}

fn reaches(scout: &Scout, logical: &Path) -> bool {
    logical.strip_prefix(&scout.home).is_ok_and(|rel| {
        rel.components()
            .enumerate()
            .all(|(depth, c)| repo_step(scout.repo_depth, depth, c.as_os_str().to_str()))
    })
}

fn scouted(reader: &Reader, dir: &Path) -> bool {
    let Some(scout) = &reader.scout else {
        return false;
    };
    logical_of(scout, dir)
        .is_some_and(|logical| scout.home.starts_with(&logical) || reaches(scout, &logical))
}

fn classify(plan: &Plan, parent: Option<&Frame>, name: Option<&str>, meta: &Meta) -> Found {
    let mut found = Found {
        home: None,
        node_modules: false,
        artifact: false,
        big_file: false,
        repo: false,
    };
    let Some(ph) = parent.and_then(|p| p.home) else {
        return found;
    };
    let is = |s: &str| name == Some(s);
    let any = |list: &[&str]| name.is_some_and(|n| list.contains(&n));
    let d = ph.depth + 1;
    if is(".git")
        && ph.repo
        && (meta.kind == Kind::Dir
            || (meta.kind == Kind::Symlink && parent.is_some_and(|p| p.path.join(".git").is_dir())))
    {
        found.repo = true;
    }
    if meta.kind != Kind::Dir {
        let pruned =
            (d == 1 && any(platform::HOME_SYSTEM_DIRS)) || is(".git") || is("node_modules");
        found.big_file = ph.big && !pruned && meta.kind == Kind::File && meta.size > plan.big_bytes;
        return found;
    }
    let nm_pruned = (d == 1 && (any(platform::HOME_SYSTEM_DIRS) || any(NM_TOP))) || is(".git");
    let is_nm = is("node_modules");
    found.node_modules = ph.nm && !nm_pruned && is_nm;
    let dev_pruned = (d == 1 && (any(platform::HOME_SYSTEM_DIRS) || any(DEV_TOP)))
        || (d == 2 && ph.is_go && is("pkg"))
        || is(".git");
    let dev_match = any(platform::DEV_NAMES);
    let stale = (plan.now - meta.mtime) / 86400 > plan.stale_days;
    found.artifact = ph.dev && !dev_pruned && dev_match && (stale || any(platform::ANY_AGE_NAMES));
    let big_pruned =
        (d == 1 && any(platform::HOME_SYSTEM_DIRS)) || is(".git") || is("node_modules");
    found.home = Some(Home {
        depth: d,
        nm: ph.nm && !nm_pruned && !is_nm && d < plan.nm_depth,
        dev: ph.dev && !dev_pruned && !dev_match && d < plan.dev_depth,
        big: ph.big && !big_pruned && d < plan.big_depth,
        repo: ph.repo && repo_step(plan.repo_depth, ph.depth, name),
        is_go: d == 1 && is("go"),
    });
    found
}

fn start(plan: &Plan) -> Home {
    Home {
        depth: 0,
        nm: plan.nm_depth >= 1,
        dev: plan.dev_depth >= 1,
        big: plan.big_depth >= 1,
        repo: true,
        is_go: false,
    }
}

fn pop(stack: &mut Vec<Frame>, plan: &Plan, out: &mut Walk, reached: &dyn Fn(&Walk)) -> u64 {
    let Some(f) = stack.pop() else { return 0 };
    if let Some(p) = stack.last_mut() {
        p.blocks += f.blocks;
        p.files += f.files;
        p.mtime = p.mtime.max(plausible(f.mtime, plan.now));
    }
    if f.track {
        out.sizes.insert(f.path.clone(), f.blocks);
    }
    if f.path != plan.home && (plan.exact.contains(&f.path) || plan.parents.contains(&f.path)) {
        reached(out);
    }
    if mapped(plan, f.depth, f.blocks) {
        out.map.push((f.path, f.blocks, f.files, f.mtime));
    }
    f.blocks
}

fn mapped(plan: &Plan, depth: usize, blocks: u64) -> bool {
    plan.map_depth.is_some() && (depth == 0 || blocks.div_ceil(2) >= plan.map_min_kb)
}

// Open folders with their size so far: their own blocks plus every open folder below them.
fn open_rows<'a>(stack: &'a [Frame], plan: &Plan) -> Vec<Open<'a>> {
    let mut below = (0, 0, 0);
    stack
        .iter()
        .rev()
        .filter_map(|f| {
            below = (below.0 + f.blocks, below.1 + f.files, below.2.max(f.mtime));
            mapped(plan, f.depth, below.0).then_some((f.path.as_path(), below.0, below.1, below.2))
        })
        .collect()
}

struct Entry {
    name: OsString,
    meta: Meta,
    next: Option<Next>,
}

enum Next {
    Read(PathBuf),
    Wait(Arc<Job>),
}

enum Slot {
    Queued(PathBuf),
    Reading,
    Read(Vec<Entry>),
}

struct Job {
    early: bool,
    key: Vec<u32>,
    slot: Mutex<Slot>,
    read: Condvar,
}

struct Soonest(Arc<Job>);

impl PartialEq for Soonest {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == std::cmp::Ordering::Equal
    }
}

impl Eq for Soonest {}

impl PartialOrd for Soonest {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Soonest {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0
            .early
            .cmp(&other.0.early)
            .then_with(|| other.0.key.cmp(&self.0.key))
    }
}

const READ_AHEAD: usize = 1 << 18;
const READERS_PER_CPU: usize = 4;

#[derive(Default)]
struct Queue {
    jobs: BinaryHeap<Soonest>,
    buffered: usize,
    done: bool,
}

#[derive(Default)]
struct Ahead {
    queue: Mutex<Queue>,
    ready: Condvar,
}

struct Stop<'a>(Option<&'a Ahead>);

impl Drop for Stop<'_> {
    fn drop(&mut self) {
        if let Some(ahead) = self.0 {
            lock(&ahead.queue).done = true;
            ahead.ready.notify_all();
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn claim(job: &Job) -> Option<PathBuf> {
    let mut slot = lock(&job.slot);
    match std::mem::replace(&mut *slot, Slot::Reading) {
        Slot::Queued(path) => Some(path),
        other => {
            *slot = other;
            None
        }
    }
}

struct Reader {
    dev: u64,
    pruned: HashSet<PathBuf>,
    ahead: Option<Ahead>,
    cancel: Arc<AtomicBool>,
    first: Vec<PathBuf>,
    scout: Option<Arc<Scout>>,
    too_deep: Arc<AtomicU64>,
}

fn read_listing(dir: &Path, reader: &Reader) -> Vec<(OsString, Option<Meta>)> {
    match platform::read_dir_bulk(dir) {
        Ok(listing) => listing,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::InvalidFilename {
                reader.too_deep.fetch_add(1, Ordering::Relaxed);
            }
            Vec::new()
        }
    }
}

fn list(dir: &Path, from: Option<&Job>, reader: &Reader) -> Vec<Entry> {
    if reader.cancel.load(Ordering::Relaxed) {
        return Vec::new();
    }
    let mut found: Vec<(OsString, Meta)> = read_listing(dir, reader)
        .into_iter()
        .filter_map(|(name, meta)| {
            let meta = meta.or_else(|| platform::meta_at(&dir.join(&name)))?;
            Some((name, meta))
        })
        .collect();
    let steps: Vec<&OsStr> = reader
        .first
        .iter()
        .filter(|target| target.as_os_str().len() > dir.as_os_str().len())
        .filter_map(|target| target.strip_prefix(dir).ok()?.components().next())
        .map(|step| step.as_os_str())
        .collect();
    if !steps.is_empty() {
        found.sort_by_key(|(name, _)| {
            steps
                .iter()
                .position(|step| step == name)
                .unwrap_or(usize::MAX)
        });
    }
    if let Some(scout) = &reader.scout {
        scout_repo(scout, dir, &found);
    }
    let mut queued = Vec::new();
    let entries = found
        .into_iter()
        .enumerate()
        .map(|(i, (name, meta))| {
            let next = (meta.kind == Kind::Dir && meta.dev == reader.dev)
                .then(|| dir.join(&name))
                .filter(|path| !reader.pruned.contains(path))
                .map(|path| descend(path, from, i, reader, &mut queued));
            Entry { name, meta, next }
        })
        .collect();
    enqueue(reader, queued);
    entries
}

fn descend(
    path: PathBuf,
    parent: Option<&Job>,
    index: usize,
    reader: &Reader,
    queued: &mut Vec<Arc<Job>>,
) -> Next {
    if reader.ahead.is_none() {
        return Next::Read(path);
    }
    let parent_key = parent.map_or(&[][..], |p| &p.key);
    let mut key = Vec::with_capacity(parent_key.len() + 1);
    key.extend_from_slice(parent_key);
    key.push(u32::try_from(index).unwrap_or(u32::MAX));
    let early = parent.is_none_or(|p| p.early) && scouted(reader, &path);
    let job = Arc::new(Job {
        early,
        key,
        slot: Mutex::new(Slot::Queued(path)),
        read: Condvar::new(),
    });
    queued.push(Arc::clone(&job));
    Next::Wait(job)
}

fn enqueue(reader: &Reader, queued: Vec<Arc<Job>>) {
    let Some(ahead) = reader.ahead.as_ref().filter(|_| !queued.is_empty()) else {
        return;
    };
    lock(&ahead.queue)
        .jobs
        .extend(queued.into_iter().map(Soonest));
    ahead.ready.notify_all();
}

fn next_job(ahead: &Ahead) -> Option<Arc<Job>> {
    let mut queue = lock(&ahead.queue);
    loop {
        if queue.done {
            return None;
        }
        let open = queue.buffered < READ_AHEAD;
        if queue.jobs.peek().is_some_and(|j| open || j.0.early)
            && let Some(Soonest(job)) = queue.jobs.pop()
        {
            return Some(job);
        }
        queue = ahead
            .ready
            .wait(queue)
            .unwrap_or_else(PoisonError::into_inner);
    }
}

fn read_ahead(reader: &Reader) {
    let Some(ahead) = &reader.ahead else { return };
    while let Some(job) = next_job(ahead) {
        let Some(path) = claim(&job) else { continue };
        let entries = list(&path, Some(&job), reader);
        if !job.early {
            lock(&ahead.queue).buffered += entries.len();
        }
        *lock(&job.slot) = Slot::Read(entries);
        job.read.notify_one();
    }
}

fn consumed(reader: &Reader, job: &Job, entries: &[Entry]) {
    let Some(ahead) = reader.ahead.as_ref().filter(|_| !job.early) else {
        return;
    };
    let mut queue = lock(&ahead.queue);
    let full = queue.buffered >= READ_AHEAD;
    queue.buffered = queue.buffered.saturating_sub(entries.len());
    if full && queue.buffered < READ_AHEAD {
        ahead.ready.notify_all();
    }
}

fn open(next: Next, reader: &Reader) -> Vec<Entry> {
    let job = match next {
        Next::Read(path) => return list(&path, None, reader),
        Next::Wait(job) => job,
    };
    if let Some(path) = claim(&job) {
        return list(&path, Some(&job), reader);
    }
    let slot = lock(&job.slot);
    let mut slot = job
        .read
        .wait_while(slot, |s| matches!(s, Slot::Reading))
        .unwrap_or_else(PoisonError::into_inner);
    match std::mem::replace(&mut *slot, Slot::Reading) {
        Slot::Read(entries) => {
            consumed(reader, &job, &entries);
            entries
        }
        _ => Vec::new(),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn walk(
    root: &Path,
    logical: &Path,
    plan: &Plan,
    parallel: bool,
    seen: &mut HashSet<(u64, u64, u64)>,
    out: &mut Walk,
    progress: &dyn Fn(&Walk, &Path, &[Open]),
    reached: &dyn Fn(&Walk),
) -> Option<u64> {
    let root_meta = platform::meta_at(root)?;
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()) * READERS_PER_CPU;
    let reader = Reader {
        dev: root_meta.dev,
        pruned: if plan.map_depth.is_none() {
            plan.never.clone()
        } else {
            HashSet::new()
        },
        ahead: parallel.then(Ahead::default),
        cancel: Arc::clone(&plan.cancel),
        first: std::iter::once(&plan.home)
            .chain(&plan.exact)
            .chain(&plan.parents)
            .filter_map(|path| path.strip_prefix(logical).ok())
            .map(|rest| root.join(rest))
            .collect(),
        scout: plan.repo_tx.clone().map(|repos| {
            Arc::new(Scout {
                repos,
                root: root.to_path_buf(),
                logical: logical.to_path_buf(),
                home: plan.home.clone(),
                repo_depth: plan.repo_depth,
            })
        }),
        too_deep: Arc::default(),
    };
    std::thread::scope(|s| {
        let _stop = Stop(reader.ahead.as_ref());
        if reader.ahead.is_some() {
            for _ in 0..threads {
                s.spawn(|| read_ahead(&reader));
            }
        }
        let mut queued = Vec::new();
        let next = (root_meta.kind == Kind::Dir)
            .then(|| descend(root.to_path_buf(), None, 0, &reader, &mut queued));
        enqueue(&reader, queued);
        let root_entry = Entry {
            name: root.file_name().unwrap_or(OsStr::new("/")).to_os_string(),
            meta: root_meta,
            next,
        };
        let total = consume(
            root_entry, logical, plan, &reader, seen, out, progress, reached,
        );
        out.too_deep += reader.too_deep.load(Ordering::Relaxed);
        total
    })
}

#[allow(clippy::too_many_arguments)]
fn consume(
    root_entry: Entry,
    logical: &Path,
    plan: &Plan,
    reader: &Reader,
    seen: &mut HashSet<(u64, u64, u64)>,
    out: &mut Walk,
    progress: &dyn Fn(&Walk, &Path, &[Open]),
    reached: &dyn Fn(&Walk),
) -> Option<u64> {
    let mut pending: Vec<(usize, std::vec::IntoIter<Entry>)> =
        vec![(0, vec![root_entry].into_iter())];

    let mut stack: Vec<Frame> = Vec::new();
    let mut total = None;
    let mut visited = 0u64;
    while let Some((depth, entries)) = pending.last_mut() {
        let depth = *depth;
        let Some(entry) = entries.next() else {
            pending.pop();
            continue;
        };
        if let Some(next) = entry.next {
            pending.push((depth + 1, open(next, reader).into_iter()));
        }
        visited += 1;
        if visited.is_multiple_of(4096) {
            if plan.cancel.load(Ordering::Relaxed) {
                return None;
            }
            if let Some(dir) = stack.last() {
                progress(out, &dir.path, &open_rows(&stack, plan));
            }
        }
        let meta = entry.meta;
        let file_name = entry.name;
        while stack.last().is_some_and(|f| f.depth >= depth) {
            let blocks = pop(&mut stack, plan, out, reached);
            if stack.is_empty() {
                total = Some(blocks);
            }
        }
        if depth > 0 && stack.is_empty() {
            continue;
        }
        let counted = meta.kind == Kind::Dir
            || meta.nlink <= 1
            || seen.insert((meta.dev, meta.ino, meta.ino_hi));
        let own = if counted { meta.blocks } else { 0 };
        out.files += u64::from(meta.kind == Kind::File);
        out.bytes += own * 512;
        let name = file_name.to_str();
        let parent = stack.last();
        let found = classify(plan, parent, name, &meta);
        let path_of = |p: Option<&Frame>| match p {
            Some(p) => p.path.join(&file_name),
            None => logical.to_path_buf(),
        };
        let child_of_interest = parent.is_some_and(|p| p.collect_children);
        if name == Some(".git")
            && let Some(p) = stack.last_mut()
        {
            p.track = true;
        }
        let parent = stack.last();
        if found.repo
            && let (Some(p), Some(tx)) = (parent, &plan.repo_tx)
        {
            let _ = tx.send(p.path.clone());
        }

        if meta.kind == Kind::Dir {
            let path = path_of(parent);
            let mut home = found
                .home
                .filter(|_| path != plan.held && !plan.never.contains(&path));
            let mut ins = parent.and_then(|p| {
                p.ins
                    .map(|i| insights::enter(&mut out.insights, i, &p.path, &file_name))
            });
            if path == plan.home {
                ins = insights::start(&mut out.insights);
                home = Some(start(plan));
            } else if depth == 0 && plan.roots.contains(&path) {
                home = Some(start(plan));
            }
            let collect_children = plan.parents.contains(&path);
            if collect_children {
                out.children.entry(path.clone()).or_default();
            }
            if child_of_interest && let Some(p) = parent {
                out.children
                    .entry(p.path.clone())
                    .or_default()
                    .push(path.clone());
            }
            if found.node_modules {
                out.node_modules.push(path.clone());
            }
            if found.artifact {
                out.artifacts.push(path.clone());
            }
            let track = depth == 0
                || child_of_interest
                || found.node_modules
                || found.artifact
                || plan.map_depth.is_some_and(|m| depth <= m)
                || plan.exact.contains(&path);
            stack.push(Frame {
                depth,
                path,
                blocks: own,
                files: 0,
                mtime: plausible(meta.mtime, plan.now),
                track,
                collect_children,
                home,
                ins,
            });
            continue;
        }

        if depth == 0 {
            out.sizes.insert(logical.to_path_buf(), own);
            return Some(own);
        }
        let needs_path = child_of_interest || found.big_file || meta.kind == Kind::Symlink;
        if needs_path {
            let path = path_of(parent);
            if child_of_interest || plan.exact.contains(&path) {
                out.sizes.insert(path.clone(), own);
            }
            if child_of_interest && let Some(p) = parent {
                out.children
                    .entry(p.path.clone())
                    .or_default()
                    .push(path.clone());
            }
            if found.big_file && !plan.never.contains(&path) {
                out.big_files.push((path, meta.size, meta.blocks));
            }
        }
        if meta.kind == Kind::File
            && counted
            && let Some(p) = parent
            && let Some(i) = p.ins
        {
            let path = || p.path.join(&file_name);
            insights::add(
                &mut out.insights,
                i,
                &plan.days,
                plan.now,
                &file_name,
                &meta,
                path,
            );
        }
        if let Some(p) = stack.last_mut() {
            p.blocks += own;
            p.files += u64::from(meta.kind == Kind::File);
            p.mtime = p.mtime.max(plausible(meta.mtime, plan.now));
        }
    }
    while !stack.is_empty() {
        let blocks = pop(&mut stack, plan, out, reached);
        if stack.is_empty() {
            total = Some(blocks);
        }
    }
    total
}

pub fn size_of(path: &Path) -> Option<u64> {
    size_with(path, false)
}

pub fn size_with(path: &Path, parallel: bool) -> Option<u64> {
    walk(
        path,
        path,
        &Plan::default(),
        parallel,
        &mut HashSet::new(),
        &mut Walk::default(),
        &|_, _, _| {},
        &|_| {},
    )
}
