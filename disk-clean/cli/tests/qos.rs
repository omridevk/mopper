#![cfg(unix)]

mod common;

use disk_clean::scan::{self, Sink};
use serde_json::Value;
use std::fs;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::thread::ThreadId;

#[cfg(target_os = "macos")]
fn qos() -> u32 {
    let mut class = libc::qos_class_t::QOS_CLASS_UNSPECIFIED;
    let mut relative = 0;
    // SAFETY: pthread_get_qos_class_np writes only into the two locals passed to it.
    unsafe { libc::pthread_get_qos_class_np(libc::pthread_self(), &mut class, &mut relative) };
    class as u32
}

#[cfg(target_os = "macos")]
struct Threads(Mutex<Vec<(ThreadId, u32)>>);

#[cfg(target_os = "macos")]
impl Sink for Threads {
    fn emit(&self, _: &str, _: Value) {
        let mut seen = self.0.lock().unwrap();
        seen.push((std::thread::current().id(), qos()));
    }
}

#[cfg(target_os = "macos")]
#[test]
fn the_walk_and_the_worktree_checks_run_at_default_qos() {
    let t = common::temp_dir("scan-qos");
    let home = t.0.join("home");
    fs::create_dir_all(home.join("code")).unwrap();
    common::sh(
        &home.join("code"),
        "git init -q app && cd app && git commit -q --allow-empty -m x && git worktree add -q ../app-wt",
    );
    let run = t.0.join("run");
    fs::create_dir_all(&run).unwrap();
    // SAFETY: this test binary holds this one test, so no other thread reads the environment.
    unsafe {
        std::env::set_var("HOME", &home);
        std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        std::env::set_var("DISK_CLEAN_SKIP_MAP", "1");
        std::env::set_var("DISK_CLEAN_MIN_BYTES", "1");
    }
    let utility = libc::qos_class_t::QOS_CLASS_UTILITY as u32;
    assert_ne!(
        qos(),
        utility,
        "the test thread starts at its default class"
    );
    let sink = Threads(Mutex::new(Vec::new()));
    let scanner = std::thread::scope(|s| {
        let scanner =
            s.spawn(|| scan::scan(&run, &sink, Arc::new(AtomicBool::new(false))).unwrap());
        let id = scanner.thread().id();
        scanner.join().unwrap();
        id
    });
    let seen = sink.0.into_inner().unwrap();
    let (walk, checks): (Vec<_>, Vec<_>) = seen.iter().partition(|(id, _)| *id == scanner);
    assert!(!walk.is_empty(), "the scan thread reported: {seen:?}");
    assert!(!checks.is_empty(), "the worktree checks reported: {seen:?}");
    assert!(walk.iter().all(|(_, class)| *class != utility), "{seen:?}");
    assert!(
        checks.iter().any(|(_, class)| *class != utility),
        "{seen:?}"
    );
}

#[cfg(target_os = "linux")]
fn nice() -> i32 {
    // SAFETY: gettid has no preconditions and cannot fail.
    let tid = unsafe { libc::gettid() };
    // SAFETY: getpriority only reads the scheduling priority of the given thread.
    unsafe { libc::getpriority(libc::PRIO_PROCESS, tid as libc::id_t) }
}

#[cfg(target_os = "linux")]
struct Niceness(Mutex<Vec<(ThreadId, i32)>>);

#[cfg(target_os = "linux")]
impl Sink for Niceness {
    fn emit(&self, _: &str, _: Value) {
        let mut seen = self.0.lock().unwrap();
        seen.push((std::thread::current().id(), nice()));
    }
}

#[cfg(target_os = "linux")]
#[test]
fn the_walk_and_the_worktree_checks_keep_their_priority() {
    let t = common::temp_dir("scan-nice");
    let home = t.0.join("home");
    fs::create_dir_all(home.join("code")).unwrap();
    common::sh(
        &home.join("code"),
        "git init -q app && cd app && git commit -q --allow-empty -m x && git worktree add -q ../app-wt",
    );
    let run = t.0.join("run");
    fs::create_dir_all(&run).unwrap();
    // SAFETY: this test binary holds this one test, so no other thread reads the environment.
    unsafe {
        std::env::set_var("HOME", &home);
        std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        std::env::set_var("DISK_CLEAN_SKIP_MAP", "1");
        std::env::set_var("DISK_CLEAN_MIN_BYTES", "1");
        std::env::remove_var("XDG_CACHE_HOME");
        std::env::remove_var("XDG_CONFIG_HOME");
        std::env::remove_var("XDG_DATA_HOME");
    }
    let start = nice();
    let sink = Niceness(Mutex::new(Vec::new()));
    let scanner = std::thread::scope(|s| {
        let scanner =
            s.spawn(|| scan::scan(&run, &sink, Arc::new(AtomicBool::new(false))).unwrap());
        let id = scanner.thread().id();
        scanner.join().unwrap();
        id
    });
    assert_eq!(nice(), start, "the test thread keeps its priority");
    let seen = sink.0.into_inner().unwrap();
    let (walk, checks): (Vec<_>, Vec<_>) = seen.iter().partition(|(id, _)| *id == scanner);
    assert!(!walk.is_empty(), "the scan thread reported: {seen:?}");
    assert!(!checks.is_empty(), "the worktree checks reported: {seen:?}");
    assert!(walk.iter().all(|(_, n)| *n == start), "{seen:?}");
    assert!(checks.iter().any(|(_, n)| *n == start), "{seen:?}");
}
