mod common;

use common::{ino, text};
use disk_clean::trash;
use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::Duration;

fn scan_row(cat: &str, action: &str, path: &str, bytes: i64) -> String {
    format!("{cat}\tTitle\tDesc\tsafe\t1\t{action}\t-\t{path}\t{path}\t{bytes}\tnote\t1\texact\n")
}

fn item(action: &str, path: &str, bytes: i64) -> String {
    format!(
        r#"{{"path": "{path}", "label": "{path}", "bytes": {bytes}, "action": "{action}", "cmd_id": "-"}}"#
    )
}

struct Sandbox {
    _t: common::TempDir,
    home: PathBuf,
    run: PathBuf,
}

fn sandbox(tag: &str) -> Sandbox {
    let t = common::temp_dir(tag);
    let home = t.0.join("home");
    let run = home.join(".cache/disk-clean/run-1");
    fs::create_dir_all(&run).unwrap();
    common::assert_inside_ram_disk(&home);
    Sandbox { _t: t, home, run }
}

fn make(path: &Path, bytes: usize) {
    fs::create_dir_all(path).unwrap();
    fs::write(path.join("data"), vec![7u8; bytes]).unwrap();
}

fn approve_with(s: &Sandbox, rows: &[(&str, &Path, i64)], mode: &str) {
    for (_, p, _) in rows {
        common::assert_inside_ram_disk(p);
    }
    let scan: String = rows
        .iter()
        .map(|(action, p, bytes)| scan_row("caches", action, &text(p), *bytes))
        .collect();
    let items: Vec<String> = rows
        .iter()
        .map(|(action, p, bytes)| item(action, &text(p), *bytes))
        .collect();
    fs::write(s.run.join("scan.tsv"), scan).unwrap();
    fs::write(
        common::decision_file(&s.run),
        format!(r#"{{"items": [{}], "mode": "{mode}"}}"#, items.join(",")),
    )
    .unwrap();
}

fn approve(s: &Sandbox, rows: &[(&str, &Path, i64)]) {
    approve_with(s, rows, "trash");
}

fn cli(s: &Sandbox, args: &[&str]) -> Output {
    let out = common::cli(args, &s.home, &[]);
    common::assert_record_inside_ram_disk(&s.home);
    out
}

fn clean(s: &Sandbox) {
    let _ = fs::remove_file(s.run.join("decisions/1/status"));
    let out = cli(s, &["clean", &text(&s.run), "--decision", "1"]);
    assert!(
        out.status.success(),
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    common::wait_for("the worker", Duration::from_secs(30), || {
        fs::read_to_string(s.run.join("decisions/1/status")).unwrap_or_default() == "done\n"
    });
    common::assert_record_inside_ram_disk(&s.home);
    let log = fs::read_to_string(s.run.join("clean.log")).unwrap_or_default();
    assert!(
        !log.contains("NOT TRASHED") || log.contains("Caches/pinned"),
        "{log}"
    );
}

fn record(s: &Sandbox) -> Vec<trash::Entry> {
    trash::read(&text(&s.home))
}

fn named(run: &Path, name: &str) -> Vec<Value> {
    common::events_of(run)
        .into_iter()
        .filter(|e| e["event"] == name)
        .collect()
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn approved_paths_go_to_the_trash_and_undo_restores_them_exactly() {
    let s = sandbox("trash-undo");
    let (a, b) = (
        s.home.join("Library/Caches/a"),
        s.home.join("Library/Caches/b"),
    );
    make(&a.join("nested"), 3000);
    make(&b, 5000);
    let (a_ino, b_ino) = (ino(&a), ino(&b));
    approve(&s, &[("rm", &a, 4096), ("rm", &b, 8192)]);
    clean(&s);

    assert!(!a.exists() && !b.exists());
    let entries = record(&s);
    assert_eq!(entries.len(), 2, "{entries:?}");
    assert_eq!(entries[0].original, text(&a));
    assert!(
        Path::new(&entries[0].trashed).parent() == Some(common::trash_dir(&s.home).as_path()),
        "{entries:?}"
    );
    assert_eq!((entries[0].bytes, entries[0].ino), (4096, a_ino));
    assert_eq!(entries[1].ino, b_ino);
    assert!(entries.iter().all(|e| e.state == "trashed"));
    assert!(Path::new(&entries[0].trashed).join("nested/data").exists());
    let done = named(&s.run, "done").pop().unwrap();
    assert_eq!(
        (
            &done["removed_bytes"],
            &done["trashed"],
            &done["trashed_bytes"]
        ),
        (&0.into(), &2.into(), &(4096 + 8192).into()),
        "moving to the Trash is never counted as freed"
    );

    let out = cli(&s, &["undo", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0), "{}", stdout(&out));
    assert!(
        stdout(&out).contains("restored: 2 items, 12288 bytes"),
        "{}",
        stdout(&out)
    );
    assert_eq!(fs::read(a.join("nested/data")).unwrap().len(), 3000);
    assert_eq!(
        (ino(&a), ino(&b)),
        (a_ino, b_ino),
        "the same items came back"
    );
    assert!(record(&s).iter().all(|e| e.state == "restored"));
    let undone = named(&s.run, "undone");
    assert_eq!(undone.len(), 2);
    assert!(undone.iter().all(|e| e["outcome"] == "restored"));
    let summary = named(&s.run, "undo_done").pop().unwrap();
    assert_eq!(
        (&summary["restored"], &summary["trashed"]),
        (&2.into(), &0.into())
    );
    let again = cli(&s, &["undo", &text(&s.run)]);
    assert_eq!(again.status.code(), Some(3), "nothing left to undo");
}

#[cfg(unix)]
#[test]
fn a_name_clash_in_the_trash_gets_its_own_name() {
    let s = sandbox("trash-clash");
    let name = format!("clash-{}", std::process::id());
    let a = s.home.join("Library/Caches").join(&name);
    make(&a, 100);
    fs::create_dir_all(common::trash_dir(&s.home)).unwrap();
    let clash = common::trash_dir(&s.home).join(&name);
    fs::write(&clash, b"someone else's").unwrap();
    approve(&s, &[("rm", &a, 4096)]);
    clean(&s);
    let entry = &record(&s)[0];
    assert_ne!(entry.trashed, text(&clash), "{entry:?}");
    assert!(Path::new(&entry.trashed).join("data").exists());
    assert_eq!(fs::read(&clash).unwrap(), b"someone else's");
    assert_eq!(cli(&s, &["undo", &text(&s.run)]).status.code(), Some(0));
    assert!(a.join("data").exists() && clash.exists());
    fs::remove_file(clash).unwrap();
}

#[test]
fn undo_never_overwrites_an_original_that_came_back() {
    let s = sandbox("trash-conflict");
    let a = s.home.join("Library/Caches/a");
    make(&a, 100);
    approve(&s, &[("rm", &a, 4096)]);
    clean(&s);
    make(&a, 9);
    let out = cli(&s, &["undo", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0));
    assert!(
        stdout(&out).contains("still in the Trash: 1"),
        "{}",
        stdout(&out)
    );
    assert_eq!(
        fs::read(a.join("data")).unwrap().len(),
        9,
        "never overwritten"
    );
    let entry = &record(&s)[0];
    assert_eq!(entry.state, "trashed");
    assert_eq!(entry.reason, trash::STILL_THERE);
    assert!(Path::new(&entry.trashed).join("data").exists());
    assert_eq!(named(&s.run, "undone")[0]["outcome"], "kept");
}

#[test]
fn sync_notices_put_back_emptied_and_replaced_items_and_never_acts() {
    let s = sandbox("trash-sync");
    let caches = s.home.join("Library/Caches");
    let (put, gone, swapped, kept) = (
        caches.join("put"),
        caches.join("gone"),
        caches.join("swapped"),
        caches.join("kept"),
    );
    for p in [&put, &gone, &swapped, &kept] {
        make(p, 10);
    }
    approve(
        &s,
        &[
            ("rm", &put, 1),
            ("rm", &gone, 2),
            ("rm", &swapped, 3),
            ("rm", &kept, 4),
        ],
    );
    clean(&s);
    let at = |name: &str| {
        record(&s)
            .into_iter()
            .find(|e| e.original.ends_with(name))
            .unwrap()
    };
    fs::rename(at("/put").trashed, &put).unwrap();
    fs::remove_dir_all(at("/gone").trashed).unwrap();
    let decoy = at("/swapped").trashed;
    fs::remove_dir_all(&decoy).unwrap();
    make(Path::new(&decoy), 1);

    let out = cli(
        &s,
        &["clean", "--dry-run", &text(&s.run), "--decision", "1"],
    );
    assert!(out.status.code().is_some());
    assert_eq!(at("/put").state, "put-back");
    assert_eq!(at("/gone").state, "emptied");
    let replaced = at("/swapped");
    assert_eq!(replaced.state, "failed");
    assert_eq!(
        replaced.reason,
        "the item in the Trash was replaced, not touched"
    );
    assert!(Path::new(&decoy).join("data").exists(), "never acted on");
    assert_eq!(at("/kept").state, "trashed");
    assert!(put.join("data").exists());
    fs::remove_dir_all(decoy).unwrap();
}

#[cfg(unix)]
#[test]
fn empty_removes_only_recorded_items_still_in_the_trash() {
    let s = sandbox("trash-empty");
    let (a, b) = (
        s.home.join("Library/Caches/a"),
        s.home.join("Library/Caches/b"),
    );
    make(&a, 3000);
    make(&b, 100);
    approve(&s, &[("rm", &a, 4096)]);
    clean(&s);
    fs::create_dir_all(common::trash_dir(&s.home)).unwrap();
    let theirs = common::trash_dir(&s.home).join(format!("not-ours-{}", std::process::id()));
    fs::write(&theirs, b"the user's").unwrap();
    let trashed = PathBuf::from(&record(&s)[0].trashed);

    let out = cli(&s, &["empty", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0), "{}", stdout(&out));
    assert!(stdout(&out).contains("emptied: 1 items, 4096 bytes"));
    assert!(!trashed.exists() && !a.exists());
    assert!(theirs.exists() && b.exists(), "only our record is touched");
    assert_eq!(record(&s)[0].state, "emptied");
    let done = named(&s.run, "empty_done").pop().unwrap();
    assert_eq!((&done["emptied"], &done["trashed"]), (&1.into(), &0.into()));
    assert!(done["free_after"].is_i64() && done["free_before"].is_i64());
    assert_eq!(cli(&s, &["empty", &text(&s.run)]).status.code(), Some(3));
    fs::remove_file(theirs).unwrap();
}

#[test]
fn delete_immediately_removes_and_is_never_recorded() {
    let s = sandbox("trash-now");
    let a = s.home.join("Library/Caches/a");
    make(&a.join("deep"), 100);
    approve_with(&s, &[("rm", &a, 4096)], "now");
    let dry = stdout(&cli(
        &s,
        &["clean", "--dry-run", &text(&s.run), "--decision", "1"],
    ));
    assert!(
        dry.contains(&format!(
            "# deleted immediately, skipping the Trash (can't be undone):\nrm -rf -- {}\n",
            text(&a)
        )),
        "{dry}"
    );
    assert!(!dry.contains("trash --"), "{dry}");
    clean(&s);
    assert!(!a.exists());
    assert!(record(&s).is_empty());
    assert!(named(&s.run, "trashed").is_empty());
    assert_eq!(named(&s.run, "removed")[0]["path"], text(&a));
    let done = named(&s.run, "done").pop().unwrap();
    assert_eq!((&done["removed"], &done["trashed"]), (&1.into(), &0.into()));
    assert_eq!(cli(&s, &["undo", &text(&s.run)]).status.code(), Some(3));
}

#[cfg(target_os = "macos")]
#[test]
fn items_already_in_the_trash_are_removed_for_good_not_trashed_again() {
    let s = sandbox("trash-old");
    let old = s.home.join(".Trash/old");
    make(&old, 10);
    approve(&s, &[("rm", &old, 4096)]);
    let dry = stdout(&cli(
        &s,
        &["clean", "--dry-run", &text(&s.run), "--decision", "1"],
    ));
    assert!(
        dry.contains(&format!("rm -rf -- {}\n", text(&old))),
        "{dry}"
    );
    clean(&s);
    assert!(!old.exists() && record(&s).is_empty());
}

#[cfg(unix)]
fn legacy_run(s: &Sandbox, originals: &[&Path]) -> PathBuf {
    let dir = s.home.join(".cache/disk-clean/held/run-1-0badf00d");
    fs::create_dir_all(&dir).unwrap();
    let mut manifest = String::new();
    for (n, original) in originals.iter().enumerate() {
        common::assert_inside_ram_disk(original.parent().unwrap());
        let held = dir.join((n + 1).to_string());
        make(&held, 50 + n);
        let meta = fs::symlink_metadata(&held).unwrap();
        manifest.push_str(&format!(
            "{}\n",
            serde_json::json!({"original": text(original), "held": text(&held), "bytes": 4096, "held_at": 1, "dev": meta.dev(), "ino": meta.ino()})
        ));
    }
    fs::write(dir.join("manifest.jsonl"), manifest).unwrap();
    dir
}

#[cfg(unix)]
#[test]
fn migration_moves_held_runs_into_the_trash_and_drops_the_holding_folder() {
    let s = sandbox("trash-migrate");
    let (a, b) = (
        s.home.join("Library/Caches/a"),
        s.home.join("code/app/node_modules"),
    );
    fs::create_dir_all(a.parent().unwrap()).unwrap();
    fs::create_dir_all(b.parent().unwrap()).unwrap();
    let dir = legacy_run(&s, &[&a, &b]);

    let out = cli(
        &s,
        &["clean", "--dry-run", &text(&s.run), "--decision", "1"],
    );
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains("disk-clean: moved 2 held items from the old holding folder to the Trash"),
        "{err}"
    );
    assert!(!dir.exists() && !s.home.join(".cache/disk-clean/held").exists());
    let entries = record(&s);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].original, text(&a));
    assert_eq!(entries[0].run, "run-1-0badf00d");
    assert_eq!(
        Path::new(&entries[1].trashed)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .split(' ')
            .next(),
        Some("node_modules"),
        "trashed under its own name"
    );
    assert!(entries.iter().all(|e| e.state == "trashed"));

    let undo = cli(&s, &["undo", "--all"]);
    assert_eq!(undo.status.code(), Some(0), "{}", stdout(&undo));
    assert_eq!(fs::read(a.join("data")).unwrap().len(), 50);
    assert_eq!(fs::read(b.join("data")).unwrap().len(), 51);
}

#[cfg(unix)]
fn trashed_entries(s: &Sandbox) -> Vec<trash::Entry> {
    record(s)
        .into_iter()
        .filter(|e| e.state == "trashed")
        .collect()
}

#[cfg(unix)]
#[test]
fn a_held_item_the_trash_refuses_stays_held_and_moves_on_a_later_run() {
    let s = sandbox("trash-migrate-refused");
    let (a, b) = (s.home.join("Library/Caches/a"), s.home.join("go/pkg/mod/b"));
    fs::create_dir_all(a.parent().unwrap()).unwrap();
    fs::create_dir_all(b.parent().unwrap()).unwrap();
    let dir = legacy_run(&s, &[&a, &b]);
    let read_only = dir.join("2");
    let ino_before = ino(&read_only);
    fs::set_permissions(&read_only, fs::Permissions::from_mode(0o500)).unwrap();

    let out = cli(
        &s,
        &["clean", "--dry-run", &text(&s.run), "--decision", "1"],
    );
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("moved 1 held items"), "{err}");
    assert!(err.contains("1 stay in"), "{err}");
    assert_eq!(ino(&read_only), ino_before, "renamed back to its held name");
    assert!(!dir.join("b").exists());
    assert!(
        dir.join("manifest.jsonl").exists(),
        "the manifest stays while an item is held"
    );
    assert_eq!(trashed_entries(&s).len(), 1);

    fs::set_permissions(&read_only, fs::Permissions::from_mode(0o700)).unwrap();
    let out = cli(
        &s,
        &["clean", "--dry-run", &text(&s.run), "--decision", "1"],
    );
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("moved 1 held items"), "{err}");
    assert!(!dir.exists());
    let trashed = trashed_entries(&s);
    assert_eq!(trashed.len(), 2);
    assert_eq!(trashed[1].original, text(&b));
    let undo = cli(&s, &["undo", "--all"]);
    assert_eq!(undo.status.code(), Some(0), "{}", stdout(&undo));
    assert_eq!(fs::read(b.join("data")).unwrap().len(), 51);
}

#[cfg(unix)]
#[test]
fn a_held_item_left_under_its_readable_name_is_still_found_and_moved() {
    let s = sandbox("trash-migrate-renamed");
    let a = s.home.join("Library/Caches/a");
    fs::create_dir_all(a.parent().unwrap()).unwrap();
    let dir = legacy_run(&s, &[&a]);
    fs::rename(dir.join("1"), dir.join("a")).unwrap();
    fs::write(dir.join("stray"), b"not in the manifest").unwrap();

    let out = cli(
        &s,
        &["clean", "--dry-run", &text(&s.run), "--decision", "1"],
    );
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("moved 1 held items"), "{err}");
    assert_eq!(trashed_entries(&s)[0].original, text(&a));
    assert!(
        dir.join("manifest.jsonl").exists() && dir.join("stray").exists(),
        "never drops the manifest or the folder while a file remains"
    );
}

#[cfg(unix)]
#[test]
fn a_tampered_record_or_swapped_folder_is_never_followed() {
    let s = sandbox("trash-tamper");
    let (a, b) = (
        s.home.join("Library/Caches/a/inner"),
        s.home.join("Library/Caches/b"),
    );
    make(&a, 10);
    make(&b, 10);
    approve(&s, &[("rm", &a, 1), ("rm", &b, 2)]);
    clean(&s);
    let decoy = common::temp_dir("trash-tamper-decoy");
    fs::rename(
        s.home.join("Library/Caches/a"),
        s.home.join("Library/Caches/a-moved"),
    )
    .unwrap();
    std::os::unix::fs::symlink(&decoy.0, s.home.join("Library/Caches/a")).unwrap();
    let path = trash::record_path(&text(&s.home));
    let b_trashed = record(&s)[1].trashed.clone();
    let precious = s.home.join("Library/Caches/precious");
    make(&precious, 5);
    let tampered = fs::read_to_string(&path)
        .unwrap()
        .replace(&b_trashed, &text(&precious));
    fs::write(&path, tampered).unwrap();

    let out = cli(&s, &["undo", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0), "{}", stdout(&out));
    assert!(
        !decoy.0.join("inner").exists(),
        "never restored through a symlink"
    );
    assert!(precious.join("data").exists());
    let entries = record(&s);
    assert!(
        entries[0].reason.contains("resolves elsewhere"),
        "{entries:?}"
    );
    assert_eq!(entries[0].state, "trashed");
    assert_eq!(entries[1].state, "failed", "{entries:?}");
    let out = cli(&s, &["empty", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0));
    assert!(precious.join("data").exists());
    assert!(
        Path::new(&b_trashed).exists(),
        "the real b is never touched by a tampered entry"
    );
    assert!(!Path::new(&entries[0].trashed).exists());
    fs::remove_dir_all(b_trashed).unwrap();
}

#[test]
fn undo_and_empty_wait_while_the_record_is_busy() {
    let s = sandbox("trash-busy");
    let a = s.home.join("Library/Caches/a");
    make(&a, 10);
    approve(&s, &[("rm", &a, 1)]);
    clean(&s);
    let held = trash::Record::open(&text(&s.home), 1).unwrap().unwrap();
    assert_eq!(cli(&s, &["undo", &text(&s.run)]).status.code(), Some(4));
    assert_eq!(cli(&s, &["empty", &text(&s.run)]).status.code(), Some(4));
    let (_child, port, token) = session(&s);
    let own = own_headers(port);
    let id = record(&s)[0].id.clone();
    let body = format!(r#"{{"token": "{token}", "ids": ["{id}"]}}"#);
    assert_eq!(post(port, "/undo", &own, &body), 409);
    drop(held);
    assert_eq!(post(port, "/undo", &own, &body), 200);
    common::wait_for("the undo", Duration::from_secs(10), || {
        !named(&s.run, "undo_done").is_empty()
    });
    assert!(a.join("data").exists());
}

#[test]
fn the_worker_holds_the_record_so_an_undo_cannot_race_it() {
    let s = sandbox("trash-race");
    let caches = s.home.join("Library/Caches");
    let paths: Vec<PathBuf> = (0..150).map(|n| caches.join(format!("p{n}"))).collect();
    for p in &paths {
        make(p, 1);
    }
    let rows: Vec<(&str, &Path, i64)> = paths.iter().map(|p| ("rm", p.as_path(), 1)).collect();
    approve(&s, &rows);
    let out = cli(&s, &["clean", &text(&s.run), "--decision", "1"]);
    assert!(out.status.success());
    common::wait_for("the first trash batch", Duration::from_secs(30), || {
        !named(&s.run, "trash").is_empty()
    });
    let busy = trash::Record::open(&text(&s.home), 1).unwrap();
    let done = fs::read_to_string(s.run.join("decisions/1/status")).unwrap_or_default() == "done\n";
    assert!(
        busy.is_none() || done,
        "the record is free while the worker still moves items"
    );
    drop(busy);
    common::wait_for("the worker", Duration::from_secs(60), || {
        fs::read_to_string(s.run.join("decisions/1/status")).unwrap_or_default() == "done\n"
    });
    assert_eq!(record(&s).len(), 150);
    assert_eq!(cli(&s, &["undo", &text(&s.run)]).status.code(), Some(0));
    assert!(paths.iter().all(|p| p.join("data").exists()));
}

fn session(s: &Sandbox) -> (common::Reaped, u16, String) {
    let mut child = common::reaped(
        common::bin(&s.home)
            .args(["review", &text(&s.run)])
            .env("DISK_CLEAN_NO_BROWSER", "1")
            .stdout(Stdio::null())
            .stderr(Stdio::piped()),
    );
    let mut err = std::io::BufReader::new(child.stderr.take().unwrap());
    let mut line = String::new();
    std::io::BufRead::read_line(&mut err, &mut line).unwrap();
    let port: u16 = line
        .trim()
        .trim_end_matches('/')
        .rsplit(':')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    std::thread::spawn(move || std::io::copy(&mut err, &mut std::io::sink()));
    let page = get(port, "/");
    let token = page
        .split_once(r#"<meta name="disk-clean-token" content=""#)
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(token, _)| token.to_string())
        .unwrap();
    (child, port, token)
}

fn own_headers(port: u16) -> String {
    format!(
        "Host: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nContent-Type: application/json\r\n"
    )
}

fn post(port: u16, route: &str, headers: &str, body: &str) -> u16 {
    let mut stream = common::connect(port);
    write!(
        stream,
        "POST {route} HTTP/1.1\r\n{headers}Content-Length: {}\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut out = String::new();
    stream.read_to_string(&mut out).unwrap();
    out.split_whitespace().nth(1).unwrap().parse().unwrap()
}

fn get(port: u16, route: &str) -> String {
    let mut stream = common::connect(port);
    write!(
        stream,
        "GET {route} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"
    )
    .unwrap();
    let mut out = String::new();
    stream.read_to_string(&mut out).unwrap();
    out
}

#[test]
fn undo_and_empty_routes_need_token_origin_and_host_and_stay_in_the_record() {
    let s = sandbox("trash-routes");
    let (a, b, outsider) = (
        s.home.join("Library/Caches/a"),
        s.home.join("Library/Caches/b"),
        s.home.join("Library/Caches/outsider"),
    );
    make(&a, 100);
    make(&b, 100);
    make(&outsider, 100);
    approve(&s, &[("rm", &a, 4096), ("rm", &b, 4096)]);
    clean(&s);
    let ids: Vec<String> = record(&s).into_iter().map(|e| e.id).collect();
    let (_child, port, token) = session(&s);
    let own = own_headers(port);
    let body = |id: &str| {
        format!(
            r#"{{"token": "{token}", "ids": ["{id}"], "paths": ["{}"]}}"#,
            text(&outsider)
        )
    };
    let refused = [
        (
            format!(
                "Host: evil.example:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nContent-Type: application/json\r\n"
            ),
            body(&ids[0]),
        ),
        (
            format!(
                "Host: 127.0.0.1:{port}\r\nOrigin: http://evil.example\r\nContent-Type: application/json\r\n"
            ),
            body(&ids[0]),
        ),
        (
            format!("Host: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n"),
            body(&ids[0]),
        ),
        (
            format!(
                "Host: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nContent-Type: text/plain\r\n"
            ),
            body(&ids[0]),
        ),
        (own.clone(), r#"{"token": "wrong", "ids": []}"#.to_string()),
        (own.clone(), "not json".to_string()),
        (own.clone(), format!(r#"{{"token": "{token}"}}"#)),
    ];
    for route in ["/undo", "/empty"] {
        for (headers, body) in &refused {
            let status = post(port, route, headers, body);
            assert!(
                status == 403 || status == 400,
                "{route} {headers:?} {body}: {status}"
            );
        }
    }
    assert_eq!(
        post(port, "/free", &own, &body(&ids[0])),
        404,
        "free is gone"
    );
    assert_eq!(
        post(port, "/undo", &own, &body("00000000deadbeef")),
        404,
        "an id we never recorded"
    );

    assert_eq!(post(port, "/undo", &own, &body(&ids[0])), 200);
    common::wait_for("the undo", Duration::from_secs(10), || {
        !named(&s.run, "undo_done").is_empty()
    });
    assert!(a.join("data").exists() && !b.exists());
    assert_eq!(post(port, "/empty", &own, &body(&ids[1])), 200);
    common::wait_for("the empty", Duration::from_secs(10), || {
        !named(&s.run, "empty_done").is_empty()
    });
    assert!(outsider.join("data").exists() && a.join("data").exists());
    assert_eq!(
        record(&s)
            .iter()
            .map(|e| e.state.as_str())
            .collect::<Vec<_>>(),
        ["restored", "emptied"]
    );
    let rows = named(&s.run, "trash");
    assert!(rows.iter().any(|r| r["entries"][0]["state"] == "emptied"));
    let log = fs::read_to_string(s.run.join("clean.log")).unwrap();
    assert!(
        log.contains("page: undo from the page: restored: 1 items, 100 bytes")
            || log.contains("page: undo from the page: restored: 1 items, 4096 bytes"),
        "the page's Undo is in the log of record: {log}"
    );
    assert!(
        log.contains("page: empty from the page: emptied: 1 items"),
        "{log}"
    );
    let woke: Vec<String> = (0..3)
        .map(|_| {
            let out = cli(&s, &["wait", &text(&s.run)]);
            assert_eq!(out.status.code(), Some(0));
            stdout(&out)
        })
        .collect();
    assert!(woke[0].starts_with("decision 1 "), "{woke:?}");
    assert!(
        woke[1].starts_with("page: undo from the page: restored: 1 items"),
        "{woke:?}"
    );
    assert!(woke[2].starts_with("page: empty from the page"), "{woke:?}");
}

#[test]
fn a_page_load_syncs_the_record_and_tells_the_page() {
    let s = sandbox("trash-page");
    let a = s.home.join("Library/Caches/a");
    make(&a, 100);
    approve(&s, &[("rm", &a, 4096)]);
    clean(&s);
    let entry = record(&s).remove(0);
    assert_eq!(entry.state, "trashed", "{entry:?}");
    fs::rename(&entry.trashed, &a).unwrap();
    let (_child, port, _) = session(&s);
    let page = get(port, "/trash");
    assert!(page.contains(" 200 OK"), "{page}");
    assert!(
        page.contains(r#""state":"put-back""#),
        "the page gets the synced record"
    );
    assert!(page.contains(&format!(r#""run":"{}""#, trash::run_id(&s.run))));
    assert_eq!(record(&s)[0].state, "put-back");
}

#[cfg(target_os = "macos")]
#[test]
fn the_confirm_plan_lists_trash_moves_apart_from_steps_that_cannot_be_undone() {
    let s = sandbox("trash-preview");
    let a = s.home.join("Library/Caches/a");
    let old = s.home.join(".Trash/old");
    make(&a, 100);
    make(&old, 100);
    let scan = scan_row("caches", "rm", &text(&a), 4096)
        + &scan_row("trash", "rm", &text(&old), 10)
        + "docker\tDocker\tD\treview\t0\tcmd\tdocker-prune\tdocker system prune -f\tcmd:docker-prune\t7\tn\t-\tvm\n";
    fs::write(s.run.join("scan.tsv"), scan).unwrap();
    let cats = disk_clean::review::load_scan(&s.run);
    let index =
        disk_clean::clean::index_scan(&disk_clean::util::read_lines(&s.run.join("scan.tsv")));
    let items = [
        serde_json::json!({"path": text(&a)}),
        serde_json::json!({"path": text(&old)}),
        serde_json::json!({"path": "cmd:docker-prune"}),
        serde_json::json!({"path": "/etc/hosts"}),
    ];
    let plan = disk_clean::review::preview(&cats, &index, &items, &text(&s.home));
    let paths = plan["paths"].as_array().unwrap();
    let of = |p: &Path| paths.iter().find(|r| r["path"] == text(p)).unwrap();
    assert_eq!(of(&a)["bytes"], 4096);
    assert_eq!(of(&a)["trashed"], false);
    assert_eq!(of(&old)["trashed"], true, "already in a Trash");
    assert_eq!(plan["paths_bytes"], 4106);
    assert_eq!(plan["final"], serde_json::json!(["docker system prune -f"]));
    assert_eq!((&plan["count"], &plan["bytes"]), (&3.into(), &4113.into()));
    assert!(a.exists());
}

#[test]
fn the_review_page_can_undo_and_empty_earlier_runs_too() {
    let s = sandbox("trash-review");
    let (a, b) = (
        s.home.join("Library/Caches/a"),
        s.home.join("Library/Caches/b"),
    );
    make(&a, 10);
    make(&b, 10);
    approve(&s, &[("rm", &a, 1), ("rm", &b, 2)]);
    clean(&s);
    let ids: Vec<String> = record(&s).into_iter().map(|e| e.id).collect();
    let next = s.home.join(".cache/disk-clean/run-2");
    fs::create_dir_all(&next).unwrap();
    fs::write(
        next.join("scan.tsv"),
        scan_row("caches", "rm", &text(&s.home.join("x")), 1),
    )
    .unwrap();
    let mut child = common::reaped(
        common::bin(&s.home)
            .args(["review", &text(&next)])
            .env("DISK_CLEAN_NO_BROWSER", "1")
            .stdout(Stdio::null())
            .stderr(Stdio::piped()),
    );
    let mut err = std::io::BufReader::new(child.stderr.take().unwrap());
    let mut line = String::new();
    std::io::BufRead::read_line(&mut err, &mut line).unwrap();
    let port: u16 = line
        .trim()
        .trim_end_matches('/')
        .rsplit(':')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let page = get(port, "/trash");
    let token = page
        .split_once(r#"<meta name="disk-clean-token" content=""#)
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(token, _)| token.to_string())
        .unwrap();
    assert!(page.contains(&ids[0]), "the page lists earlier runs");
    let body = |id: &str| format!(r#"{{"token": "{token}", "ids": ["{id}"]}}"#);
    let no_origin = format!("Host: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n");
    assert_eq!(post(port, "/undo", &no_origin, &body(&ids[0])), 403);
    assert_eq!(post(port, "/undo", &own_headers(port), &body(&ids[0])), 200);
    assert!(a.join("data").exists());
    assert_eq!(
        post(port, "/empty", &own_headers(port), &body(&ids[1])),
        200
    );
    assert_eq!(
        record(&s)
            .iter()
            .map(|e| e.state.as_str())
            .collect::<Vec<_>>(),
        ["restored", "emptied"]
    );
}

#[cfg(target_os = "linux")]
fn info_of(trashed: &Path) -> PathBuf {
    let name = trashed.file_name().unwrap().to_string_lossy();
    trashed
        .parent()
        .and_then(Path::parent)
        .unwrap()
        .join("info")
        .join(format!("{name}.trashinfo"))
}

#[cfg(target_os = "linux")]
fn percent_decoded(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .filter(|_| bytes[i] == b'%')
            .and_then(|h| u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok());
        match hex {
            Some(byte) => {
                out.push(byte);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap()
}

#[cfg(target_os = "linux")]
fn trashinfo(trashed: &Path) -> (String, String, String) {
    let info = fs::read_to_string(info_of(trashed)).unwrap();
    assert!(info.starts_with("[Trash Info]\n"), "{info}");
    let field = |key: &str| {
        info.lines()
            .find_map(|l| l.strip_prefix(key))
            .unwrap_or_else(|| panic!("no {key} in {info}"))
            .to_string()
    };
    let raw = field("Path=");
    (percent_decoded(&raw), raw, field("DeletionDate="))
}

#[cfg(target_os = "linux")]
fn is_local_time(date: &str) -> bool {
    date.len() == 19
        && date.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            10 => b == b'T',
            13 | 16 => b == b':',
            _ => b.is_ascii_digit(),
        })
}

#[cfg(target_os = "linux")]
#[test]
fn items_already_in_the_trash_are_removed_for_good_not_trashed_again_on_linux() {
    let s = sandbox("trash-old-linux");
    let old = common::trash_dir(&s.home).join("old");
    make(&old, 10);
    let info = info_of(&old);
    fs::create_dir_all(info.parent().unwrap()).unwrap();
    fs::write(
        &info,
        "[Trash Info]\nPath=/somewhere/old\nDeletionDate=2020-01-01T00:00:00\n",
    )
    .unwrap();
    approve(&s, &[("rm", &old, 4096)]);
    let dry = stdout(&cli(
        &s,
        &["clean", "--dry-run", &text(&s.run), "--decision", "1"],
    ));
    assert!(
        dry.contains(&format!("rm -rf -- {}\n", text(&old))),
        "{dry}"
    );
    clean(&s);
    assert!(!old.exists() && record(&s).is_empty());
    assert!(!info.exists(), "its .trashinfo goes with it");
}

#[cfg(target_os = "linux")]
#[test]
fn the_confirm_plan_lists_trash_moves_apart_from_steps_that_cannot_be_undone_on_linux() {
    let s = sandbox("trash-preview-linux");
    let a = s.home.join(".cache/a");
    let old = common::trash_dir(&s.home).join("old");
    make(&a, 100);
    make(&old, 100);
    let scan = scan_row("caches", "rm", &text(&a), 4096)
        + &scan_row("trash", "rm", &text(&old), 10)
        + "docker\tDocker\tD\treview\t0\tcmd\tdocker-prune\tdocker system prune -f\tcmd:docker-prune\t7\tn\t-\tvm\n";
    fs::write(s.run.join("scan.tsv"), scan).unwrap();
    let cats = disk_clean::review::load_scan(&s.run);
    let index =
        disk_clean::clean::index_scan(&disk_clean::util::read_lines(&s.run.join("scan.tsv")));
    let items = [
        serde_json::json!({"path": text(&a)}),
        serde_json::json!({"path": text(&old)}),
        serde_json::json!({"path": "cmd:docker-prune"}),
        serde_json::json!({"path": "/etc/hosts"}),
    ];
    let plan = disk_clean::review::preview(&cats, &index, &items, &text(&s.home));
    let paths = plan["paths"].as_array().unwrap();
    let of = |p: &Path| paths.iter().find(|r| r["path"] == text(p)).unwrap();
    assert_eq!(of(&a)["bytes"], 4096);
    assert_eq!(of(&a)["trashed"], false);
    assert_eq!(of(&old)["trashed"], true, "already in a Trash");
    assert_eq!(plan["paths_bytes"], 4106);
    assert_eq!(plan["final"], serde_json::json!(["docker system prune -f"]));
    assert_eq!((&plan["count"], &plan["bytes"]), (&3.into(), &4113.into()));
    assert!(a.exists());
}

#[cfg(target_os = "linux")]
#[test]
fn the_home_trash_gets_a_trashinfo_and_undo_removes_it() {
    let s = sandbox("trash-linux-home");
    let a = s.home.join(".cache/odd name 100%");
    make(&a.join("nested"), 300);
    let a_ino = ino(&a);
    approve(&s, &[("rm", &a, 4096)]);
    clean(&s);

    assert!(!a.exists());
    let entry = record(&s).remove(0);
    let trashed = PathBuf::from(&entry.trashed);
    assert_eq!(
        trashed.parent(),
        Some(common::trash_dir(&s.home).as_path()),
        "{entry:?}"
    );
    assert_eq!((entry.ino, entry.state.as_str()), (a_ino, "trashed"));
    assert!(trashed.join("nested/data").exists());
    let (path, raw, date) = trashinfo(&trashed);
    assert_eq!(path, text(&a));
    assert!(!raw.contains(' ') && raw.contains("%25"), "{raw}");
    assert!(is_local_time(&date), "{date}");

    let out = cli(&s, &["undo", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0), "{}", stdout(&out));
    assert!(stdout(&out).contains("restored: 1 items, 4096 bytes"));
    assert_eq!(ino(&a), a_ino, "the same item came back");
    assert!(!trashed.exists());
    assert!(!info_of(&trashed).exists(), "the .trashinfo goes with it");
    assert_eq!(record(&s)[0].state, "restored");
}

#[cfg(target_os = "linux")]
#[test]
fn an_item_on_another_volume_goes_to_that_volumes_trash() {
    let s = sandbox("trash-linux-other");
    let other = common::other_volume(&s.home.join("other"));
    let (a, b) = (other.0.join("a"), other.0.join("b"));
    make(&a, 100);
    make(&b, 200);
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    let topdir_trash = other.0.join(format!(".Trash-{uid}"));

    approve(&s, &[("rm", &a, 4096)]);
    clean(&s);
    let entry = record(&s).remove(0);
    let trashed = PathBuf::from(&entry.trashed);
    assert_eq!(
        trashed.parent(),
        Some(topdir_trash.join("files").as_path()),
        "{entry:?}"
    );
    assert_eq!(
        fs::metadata(&topdir_trash).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert!(!common::trash_dir(&s.home).join("a").exists());
    let (path, _, date) = trashinfo(&trashed);
    assert!(
        path == text(&a) || other.0.join(&path) == a,
        "Path={path} names {}",
        a.display()
    );
    assert!(is_local_time(&date), "{date}");
    let out = cli(&s, &["undo", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0), "{}", stdout(&out));
    assert!(a.join("data").exists() && !trashed.exists());
    assert!(!info_of(&trashed).exists());

    approve(&s, &[("rm", &b, 4096)]);
    clean(&s);
    let entry = record(&s).pop().unwrap();
    let trashed = PathBuf::from(&entry.trashed);
    assert_eq!(trashed.parent(), Some(topdir_trash.join("files").as_path()));
    assert!(info_of(&trashed).exists());
    let out = cli(&s, &["empty", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0), "{}", stdout(&out));
    assert!(stdout(&out).contains("emptied: 1 items, 4096 bytes"));
    assert!(!trashed.exists() && !info_of(&trashed).exists() && !b.exists());
    assert_eq!(record(&s).pop().unwrap().state, "emptied");
}

#[cfg(target_os = "linux")]
#[test]
fn undo_onto_a_path_that_came_back_keeps_the_item_and_its_trashinfo() {
    let s = sandbox("trash-linux-conflict");
    let a = s.home.join(".cache/a");
    make(&a, 100);
    approve(&s, &[("rm", &a, 4096)]);
    clean(&s);
    let trashed = PathBuf::from(&record(&s)[0].trashed);
    make(&a, 9);
    let out = cli(&s, &["undo", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0));
    assert!(
        stdout(&out).contains("still in the Trash: 1"),
        "{}",
        stdout(&out)
    );
    assert_eq!(
        fs::read(a.join("data")).unwrap().len(),
        9,
        "never overwritten"
    );
    assert_eq!(fs::read(trashed.join("data")).unwrap().len(), 100);
    assert_eq!(trashinfo(&trashed).0, text(&a), "the .trashinfo stays");
    let entry = &record(&s)[0];
    assert_eq!(
        (entry.state.as_str(), entry.reason.as_str()),
        ("trashed", trash::STILL_THERE)
    );
}

#[cfg(target_os = "linux")]
#[test]
fn a_file_manager_restore_or_empty_is_picked_up_by_sync() {
    let s = sandbox("trash-linux-sync");
    let (put, gone, kept) = (
        s.home.join(".cache/put"),
        s.home.join(".cache/gone"),
        s.home.join(".cache/kept"),
    );
    for p in [&put, &gone, &kept] {
        make(p, 10);
    }
    approve(&s, &[("rm", &put, 1), ("rm", &gone, 2), ("rm", &kept, 3)]);
    clean(&s);
    let at = |name: &str| {
        record(&s)
            .into_iter()
            .find(|e| e.original.ends_with(name))
            .unwrap()
    };
    let put_trashed = PathBuf::from(at("/put").trashed);
    fs::rename(&put_trashed, &put).unwrap();
    fs::remove_file(info_of(&put_trashed)).unwrap();
    let gone_trashed = PathBuf::from(at("/gone").trashed);
    fs::remove_dir_all(&gone_trashed).unwrap();
    fs::remove_file(info_of(&gone_trashed)).unwrap();

    let out = cli(
        &s,
        &["clean", "--dry-run", &text(&s.run), "--decision", "1"],
    );
    assert!(out.status.code().is_some());
    assert_eq!(at("/put").state, "put-back");
    assert_eq!(at("/gone").state, "emptied");
    assert_eq!(at("/kept").state, "trashed");
    let out = cli(&s, &["empty", &text(&s.run)]);
    assert!(
        stdout(&out).contains("emptied: 1 items"),
        "{}",
        stdout(&out)
    );
    assert!(put.join("data").exists(), "never acted on twice");
    assert_eq!(cli(&s, &["undo", &text(&s.run)]).status.code(), Some(3));
}

#[cfg(target_os = "linux")]
#[test]
fn a_trashinfo_without_its_item_still_reserves_the_name() {
    let s = sandbox("trash-linux-reserved");
    let name = format!("reserved-{}", std::process::id());
    let a = s.home.join(".cache").join(&name);
    make(&a, 100);
    let reserved = info_of(&common::trash_dir(&s.home).join(&name));
    let theirs = "[Trash Info]\nPath=/elsewhere\nDeletionDate=2020-01-01T00:00:00\n";
    fs::create_dir_all(reserved.parent().unwrap()).unwrap();
    fs::write(&reserved, theirs).unwrap();
    approve(&s, &[("rm", &a, 4096)]);
    clean(&s);
    let trashed = PathBuf::from(&record(&s)[0].trashed);
    assert_ne!(trashed.file_name().unwrap().to_string_lossy(), name);
    assert_eq!(trashed.parent(), Some(common::trash_dir(&s.home).as_path()));
    assert_eq!(trashinfo(&trashed).0, text(&a));
    assert_eq!(fs::read_to_string(&reserved).unwrap(), theirs);
    assert_eq!(cli(&s, &["undo", &text(&s.run)]).status.code(), Some(0));
    assert!(a.join("data").exists());
    assert_eq!(fs::read_to_string(&reserved).unwrap(), theirs);
}

#[cfg(windows)]
fn info_of_recycled(trashed: &Path) -> PathBuf {
    let name = trashed.file_name().unwrap().to_string_lossy();
    let rest = name
        .strip_prefix("$R")
        .unwrap_or_else(|| panic!("{name} is not a $R name"));
    trashed.with_file_name(format!("$I{rest}"))
}

#[cfg(windows)]
fn recycled_from(info: &Path) -> Option<String> {
    let bytes = fs::read(info).ok()?;
    let chars = u32::from_le_bytes(bytes.get(24..28)?.try_into().ok()?) as usize;
    let units: Vec<u16> = bytes
        .get(28..28 + 2 * chars)?
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|c| *c != 0)
        .collect();
    Some(text(Path::new(&String::from_utf16(&units).ok()?)))
}

#[cfg(windows)]
fn recycled_by_hand(bin: &Path, original: &Path) -> PathBuf {
    let mut ours: Vec<PathBuf> = bin_entries(bin)
        .into_iter()
        .filter(|p| {
            p.file_name().unwrap().to_string_lossy().starts_with("$R")
                && recycled_from(&info_of_recycled(p)) == Some(text(original))
        })
        .collect();
    assert_eq!(ours.len(), 1, "{ours:?} recycled from {}", text(original));
    ours.remove(0)
}

#[cfg(windows)]
fn bin_entries(bin: &Path) -> Vec<PathBuf> {
    fs::read_dir(bin)
        .map(|rd| {
            rd.flatten()
                .map(|e| PathBuf::from(text(&e.path())))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(windows)]
fn clean_and_wait(s: &Sandbox) -> String {
    let _ = fs::remove_file(s.run.join("decisions/1/status"));
    let out = cli(s, &["clean", &text(&s.run), "--decision", "1"]);
    assert!(
        out.status.success(),
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    common::wait_for("the worker", Duration::from_secs(60), || {
        fs::read_to_string(s.run.join("decisions/1/status")).unwrap_or_default() == "done\n"
    });
    common::assert_record_inside_ram_disk(&s.home);
    fs::read_to_string(s.run.join("clean.log")).unwrap_or_default()
}

#[cfg(windows)]
#[test]
fn the_recycle_bin_gets_an_r_and_i_pair_and_undo_removes_both() {
    let s = sandbox("trash-windows-pair");
    let a = s.home.join("AppData/Local/odd name 100%.cache");
    make(&a.join("nested"), 300);
    let a_ino = ino(&a);
    approve(&s, &[("rm", &a, 4096)]);
    clean(&s);

    assert!(!a.exists());
    let entry = record(&s).remove(0);
    let trashed = PathBuf::from(&entry.trashed);
    assert_eq!(
        trashed.parent(),
        Some(common::trash_dir(&s.home).as_path()),
        "{entry:?}"
    );
    assert_eq!((entry.ino, entry.state.as_str()), (a_ino, "trashed"));
    assert!(trashed.join("nested/data").exists());
    assert!(info_of_recycled(&trashed).is_file(), "the $I is written");

    let out = cli(&s, &["undo", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0), "{}", stdout(&out));
    assert!(stdout(&out).contains("restored: 1 items, 4096 bytes"));
    assert_eq!(ino(&a), a_ino, "the same item came back");
    assert!(!trashed.exists());
    assert!(!info_of_recycled(&trashed).exists(), "the $I goes with it");
    assert_eq!(record(&s)[0].state, "restored");
}

#[cfg(windows)]
#[test]
fn items_already_in_the_recycle_bin_are_removed_for_good_not_trashed_again() {
    let s = sandbox("trash-old-windows");
    let doomed = s.home.join("old.txt");
    fs::write(&doomed, b"old").unwrap();
    common::recycle_by_hand(&doomed);
    let old = recycled_by_hand(&common::trash_dir(&s.home), &doomed);
    let info = info_of_recycled(&old);
    assert!(info.is_file());
    approve(&s, &[("rm", &old, 4096)]);
    let dry = stdout(&cli(
        &s,
        &["clean", "--dry-run", &text(&s.run), "--decision", "1"],
    ));
    assert!(
        dry.contains(&format!("rm -rf -- '{}'\n", text(&old))),
        "{dry}"
    );
    clean(&s);
    assert!(!old.exists() && record(&s).is_empty());
    assert!(!info.exists(), "its $I goes with it");
}

#[cfg(windows)]
#[test]
fn the_confirm_plan_lists_trash_moves_apart_from_steps_that_cannot_be_undone_on_windows() {
    let s = sandbox("trash-preview-windows");
    let a = s.home.join("AppData/Local/a");
    make(&a, 100);
    let doomed = s.home.join("old");
    make(&doomed, 100);
    common::recycle_by_hand(&doomed);
    let old = recycled_by_hand(&common::trash_dir(&s.home), &doomed);
    let scan = scan_row("caches", "rm", &text(&a), 4096)
        + &scan_row("trash", "rm", &text(&old), 10)
        + "docker\tDocker\tD\treview\t0\tcmd\tdocker-prune\tdocker system prune -f\tcmd:docker-prune\t7\tn\t-\tvm\n";
    fs::write(s.run.join("scan.tsv"), scan).unwrap();
    let cats = disk_clean::review::load_scan(&s.run);
    let index =
        disk_clean::clean::index_scan(&disk_clean::util::read_lines(&s.run.join("scan.tsv")));
    let items = [
        serde_json::json!({"path": text(&a)}),
        serde_json::json!({"path": text(&old)}),
        serde_json::json!({"path": "cmd:docker-prune"}),
        serde_json::json!({"path": common::SYSTEM_FILE}),
    ];
    let plan = disk_clean::review::preview(&cats, &index, &items, &text(&s.home));
    let paths = plan["paths"].as_array().unwrap();
    let of = |p: &Path| paths.iter().find(|r| r["path"] == text(p)).unwrap();
    assert_eq!(of(&a)["bytes"], 4096);
    assert_eq!(of(&a)["trashed"], false);
    assert_eq!(of(&old)["trashed"], true, "already in a Recycle Bin");
    assert_eq!(plan["paths_bytes"], 4106);
    assert_eq!(plan["final"], serde_json::json!(["docker system prune -f"]));
    assert_eq!((&plan["count"], &plan["bytes"]), (&3.into(), &4113.into()));
    assert!(a.exists());
}

#[cfg(windows)]
#[test]
fn empty_removes_only_recorded_items_still_in_the_recycle_bin() {
    let s = sandbox("trash-empty-windows");
    let (a, b) = (
        s.home.join("AppData/Local/a"),
        s.home.join("AppData/Local/b"),
    );
    make(&a, 3000);
    make(&b, 100);
    approve(&s, &[("rm", &a, 4096)]);
    clean(&s);
    let bin = common::trash_dir(&s.home);
    let theirs_original = s.home.join("theirs.txt");
    fs::write(&theirs_original, b"the user's").unwrap();
    common::recycle_by_hand(&theirs_original);
    let theirs = recycled_by_hand(&bin, &theirs_original);
    let trashed = PathBuf::from(&record(&s)[0].trashed);

    let out = cli(&s, &["empty", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0), "{}", stdout(&out));
    assert!(stdout(&out).contains("emptied: 1 items, 4096 bytes"));
    assert!(!trashed.exists() && !info_of_recycled(&trashed).exists() && !a.exists());
    assert!(
        theirs.exists() && info_of_recycled(&theirs).exists() && b.exists(),
        "only our record is touched"
    );
    assert_eq!(record(&s)[0].state, "emptied");
    assert_eq!(cli(&s, &["empty", &text(&s.run)]).status.code(), Some(3));
}

#[cfg(windows)]
#[test]
fn a_tampered_record_or_swapped_junction_is_never_followed() {
    let s = sandbox("trash-tamper-windows");
    let caches = s.home.join("AppData/Local");
    let (a, b) = (caches.join("a/inner"), caches.join("b"));
    make(&a, 10);
    make(&b, 10);
    approve(&s, &[("rm", &a, 1), ("rm", &b, 2)]);
    clean(&s);
    let decoy = common::temp_dir("trash-tamper-decoy-windows");
    fs::rename(caches.join("a"), caches.join("a-moved")).unwrap();
    common::junction(&caches.join("a"), &decoy.0);
    let path = trash::record_path(&text(&s.home));
    let b_trashed = record(&s)[1].trashed.clone();
    let precious = caches.join("precious");
    make(&precious, 5);
    let tampered = fs::read_to_string(&path)
        .unwrap()
        .replace(&b_trashed, &text(&precious));
    fs::write(&path, tampered).unwrap();

    let out = cli(&s, &["undo", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0), "{}", stdout(&out));
    assert!(
        !decoy.0.join("inner").exists(),
        "never restored through a junction"
    );
    assert!(precious.join("data").exists());
    let entries = record(&s);
    assert!(
        entries[0].reason.contains("resolves elsewhere"),
        "{entries:?}"
    );
    assert_eq!(entries[0].state, "trashed");
    assert_eq!(entries[1].state, "failed", "{entries:?}");
    let out = cli(&s, &["empty", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0));
    assert!(precious.join("data").exists());
    assert!(
        Path::new(&b_trashed).exists(),
        "the real b is never touched by a tampered entry"
    );
    assert!(!Path::new(&entries[0].trashed).exists());
    fs::remove_dir_all(b_trashed).unwrap();
}

#[cfg(windows)]
const ADMINISTRATORS: &str = "S-1-5-32-544";

#[cfg(windows)]
fn scan_with_drive(s: &Sandbox, drive: &Path) -> String {
    let out = common::cli(
        &["scan", "--drives", &text(drive)[..1], &text(&s.run)],
        &s.home,
        &[
            ("DISK_CLEAN_SKIP_MAP", "1"),
            ("DISK_CLEAN_MIN_BYTES", "1"),
            ("DISK_CLEAN_NM_MIN_BYTES", "1"),
        ],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    fs::read_to_string(s.run.join("scan.tsv")).unwrap()
}

#[cfg(windows)]
fn categories_of(rows: &str, path: &Path) -> Vec<String> {
    let path = text(path);
    rows.lines()
        .map(|l| l.split('\t').collect::<Vec<_>>())
        .filter(|cols| cols.get(8) == Some(&path.as_str()))
        .map(|cols| cols[0].to_string())
        .collect()
}

#[cfg(windows)]
fn select(s: &Sandbox, paths: &[&Path]) {
    let items: Vec<String> = paths.iter().map(|p| item("rm", &text(p), 4096)).collect();
    fs::write(
        common::decision_file(&s.run),
        format!(r#"{{"items": [{}], "mode": "trash"}}"#, items.join(",")),
    )
    .unwrap();
}

#[cfg(windows)]
#[test]
fn a_project_folder_on_another_drive_goes_to_that_drives_recycle_bin_and_comes_back() {
    let s = sandbox("trash-windows-other-drive");
    let other = common::other_drive();
    let sid = common::user_sid();
    let code = other.0.join("code");
    let node_modules = code.join("app/node_modules");
    make(&node_modules.join("pkg"), 8192);
    let notes = code.join("notes");
    make(&notes, 8192);
    common::set_owner(&code, &sid);
    let shared = other.0.join("shared");
    let theirs = shared.join("app/node_modules");
    make(&theirs.join("pkg"), 8192);
    common::set_owner(&shared, ADMINISTRATORS);

    let rows = scan_with_drive(&s, &other.0);
    assert_eq!(
        categories_of(&rows, &node_modules),
        ["node-modules"],
        "{rows}"
    );
    assert!(categories_of(&rows, &notes).is_empty(), "{rows}");
    assert!(categories_of(&rows, &theirs).is_empty(), "{rows}");

    select(&s, &[&node_modules, &notes, &theirs]);
    let log = clean_and_wait(&s);
    let rejected = fs::read_to_string(s.run.join("decisions/1/rejected")).unwrap();
    for p in [&notes, &theirs] {
        assert!(
            rejected.contains(&format!("not in scan\t{}\n", text(p))),
            "{rejected}"
        );
        assert!(p.join("data").exists() || p.join("pkg/data").exists());
    }
    let entries = record(&s);
    assert_eq!(entries.len(), 1, "{entries:?}\n{log}");
    assert_eq!(entries[0].original, text(&node_modules));
    assert_eq!(
        Path::new(&entries[0].trashed).parent(),
        Some(common::recycle_bin(&other.0).as_path()),
        "{entries:?}"
    );
    assert!(!node_modules.exists());
    assert!(Path::new(&entries[0].trashed).join("pkg/data").exists());

    let out = cli(&s, &["undo", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0), "{}", stdout(&out));
    assert!(node_modules.join("pkg/data").exists(), "{}", stdout(&out));
    assert!(!Path::new(&entries[0].trashed).exists());
}

#[cfg(windows)]
#[test]
fn a_drive_root_and_never_walked_folders_on_another_drive_are_never_offered_or_allowed() {
    let s = sandbox("trash-windows-never-walked");
    let other = common::other_drive();
    let sid = common::user_sid();
    let tops = [
        "Windows",
        "Program Files",
        "Program Files (x86)",
        "ProgramData",
        "$WinREAgent",
        "Recovery",
        "PerfLogs",
        "code",
    ];
    let node_modules = |top: &str| other.0.join(top).join("app/node_modules");
    for top in tops {
        make(&node_modules(top).join("pkg"), 8192);
        common::set_owner(&other.0.join(top), &sid);
    }

    let rows = scan_with_drive(&s, &other.0);
    assert_eq!(
        categories_of(&rows, &node_modules("code")),
        ["node-modules"],
        "{rows}"
    );
    let never: Vec<PathBuf> = tops[..tops.len() - 1]
        .iter()
        .map(|top| node_modules(top))
        .collect();
    for p in &never {
        assert!(
            categories_of(&rows, p).is_empty(),
            "{}\n{rows}",
            p.display()
        );
    }

    let mut asked: Vec<&Path> = never.iter().map(PathBuf::as_path).collect();
    asked.push(&other.0);
    let listed: String = asked
        .iter()
        .map(|p| scan_row("node-modules", "rm", &text(p), 4096))
        .collect();
    fs::write(s.run.join("scan.tsv"), listed).unwrap();
    select(&s, &asked);
    let out = cli(&s, &["clean", &text(&s.run), "--decision", "1"]);
    assert_eq!(
        out.status.code(),
        Some(3),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let rejected = fs::read_to_string(s.run.join("decisions/1/rejected")).unwrap();
    for p in &never {
        assert!(
            rejected.contains(&format!("protected path\t{}\n", text(p))),
            "{rejected}"
        );
        assert!(p.join("pkg/data").exists());
    }
    assert!(
        rejected.contains(&format!("not a canonical path\t{}\n", text(&other.0))),
        "{rejected}"
    );
    assert!(record(&s).is_empty());
}

#[cfg(windows)]
#[test]
fn an_item_on_a_drive_mounted_in_a_folder_is_never_deleted_for_good() {
    let s = sandbox("trash-windows-folder-mount");
    let mounted = common::folder_volume(&s.home.join("mnt"));
    let a = mounted.0.join("a");
    make(&a, 100);
    approve(&s, &[("rm", &a, 4096)]);
    let log = clean_and_wait(&s);
    let trashed: Vec<trash::Entry> = record(&s)
        .into_iter()
        .filter(|e| e.state == "trashed")
        .collect();
    assert!(
        a.join("data").exists()
            || trashed
                .iter()
                .any(|e| Path::new(&e.trashed).join("data").exists()),
        "kept or in a Recycle Bin, never gone\n{log}"
    );
    if !trashed.is_empty() {
        assert_eq!(cli(&s, &["undo", &text(&s.run)]).status.code(), Some(0));
        assert!(a.join("data").exists(), "{log}");
    }
}

#[cfg(windows)]
#[test]
fn undo_onto_a_path_that_came_back_keeps_the_item_and_its_i_file() {
    let s = sandbox("trash-windows-conflict");
    let a = s.home.join("AppData/Local/a");
    make(&a, 100);
    approve(&s, &[("rm", &a, 4096)]);
    clean(&s);
    let trashed = PathBuf::from(&record(&s)[0].trashed);
    make(&a, 9);
    let out = cli(&s, &["undo", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0));
    assert!(
        stdout(&out).contains("still in the Trash: 1"),
        "{}",
        stdout(&out)
    );
    assert_eq!(
        fs::read(a.join("data")).unwrap().len(),
        9,
        "never overwritten"
    );
    assert_eq!(fs::read(trashed.join("data")).unwrap().len(), 100);
    assert!(info_of_recycled(&trashed).is_file(), "the $I stays");
    let entry = &record(&s)[0];
    assert_eq!(
        (entry.state.as_str(), entry.reason.as_str()),
        ("trashed", trash::STILL_THERE)
    );
}

#[cfg(windows)]
#[test]
fn an_explorer_restore_or_empty_is_picked_up_by_sync() {
    let s = sandbox("trash-windows-sync");
    let (put, gone, kept) = (
        s.home.join("AppData/Local/put"),
        s.home.join("AppData/Local/gone"),
        s.home.join("AppData/Local/kept"),
    );
    for p in [&put, &gone, &kept] {
        make(p, 10);
    }
    approve(&s, &[("rm", &put, 1), ("rm", &gone, 2), ("rm", &kept, 3)]);
    clean(&s);
    let at = |name: &str| {
        record(&s)
            .into_iter()
            .find(|e| e.original.ends_with(name))
            .unwrap()
    };
    let put_trashed = PathBuf::from(at("/put").trashed);
    fs::rename(&put_trashed, &put).unwrap();
    fs::remove_file(info_of_recycled(&put_trashed)).unwrap();
    let gone_trashed = PathBuf::from(at("/gone").trashed);
    fs::remove_dir_all(&gone_trashed).unwrap();
    fs::remove_file(info_of_recycled(&gone_trashed)).unwrap();

    let out = cli(
        &s,
        &["clean", "--dry-run", &text(&s.run), "--decision", "1"],
    );
    assert!(out.status.code().is_some());
    assert_eq!(at("/put").state, "put-back");
    assert_eq!(at("/gone").state, "emptied");
    assert_eq!(at("/kept").state, "trashed");
    let out = cli(&s, &["empty", &text(&s.run)]);
    assert!(
        stdout(&out).contains("emptied: 1 items"),
        "{}",
        stdout(&out)
    );
    assert!(put.join("data").exists(), "never acted on twice");
    assert_eq!(cli(&s, &["undo", &text(&s.run)]).status.code(), Some(3));
}

#[cfg(windows)]
#[test]
fn an_item_held_open_by_another_program_is_kept_and_reported_in_use() {
    use std::os::windows::fs::OpenOptionsExt;
    let s = sandbox("trash-windows-in-use");
    let caches = s.home.join("AppData/Local");
    fs::create_dir_all(&caches).unwrap();
    let (held, free) = (caches.join("held.log"), caches.join("free"));
    fs::write(&held, b"open").unwrap();
    make(&free, 10);
    let handle = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&held)
        .unwrap();
    approve(&s, &[("rm", &held, 4096), ("rm", &free, 4096)]);
    let log = clean_and_wait(&s);
    drop(handle);
    assert_eq!(fs::read(&held).unwrap(), b"open", "kept\n{log}");
    assert!(!free.exists(), "the rest still moves\n{log}");
    let failed = named(&s.run, "failed");
    assert_eq!(failed.len(), 1, "{failed:?}");
    assert_eq!(failed[0]["path"], text(&held));
    assert!(
        failed[0]["reason"].as_str().unwrap().contains("in use"),
        "{}",
        failed[0]
    );
    assert!(log.contains("in use"), "{log}");
}

#[cfg(windows)]
#[test]
fn an_item_larger_than_the_recycle_bin_is_kept() {
    let s = sandbox("trash-windows-too-big");
    let caches = s.home.join("AppData/Local");
    fs::create_dir_all(&caches).unwrap();
    let big = caches.join("big.bin");
    fs::File::create(&big)
        .unwrap()
        .set_len(600 * 1024 * 1024)
        .unwrap();
    approve(&s, &[("rm", &big, 600 * 1024 * 1024)]);
    let log = clean_and_wait(&s);
    assert!(big.is_file(), "never deleted for good\n{log}");
    assert!(
        log.contains("NOT TRASHED") && log.contains("larger than the Recycle Bin on this drive"),
        "{log}"
    );
    assert!(record(&s).iter().all(|e| e.state != "trashed"));
    fs::remove_file(big).unwrap();
}

#[cfg(windows)]
#[test]
fn a_path_longer_than_260_characters_is_trashed_and_restored() {
    let s = sandbox("trash-windows-long");
    let segment = "d".repeat(100);
    let deep = s
        .home
        .join("AppData/Local")
        .join(&segment)
        .join(&segment)
        .join(&segment);
    assert!(text(&deep).len() > 260);
    make(&deep, 100);
    approve(&s, &[("rm", &deep, 4096)]);
    clean(&s);
    assert!(!deep.exists());
    let entry = record(&s).remove(0);
    assert_eq!(
        (entry.original.as_str(), entry.state.as_str()),
        (text(&deep).as_str(), "trashed")
    );
    let out = cli(&s, &["undo", &text(&s.run)]);
    assert_eq!(out.status.code(), Some(0), "{}", stdout(&out));
    assert_eq!(fs::read(deep.join("data")).unwrap().len(), 100);
}
