pub use crate::platform::{data_mount, volume_stats};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Mutex, OnceLock, PoisonError};

static HOME: OnceLock<Result<String, String>> = OnceLock::new();

fn resolve_home(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Err("HOME is empty".to_string());
    }
    if !Path::new(raw).is_absolute() {
        return Err(format!("HOME is not an absolute path: {raw}"));
    }
    let real = fs::canonicalize(raw).map_err(|e| format!("HOME {raw} cannot be resolved: {e}"))?;
    match crate::platform::path_text(&real) {
        Some(s) if real.is_dir() && !is_root(&s) => Ok(s),
        _ => Err(format!("HOME {raw} is not a usable home folder")),
    }
}

pub fn shown(p: &Path) -> String {
    crate::platform::path_text(p).unwrap_or_else(|| p.display().to_string())
}

pub fn is_root(p: &str) -> bool {
    crate::platform::split_root(p).is_some_and(|(_, rest)| rest.is_empty())
}

pub fn checked_home() -> Result<String, String> {
    HOME.get_or_init(|| resolve_home(&crate::platform::raw_home()))
        .clone()
}

pub fn home() -> String {
    checked_home().unwrap_or_default()
}

pub fn env_num<T: std::str::FromStr>(name: &str, default: T) -> T {
    match std::env::var(name) {
        Ok(v) if !v.is_empty() => v.trim().parse().unwrap_or(default),
        _ => default,
    }
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn now_f64() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

pub fn free_bytes() -> u64 {
    crate::platform::volume_stats(&crate::platform::data_mount())
        .map(|s| s.avail)
        .unwrap_or(0)
}

static OPENING_INHERITABLE_FDS: Mutex<()> = Mutex::new(());

pub fn with_fd_lock<T>(open: impl FnOnce() -> T) -> T {
    let _alone = OPENING_INHERITABLE_FDS
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    open()
}

pub fn spawn(cmd: &mut Command) -> io::Result<Child> {
    with_fd_lock(|| cmd.spawn())
}

pub fn captured(cmd: &mut Command) -> io::Result<Output> {
    spawn(cmd.stdout(Stdio::piped()))?.wait_with_output()
}

pub fn output(program: &str, args: &[&str]) -> Option<(bool, String)> {
    let out = captured(
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null()),
    )
    .ok()?;
    Some((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
    ))
}

pub fn tilde(path: &str, home: &str) -> String {
    match path.strip_prefix(home) {
        Some(rest) if !home.is_empty() => format!("~{rest}"),
        _ => path.to_string(),
    }
}

pub fn realpath(path: &Path) -> PathBuf {
    if let Ok(p) = fs::canonicalize(path) {
        return p;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) if !parent.as_os_str().is_empty() => realpath(parent).join(name),
        _ => path.to_path_buf(),
    }
}

pub fn read_lines(path: &Path) -> Vec<String> {
    fs::read(path)
        .map(|b| {
            String::from_utf8_lossy(&b)
                .lines()
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub fn complete_lines(path: &Path) -> Vec<String> {
    let bytes = fs::read(path).unwrap_or_default();
    let end = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    String::from_utf8_lossy(&bytes[..end])
        .lines()
        .map(str::to_string)
        .collect()
}

pub fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let staged = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    fs::write(&staged, contents)?;
    fs::rename(&staged, path)
}

pub fn in_parallel<T: Sync>(items: &[T], workers: usize, each: impl Fn(&T) + Sync) {
    let next = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|s| {
        for _ in 0..workers.max(1) {
            s.spawn(|| {
                while let Some(item) =
                    items.get(next.fetch_add(1, std::sync::atomic::Ordering::SeqCst))
                {
                    each(item);
                }
            });
        }
    });
}
