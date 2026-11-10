mod common;

use disk_clean::scan::parse_docker_bytes;
use disk_clean::walk;
use std::collections::HashSet;
use std::fs;
use std::path::Path;

#[test]
fn docker_reclaimable_parsing() {
    let cases = [
        ("1.2GB (40%)", (1.2f64 * 1073741824.0) as u64),
        ("512MB", 512 * 1048576),
        ("3.5 GB", (3.5f64 * 1073741824.0) as u64),
        ("0B (0%)", 0),
        ("120B", 120),
        ("12.5kB", 0),
        ("2TB", 2 * 1099511627776),
        ("", 0),
        ("n/a", 0),
        ("1.2.3GB", 0),
    ];
    for (input, want) in cases {
        assert_eq!(parse_docker_bytes(input), want, "{input:?}");
    }
}

fn scan(home: &Path, run: &Path) -> String {
    let out = common::cli(
        &[
            "scan",
            "--drives",
            &common::drives_arg(home),
            &common::text(run),
        ],
        home,
        &[
            ("DISK_CLEAN_SKIP_MAP", "1"),
            ("DISK_CLEAN_MIN_BYTES", "1"),
            ("DISK_CLEAN_NM_MIN_BYTES", "1"),
        ],
    );
    let err = String::from_utf8_lossy(&out.stderr).into_owned();
    assert!(out.status.success(), "{err}");
    err
}

#[cfg(unix)]
#[test]
fn a_symlinked_home_is_scanned_through_its_real_path() {
    let t = common::temp_dir("scan-homelink");
    let real = t.0.join("real-home");
    let nm = real.join("code/app/node_modules/pkg");
    fs::create_dir_all(&nm).unwrap();
    fs::write(nm.join("index.js"), vec![1u8; 8192]).unwrap();
    let link = t.0.join("home-link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let run = t.0.join("run");
    let err = scan(&link, &run);
    assert!(
        err.contains(&format!("resolves to {}", real.display())),
        "{err}"
    );
    let rows = fs::read_to_string(run.join("scan.tsv")).unwrap();
    let wanted = format!("\t{}\t", real.join("code/app/node_modules").display());
    assert!(rows.contains(&wanted), "{rows}");
}

#[cfg(unix)]
#[test]
fn folders_nested_too_deep_to_read_are_reported() {
    let t = common::temp_dir("scan-deep");
    let home = t.0.join("home");
    fs::create_dir_all(home.join("deep")).unwrap();
    common::sh(
        &home.join("deep"),
        &format!(
            "n=$(printf 'd%.0s' $(seq 1 120)); for i in $(seq 1 {}); do mkdir \"$n\"; cd \"$n\"; done; echo hi >f",
            common::levels_past_path_max()
        ),
    );
    let run = t.0.join("run");
    let err = scan(&home, &run);
    assert!(err.contains("nested too deep to read"), "{err}");
    let facts = fs::read_to_string(run.join("disk.tsv")).unwrap();
    let skipped: u64 = facts
        .lines()
        .find_map(|l| l.strip_prefix("too_deep\t"))
        .expect("too_deep in disk.tsv")
        .parse()
        .unwrap();
    assert!(skipped >= 1, "{facts}");
}

#[test]
fn a_future_mtime_never_becomes_the_newest_change_of_its_parents() {
    let t = common::temp_dir("scan-future");
    let root = t.0.join("tree");
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::write(root.join("sub/normal"), b"x").unwrap();
    fs::write(root.join("sub/future"), b"x").unwrap();
    common::sh(
        &root,
        "touch -t 210601010000 sub/future && touch -t 202001010000 sub . ",
    );
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let plan = walk::Plan {
        map_depth: Some(3),
        now,
        ..Default::default()
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
        &|_| {},
    );
    let newest = |p: &Path| {
        out.map
            .iter()
            .find(|(path, ..)| path == p)
            .map(|(_, _, _, mtime)| *mtime)
            .unwrap()
    };
    assert!(newest(&root) <= now, "root says {}", newest(&root));
    assert!(newest(&root.join("sub")) <= now);
    assert!(
        newest(&root) > 1_600_000_000,
        "the normal file still counts"
    );
}

#[cfg(windows)]
#[test]
fn a_home_reached_through_a_junction_is_scanned_through_its_real_path() {
    let t = common::temp_dir("scan-homelink-windows");
    let real = t.0.join("real-home");
    let nm = real.join("code/app/node_modules/pkg");
    fs::create_dir_all(&nm).unwrap();
    fs::write(nm.join("index.js"), vec![1u8; 8192]).unwrap();
    let link = t.0.join("home-link");
    common::junction(&link, &real);
    let run = t.0.join("run");
    let err = scan(&link, &run);
    assert!(
        err.contains(&format!("resolves to {}", common::text(&real))),
        "{err}"
    );
    let rows = fs::read_to_string(run.join("scan.tsv")).unwrap();
    let wanted = format!("\t{}\t", common::text(&real.join("code/app/node_modules")));
    assert!(rows.contains(&wanted), "{rows}");
}

#[cfg(windows)]
#[test]
fn project_folders_are_offered_only_beside_their_project_files() {
    let t = common::temp_dir("scan-projects-windows");
    let home = t.0.join("home");
    let code = home.join("code");
    let folder = |rel: &str| {
        let dir = code.join(rel);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("data"), vec![1u8; 8192]).unwrap();
        dir
    };
    let file = |rel: &str| {
        let path = code.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"x").unwrap();
    };
    let vs = folder("app/.vs");
    file("app/App.sln");
    let library = folder("game/Library");
    folder("game/Assets");
    folder("game/ProjectSettings");
    let packages = folder("old/packages");
    file("old/packages.config");
    let test_results = folder("svc/TestResults");
    file("svc/Svc.Tests.csproj");
    let unreal: Vec<_> = ["DerivedDataCache", "Intermediate", "Saved"]
        .iter()
        .map(|name| folder(&format!("ue/{name}")))
        .collect();
    file("ue/Game.uproject");
    let never = [
        folder("lone/.vs"),
        folder("half/Library"),
        folder("fresh/packages"),
        folder("mono/packages"),
        folder("plain/TestResults"),
        folder("notue/Saved"),
    ];
    folder("half/Assets");
    file("fresh/packages.config");
    file("plain/Svc.csproj");
    common::sh(&code, "touch -t 202001010000 old/packages mono/packages");
    let run = t.0.join("run");
    scan(&home, &run);
    let rows = fs::read_to_string(run.join("scan.tsv")).unwrap();
    let cat_of = |p: &Path| {
        let path = common::text(p);
        rows.lines()
            .map(|l| l.split('\t').collect::<Vec<_>>())
            .filter(|cols| cols.get(8) == Some(&path.as_str()))
            .map(|cols| cols[0].to_string())
            .collect::<Vec<_>>()
    };
    for p in [&vs, &library, &packages, &test_results] {
        assert_eq!(cat_of(p), ["project-review"], "{}\n{rows}", p.display());
    }
    for p in &unreal {
        assert_eq!(cat_of(p), ["unreal-projects"], "{}\n{rows}", p.display());
    }
    for p in &never {
        assert!(cat_of(p).is_empty(), "{}\n{rows}", p.display());
    }
}

#[cfg(unix)]
#[test]
fn drives_other_than_all_are_windows_only() {
    let t = common::temp_dir("scan-drives-unix");
    let home = t.0.join("home");
    fs::create_dir_all(&home).unwrap();
    let run = t.0.join("run");
    scan(&home, &run);
    assert!(run.join("scan.tsv").is_file());
    for list in ["C", "c,d", "C D"] {
        let out = common::cli(&["scan", "--drives", list], &home, &[]);
        assert_eq!(out.status.code(), Some(2), "{list}");
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(err.contains("Windows-only"), "{err}");
    }
}

#[cfg(windows)]
#[test]
fn a_drive_that_is_not_a_fixed_local_disk_is_an_error_naming_it() {
    let t = common::temp_dir("scan-drives-windows");
    let home = t.0.join("home");
    fs::create_dir_all(&home).unwrap();
    let free = common::free_letter();
    for (list, named) in [
        (
            format!("{},{free}", common::drives_arg(&home)),
            format!("{free}:"),
        ),
        ("C,?".to_string(), "?".to_string()),
    ] {
        let out = common::cli(&["scan", "--drives", &list], &home, &[]);
        assert_eq!(out.status.code(), Some(2), "{list}");
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(err.contains(&named), "{err}");
    }
}
