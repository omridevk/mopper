mod common;

use disk_clean::walk;
use std::collections::HashSet;
use std::fs;
#[cfg(unix)]
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;
#[cfg(unix)]
use std::process::Command;

#[cfg(unix)]
fn du_kb(path: &Path) -> u64 {
    let out = common::output(Command::new("du").arg("-sk").arg(path));
    let text = String::from_utf8(out.stdout).unwrap();
    text.split_whitespace().next().unwrap().parse().unwrap()
}

#[cfg(unix)]
fn walk_kb(path: &Path) -> u64 {
    walk::size_of(path).unwrap().div_ceil(2)
}

#[cfg(unix)]
#[test]
fn walk_totals_match_du() {
    let t = common::temp_dir("sizes");
    let root = t.0.join("tree");
    fs::create_dir_all(root.join("a/b/c")).unwrap();
    fs::create_dir_all(root.join("links")).unwrap();
    for (i, size) in [1usize, 4095, 4096, 4097, 100_000, 3_000_000]
        .iter()
        .enumerate()
    {
        fs::write(root.join(format!("a/f{i}")), vec![7u8; *size]).unwrap();
        fs::write(root.join(format!("a/b/c/g{i}")), vec![3u8; size * 2]).unwrap();
    }
    fs::hard_link(root.join("a/f5"), root.join("links/same-as-f5")).unwrap();
    fs::hard_link(root.join("a/b/c/g5"), root.join("a/b/c/g5-again")).unwrap();
    let mut sparse = fs::File::create(root.join("links/sparse")).unwrap();
    sparse.seek(SeekFrom::Start(512 * 1024 * 1024)).unwrap();
    sparse.write_all(b"x").unwrap();
    drop(sparse);
    std::os::unix::fs::symlink(root.join("a"), root.join("links/to-a")).unwrap();

    assert!(fs::metadata(root.join("links/sparse")).unwrap().len() > 500 * 1024 * 1024);
    for p in [
        root.clone(),
        root.join("a"),
        root.join("a/b"),
        root.join("links"),
    ] {
        assert_eq!(walk_kb(&p), du_kb(&p), "size of {}", p.display());
    }
    let sparse = root.join("links/sparse");
    assert_eq!(walk_kb(&sparse), du_kb(&sparse));
    assert!(walk_kb(&sparse) < 1024, "sparse file counted by allocation");
}

#[cfg(unix)]
#[test]
fn map_dirs_carry_file_count_and_newest_mtime() {
    let t = common::temp_dir("map-stats");
    let root = t.0.join("tree");
    fs::create_dir_all(root.join("a/b")).unwrap();
    let stamp = |path: &Path, secs: u64| {
        let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs);
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(when)
            .unwrap();
    };
    for (name, secs) in [("a/one", 1_000), ("a/b/two", 3_000), ("a/b/three", 2_000)] {
        fs::write(root.join(name), b"x").unwrap();
        stamp(&root.join(name), secs);
    }
    for dir in ["a/b", "a", ""] {
        let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(500);
        fs::File::open(root.join(dir))
            .unwrap()
            .set_modified(when)
            .unwrap();
    }
    let plan = walk::Plan {
        map_depth: Some(2),
        ..walk::Plan::default()
    };
    let mut out = walk::Walk::default();
    walk::walk(
        &root,
        &root,
        &plan,
        false,
        &mut HashSet::new(),
        &mut out,
        &|_, _, _| {},
    );
    let stat = |p: &Path| {
        out.map
            .iter()
            .find(|(path, ..)| path == p)
            .map(|(_, _, files, mtime)| (*files, *mtime))
            .unwrap_or_else(|| panic!("{} not in map", p.display()))
    };
    assert_eq!(stat(&root.join("a/b")), (2, 3_000));
    assert_eq!(stat(&root.join("a")), (3, 3_000));
    assert_eq!(stat(&root), (3, 3_000));
}

fn fixture(root: &Path) {
    for p in 0..24 {
        let project = root.join(format!("p{p}"));
        for d in ["src/a/b", "node_modules/dep/lib", "target/debug", "cache/c"] {
            fs::create_dir_all(project.join(d)).unwrap();
        }
        fs::create_dir_all(project.join(".git/objects")).unwrap();
        for (i, d) in [
            "",
            "src",
            "src/a/b",
            "node_modules/dep/lib",
            "target/debug",
            "cache/c",
        ]
        .iter()
        .enumerate()
        {
            for f in 0..6 {
                let bytes = vec![b'x'; 1 + (p * 7919 + i * 131 + f * 4099) % 20_000];
                fs::write(project.join(d).join(format!("f{f}.rs")), bytes).unwrap();
            }
        }
        fs::write(project.join("Cargo.toml"), b"[package]").unwrap();
        fs::hard_link(project.join("f0.rs"), project.join("src/linked.rs")).unwrap();
    }
}

fn fixture_plan(root: &Path, now: i64, map_min_kb: u64) -> walk::Plan {
    walk::Plan {
        home: root.to_path_buf(),
        map_depth: Some(3),
        map_min_kb,
        nm_depth: 9,
        dev_depth: 7,
        big_depth: 6,
        repo_depth: 6,
        stale_days: -1,
        now,
        big_bytes: 16_000,
        exact: [root.join("p3/src")].into_iter().collect(),
        parents: [root.join("p5/cache")].into_iter().collect(),
        days: disk_clean::insights::midnights(now),
        ..walk::Plan::default()
    }
}

fn walked(root: &Path, plan: walk::Plan, parallel: bool) -> (walk::Walk, Option<u64>, Vec<String>) {
    let (repo_tx, repo_rx) = std::sync::mpsc::channel();
    let plan = walk::Plan {
        repo_tx: Some(repo_tx),
        ..plan
    };
    let mut out = walk::Walk::default();
    let total = walk::walk(
        root,
        root,
        &plan,
        parallel,
        &mut HashSet::new(),
        &mut out,
        &|_, _, _| {},
    );
    drop(plan);
    let mut repos: Vec<String> = repo_rx
        .into_iter()
        .map(|p| p.display().to_string())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    repos.sort();
    (out, total, repos)
}

#[test]
fn bounded_parallel_walk_matches_the_serial_walk() {
    let t = common::temp_dir("walk-agree");
    let root = t.0.join("tree");
    fixture(&root);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let (serial, serial_total, serial_repos) = walked(&root, fixture_plan(&root, now, 0), false);
    let (parallel, parallel_total, parallel_repos) =
        walked(&root, fixture_plan(&root, now, 0), true);
    assert_eq!(parallel_total, serial_total);
    assert_eq!(parallel.files, serial.files);
    assert_eq!(parallel.bytes, serial.bytes);
    assert_eq!(parallel.map, serial.map);
    assert_eq!(parallel.sizes, serial.sizes);
    assert_eq!(parallel.children, serial.children);
    assert_eq!(parallel.node_modules, serial.node_modules);
    assert_eq!(parallel.artifacts, serial.artifacts);
    assert_eq!(parallel.big_files, serial.big_files);
    assert_eq!(parallel_repos, serial_repos);
    assert_eq!(parallel_repos.len(), 24);
    assert_eq!(serial.node_modules.len(), 24);
    assert_eq!(serial.artifacts.len(), 24);
    let home = root.display().to_string();
    let days = disk_clean::insights::midnights(now);
    assert_eq!(
        disk_clean::insights::to_json(&parallel.insights, &days, now, &home),
        disk_clean::insights::to_json(&serial.insights, &days, now, &home)
    );
}

#[test]
fn map_keeps_only_directories_at_or_above_the_threshold() {
    let t = common::temp_dir("map-threshold");
    let root = t.0.join("tree");
    fixture(&root);
    fs::write(root.join("p7/src/a/big.bin"), vec![b'y'; 1200 * 1024]).unwrap();
    let (all, ..) = walked(&root, fixture_plan(&root, 0, 0), true);
    let (kept, ..) = walked(&root, fixture_plan(&root, 0, 1000), true);
    let expected: Vec<_> = all
        .map
        .iter()
        .filter(|(p, blocks, ..)| p == &root || blocks.div_ceil(2) >= 1000)
        .cloned()
        .collect();
    assert_eq!(kept.map, expected);
    let paths: Vec<_> = kept.map.iter().map(|(p, ..)| p.clone()).collect();
    assert!(paths.contains(&root.join("p7/src")), "{paths:?}");
    assert!(paths.contains(&root.join("p7")), "{paths:?}");
    assert!(!paths.contains(&root.join("p6")), "{paths:?}");
    assert!(
        all.map.len() > 4 * kept.map.len(),
        "{} vs {}",
        all.map.len(),
        kept.map.len()
    );
}

type Rows = Vec<(String, u64, u64, i64)>;

fn rows_of<'a>(map: impl IntoIterator<Item = walk::Open<'a>>) -> Rows {
    map.into_iter()
        .map(|(p, b, f, m)| (p.display().to_string(), b, f, m))
        .collect()
}

fn count(node: &disk_clean::review::Node) -> usize {
    1 + node
        .children
        .iter()
        .filter(|c| !c.rest)
        .map(count)
        .sum::<usize>()
}

#[test]
fn growing_snapshots_are_connected_and_only_grow() {
    let t = common::temp_dir("walk-growing");
    let root = t.0.join("tree");
    for i in 0..30 {
        for j in 0..10 {
            let dir = root.join(format!("t{i}/s{j}"));
            fs::create_dir_all(&dir).unwrap();
            for f in 0..40 {
                fs::write(dir.join(format!("f{f}")), b"x").unwrap();
            }
            if (i + j) % 3 == 0 {
                fs::write(dir.join("big"), vec![b'y'; 300 * 1024]).unwrap();
            }
        }
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let days = disk_clean::insights::midnights(now);
    let home = root.display().to_string();
    let plan = walk::Plan {
        home: root.clone(),
        map_depth: Some(3),
        map_min_kb: 200,
        now,
        days: days.clone(),
        ..walk::Plan::default()
    };
    let snapshots: std::cell::RefCell<Vec<(Rows, Rows)>> = Default::default();
    let mut out = walk::Walk::default();
    walk::walk(
        &root,
        &root,
        &plan,
        false,
        &mut HashSet::new(),
        &mut out,
        &|w, _, open| {
            let json = disk_clean::insights::to_json(&w.insights, &days, now, &home);
            assert_eq!(
                json,
                disk_clean::insights::to_json(&w.insights, &days, now, &home)
            );
            let finished = rows_of(w.map.iter().map(|(p, b, f, m)| (p.as_path(), *b, *f, *m)));
            snapshots
                .borrow_mut()
                .push((finished, rows_of(open.iter().copied())));
        },
    );
    let snapshots = snapshots.into_inner();
    assert!(snapshots.len() >= 2, "{} snapshots", snapshots.len());
    let last: Rows = rows_of(out.map.iter().map(|(p, b, f, m)| (p.as_path(), *b, *f, *m)));
    let size_in = |rows: &Rows, p: &str| rows.iter().find(|r| r.0 == p).map(|r| r.1);
    let mut before: Rows = Vec::new();
    for (finished, open) in &snapshots {
        for row in finished {
            assert!(last.contains(row), "{} changed after it finished", row.0);
        }
        let rows: Rows = finished.iter().chain(open).cloned().collect();
        for (p, blocks, ..) in &rows {
            assert!(size_in(&last, p).is_some_and(|end| end >= *blocks), "{p}");
            assert!(
                size_in(&before, p).is_none_or(|was| was <= *blocks),
                "{p} shrank"
            );
        }
        let tree = disk_clean::review::map_tree(
            rows.iter()
                .map(|(p, b, f, m)| (*b as i64 * 512, *f as i64, *m, p.clone()))
                .collect(),
            &home,
            0,
        )
        .unwrap();
        assert_eq!(count(&tree), rows.len());
        before = rows;
    }
    assert!(last.len() < 1 + 30 + 300, "the cutoff kept every folder");
    let json = disk_clean::insights::to_json(&out.insights, &days, now, &home);
    assert_eq!(
        json,
        disk_clean::insights::to_json(&out.insights, &days, now, &home)
    );
}
