mod common;

use disk_clean::selection::{Listed, decode, fingerprint, short_token};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
#[cfg(unix)]
use std::process::Command;
use std::process::Stdio;

fn request(port: u16, raw: String) -> (u16, String) {
    let mut s = common::connect(port);
    s.set_read_timeout(Some(std::time::Duration::from_secs(60)))
        .unwrap();
    s.write_all(raw.as_bytes()).unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    let status = out.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = out
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or_default();
    (status, body)
}

fn get(port: u16, target: &str) -> (u16, String) {
    request(
        port,
        format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
    )
}

fn post(port: u16, body: &str) -> u16 {
    post_to(port, "/decide", body)
}

#[test]
fn review_serves_page_and_writes_selection() {
    let t = common::temp_dir("review");
    let run = t.0.join("run");
    fs::create_dir_all(&run).unwrap();
    let home = t.0.join("h");
    fs::create_dir_all(&home).unwrap();
    let h = common::text(&home);
    let rows = [
        format!(
            "caches\tApplication caches\tdesc\tsafe\t1\trm\t-\t~/Library/Caches/a\t{h}/Library/Caches/a\t2048\tnote\t3\texact"
        ),
        format!(
            "caches\tApplication caches\tdesc\tsafe\t1\trm\t-\t~/Library/Caches/b\t{h}/Library/Caches/b\t4096\tnote\t-\texact"
        ),
        format!(
            "big-files\tLarge files (report only)\tdesc\treport\t0\trm\t-\t~/big.iso\t{h}/big.iso\t9999999\tReview manually.\t10\texact"
        ),
        "docker\tDocker\tdesc\treview\t0\tcmd\tdocker-prune\tdocker system prune -f\tcmd:docker-prune\t1000\tnote\t-\tvm"
            .to_string(),
    ];
    fs::write(run.join("scan.tsv"), rows.join("\n") + "\n").unwrap();
    fs::write(
        run.join("map.tsv"),
        format!("500\t{h}/Library\n1000\t7\t1700000000\t{h}\n"),
    )
    .unwrap();
    fs::write(
        run.join("disk.tsv"),
        "total\t100000\nused\t60000\nfree\t40000\nhome\t1000\nsnapshots\t0\n",
    )
    .unwrap();
    fs::write(
        run.join("clean.events"),
        r#"{"event":"started","run":"old","free":1,"paths":1,"worktrees":0,"commands":0,"bytes":1,"elapsed_ms":0}"#,
    )
    .unwrap();
    fs::write(run.join("status"), "done\n").unwrap();

    let mut child = common::reaped(
        common::bin(&home)
            .args(["review", &common::text(&run)])
            .env("DISK_CLEAN_NO_BROWSER", "1")
            .env("DISK_CLEAN_WATCH_START", "3")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    );
    let mut stderr = BufReader::new(child.stderr.take().unwrap());
    let mut line = String::new();
    stderr.read_line(&mut line).unwrap();
    let url = line
        .trim()
        .strip_prefix("review UI: ")
        .expect("url line")
        .to_string();
    let port: u16 = url
        .trim_end_matches('/')
        .rsplit(':')
        .next()
        .unwrap()
        .parse()
        .unwrap();

    let (status, page) = get(port, "/");
    assert_eq!(status, 200);
    assert!(!page.contains("__DATA__") && !page.contains("__TOKEN__"));
    let json = page
        .split_once(r#"<script id="disk-clean-data" type="application/json">"#)
        .and_then(|(_, rest)| rest.split_once("</script>"))
        .map(|(json, _)| json)
        .expect("data script");
    let data: Value = serde_json::from_str(json).unwrap();
    assert_eq!(data["categories"][0]["id"], "caches");
    assert_eq!(data["categories"][0]["bytes"], 6144);
    assert_eq!(
        data["categories"][0]["items"][0]["path"],
        format!("{h}/Library/Caches/b")
    );
    assert_eq!(data["categories"][0]["items"][0]["age"], Value::Null);
    assert_eq!(
        data["categories"].as_array().unwrap().last().unwrap()["id"],
        "big-files"
    );
    assert_eq!(data["reclaimable"], 6144);
    assert_eq!(data["total"], 100000);
    assert_eq!(data["tree"]["name"], "~");
    assert_eq!(data["tree"]["children"][1]["rest"], true);
    assert_eq!(data["tree"]["files"], 7);
    assert_eq!(data["tree"]["mtime"], 1700000000);
    assert_eq!(data["tree"]["children"][0]["files"], 0);
    assert_eq!(data["insights"], Value::Null);
    let token = page
        .split_once(r#"<meta name="disk-clean-token" content=""#)
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(token, _)| token.to_string())
        .expect("token meta");
    assert_eq!(token.len(), 22);

    assert_eq!(get(port, "/favicon.ico").0, 204);
    assert_eq!(
        post(
            port,
            r#"{"token": "wrong", "decision": "approve", "items": []}"#
        ),
        403
    );
    assert_eq!(post(port, "not json"), 400);

    let raw_preview = |body: String| {
        format!(
            "POST /preview HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
    };
    assert_eq!(
        request(
            port,
            raw_preview(r#"{"token": "wrong", "add": "", "drop": ""}"#.to_string())
        )
        .0,
        403
    );
    let (a, iso) = (format!("{h}/Library/Caches/a"), format!("{h}/big.iso"));
    let (status, body) = request(
        port,
        raw_preview(picks_body(
            &token,
            "",
            &run,
            &[&a, &iso, "cmd:docker-prune"],
            None,
        )),
    );
    assert_eq!(status, 200);
    let plan: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(plan["final"], serde_json::json!(["docker system prune -f"]));
    assert_eq!(plan["final_count"], 1);
    assert_eq!(plan["paths"], serde_json::json!([]));
    assert_eq!(plan["rejected"][0]["path"], format!("{h}/Library/Caches/a"));
    assert_eq!(plan["rejected"][0]["reason"], "already gone");
    assert_eq!(plan["count"], 1);
    assert!(!run.join("selection.json").exists());

    let approve = picks_body(
        &token,
        "approve",
        &run,
        &[&a, &iso, "/etc/passwd", "cmd:docker-prune"],
        None,
    );
    let mut stale: Value = serde_json::from_str(&approve).unwrap();
    stale["fingerprint"] = Value::from("0");
    let (status, reason) = post_reply(port, "/decide", &stale.to_string());
    assert_eq!(
        status, 409,
        "a selection decoded differently from the page is refused"
    );
    assert!(reason.contains("the list changed"), "{reason}");
    assert_eq!(post(port, &approve), 200);
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(0));
    let mut stdout = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    assert_eq!(stdout.trim(), common::text(&run.join("selection.json")));

    let sel: Value =
        serde_json::from_str(&fs::read_to_string(run.join("selection.json")).unwrap()).unwrap();
    let paths: Vec<&str> = sel["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["path"].as_str().unwrap())
        .collect();
    assert_eq!(
        paths,
        [format!("{h}/Library/Caches/a").as_str(), "cmd:docker-prune"]
    );
    assert_eq!(sel["items"][1]["cmd_id"], "docker-prune");
    assert_eq!(sel["items"][1]["action"], "cmd");
    assert_eq!(sel["items"][0]["category"], "caches");
    assert_eq!(sel["items"][1]["category"], "docker");
    assert_eq!(sel["total_bytes"], 3048);

    assert!(
        !run.join("clean.events").exists() && !run.join("status").exists(),
        "a new approval clears the previous cleanup's events and status"
    );
    let after = events(port, &token, "waiting");
    assert_eq!(
        after[0].0, "waiting",
        "a watcher keeps serving the page's events after review exits"
    );
    assert_eq!(
        post(port, &approve),
        405,
        "the watcher accepts no decisions"
    );
}

#[test]
fn review_exits_3_when_nothing_found() {
    let t = common::temp_dir("review-cancel");
    let run = t.0.join("run");
    fs::create_dir_all(&run).unwrap();
    fs::write(run.join("scan.tsv"), "").unwrap();
    let out = common::output(
        common::bin(&t.0)
            .args(["review", &common::text(&run)])
            .env("DISK_CLEAN_NO_BROWSER", "1"),
    );
    assert_eq!(out.status.code(), Some(3));
}

#[test]
fn render_keeps_hostile_paths_inside_the_data_script() {
    let data =
        serde_json::json!({"path": "/tmp/</script><script>alert(1)</script>", "also": "__TOKEN__"});
    let page = clean_disk_render(&data);
    let (_, rest) = page
        .split_once(r#"<script id="disk-clean-data" type="application/json">"#)
        .expect("data script");
    let (json, _) = rest.split_once("</script>").expect("script end");
    let parsed: Value = serde_json::from_str(json).unwrap();
    assert_eq!(parsed, data);
    assert!(!json.contains('<'), "{json}");
    assert!(page.contains(r#"<meta name="disk-clean-token" content="tok""#));
}

#[test]
fn render_tells_the_page_its_platform() {
    let page = clean_disk_render(&serde_json::json!({}));
    let meta = format!(
        r#"<meta name="disk-clean-platform" content="{}""#,
        std::env::consts::OS
    );
    assert!(page.contains(&meta), "{meta}");
}

fn clean_disk_render(data: &Value) -> String {
    disk_clean::review::render(data, "tok")
}

fn events(port: u16, token: &str, until: &str) -> Vec<(String, Value)> {
    read_until(&mut open_events(port, token), until)
}

fn open_events(port: u16, token: &str) -> BufReader<TcpStream> {
    let mut s = common::connect(port);
    s.set_read_timeout(Some(std::time::Duration::from_secs(30)))
        .unwrap();
    write!(
        s,
        "GET /events?token={token} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"
    )
    .unwrap();
    let mut reader = BufReader::new(s);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert!(line.starts_with("HTTP/1.1 200"), "{line}");
    reader
}

fn latest_growing(events: &[(String, Value)]) -> Vec<(String, Value)> {
    let last = events.iter().rposition(|(n, _)| n == "growing");
    events
        .iter()
        .enumerate()
        .filter(|(i, (n, _))| n != "growing" || Some(*i) == last)
        .map(|(_, e)| e.clone())
        .collect()
}

const EVENTS_WAIT: std::time::Duration = std::time::Duration::from_secs(300);

fn read_until(reader: &mut BufReader<TcpStream>, until: &str) -> Vec<(String, Value)> {
    let deadline = std::time::Instant::now() + EVENTS_WAIT;
    let mut line = String::new();
    let mut out = Vec::new();
    let mut name = String::new();
    loop {
        assert!(
            std::time::Instant::now() < deadline,
            "no {until} event within {EVENTS_WAIT:?}; got {out:?}"
        );
        line.clear();
        assert!(reader.read_line(&mut line).unwrap() > 0, "stream ended");
        let line = line.trim_end();
        if let Some(n) = line.strip_prefix("event: ") {
            name = n.to_string();
        } else if let Some(d) = line.strip_prefix("data: ") {
            assert_ne!(name, "error", "the scan failed: {d}");
            if name != "replayed" {
                out.push((name.clone(), serde_json::from_str(d).unwrap()));
            }
            if name == until {
                return out;
            }
        }
    }
}

fn post_to(port: u16, route: &str, body: &str) -> u16 {
    let raw = format!(
        "POST {route} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    request(port, raw).0
}

#[cfg(target_os = "macos")]
#[test]
fn review_without_run_dir_streams_the_scan() {
    let t = common::temp_dir("live");
    let home = t.0.join("home");
    let bin = t.0.join("bin");
    let gate = t.0.join("gate");
    fs::create_dir_all(home.join("Library/Caches/app")).unwrap();
    fs::write(home.join("Library/Caches/app/blob"), vec![7u8; 64 * 1024]).unwrap();
    fs::create_dir_all(home.join("code")).unwrap();
    common::sh(
        &home.join("code"),
        "git init -q -b main repo && cd repo && echo a >a && git add a && git commit -qm init && git worktree add -q -b wt ../wt main",
    );
    blocking_docker(&bin, &gate);
    let (mut child, port, token) = spawn_live(&home, &bin);

    let (status, page) = get(port, "/");
    assert_eq!(status, 200);
    let json = page
        .split_once(r#"<script id="disk-clean-data" type="application/json">"#)
        .and_then(|(_, rest)| rest.split_once("</script>"))
        .map(|(json, _)| json)
        .expect("data script");
    let data = serde_json::from_str::<Value>(json).unwrap();
    assert_eq!(data["live"], true);
    assert_eq!(data["trash"], serde_json::json!([]));
    assert!(data["run"].as_str().unwrap().starts_with("run-"), "{data}");
    assert!(page.contains(&token));
    assert_eq!(get(port, "/events?token=wrong").0, 403);

    let mut first = latest_growing(&events(port, &token, "walked"));
    let run = live_run(&home);
    let caught_up = events(port, &token, "replayed");
    assert!(
        caught_up.len() >= first.len() - 1 && caught_up.iter().all(|(n, _)| n != "replayed"),
        "a connection replays its backlog, then says it has caught up"
    );
    let listed = Some(lines_in(&run));
    assert_eq!(
        post_to(port, "/preview", &picks_body(&token, "", &run, &[], listed)),
        200
    );
    assert_eq!(
        post_to(
            port,
            "/decide",
            &picks_body(&token, "approve", &run, &[], listed)
        ),
        409
    );
    fs::write(&gate, "").unwrap();
    let rest = events(port, &token, "done");
    let replay_of_first = rest[..first.len()].to_vec();
    assert_eq!(
        replay_of_first, first,
        "a new connection replays from the start"
    );
    first = rest;

    let docker_rows: Vec<&(String, Value)> = first
        .iter()
        .filter(|(n, d)| {
            d["item"]["path"] == "cmd:docker-prune"
                || (n == "unlisted" && d["path"] == "cmd:docker-prune")
        })
        .collect();
    assert_eq!(docker_rows.len(), 2, "{docker_rows:?}");
    assert_eq!(docker_rows[0].1["item"]["checking"], true);
    assert_eq!(docker_rows[1].0, "unlisted", "docker answered nothing");
    let wt = home.join("code/wt");
    let wt_rows: Vec<&Value> = first
        .iter()
        .filter(|(n, d)| n == "item" && d["item"]["path"] == wt.to_str().unwrap())
        .map(|(_, d)| d)
        .collect();
    assert_eq!(wt_rows[0]["item"]["checking"], true, "{wt_rows:?}");
    assert!(wt_rows.last().unwrap()["item"].get("checking").is_none());
    let whole = first.clone();
    first.retain(|(n, d)| n != "unlisted" && d["item"]["checking"] != true);

    let names: Vec<&str> = first.iter().map(|(n, _)| n.as_str()).collect();
    let walked = names.iter().position(|n| *n == "walked").unwrap();
    assert_eq!(names[0], "disk");
    assert_eq!(names.last(), Some(&"done"));
    assert_eq!(names.iter().filter(|n| **n == "walked").count(), 1);
    assert!(
        names[1..walked]
            .iter()
            .all(|n| *n == "item" || *n == "progress" || *n == "growing"),
        "{names:?}"
    );
    assert!(
        names[walked + 1..names.len() - 1]
            .iter()
            .all(|n| *n == "item")
    );
    let mut last = 0;
    for (name, data) in &first {
        let ms = data["elapsed_ms"]
            .as_u64()
            .unwrap_or_else(|| panic!("{name} lacks elapsed_ms"));
        assert!(ms >= last, "{name} went back in time");
        last = ms;
    }
    assert!(first[walked].1["worktrees"].as_u64().unwrap() <= 1);
    let item = |path: &Path| {
        first
            .iter()
            .position(|(n, d)| n == "item" && d["item"]["path"] == path.to_str().unwrap())
            .unwrap_or_else(|| panic!("no item for {}", path.display()))
    };
    let cache = home.join("Library/Caches/app");
    let first_progress = names
        .iter()
        .position(|n| *n == "progress")
        .unwrap_or(walked);
    assert!(
        item(&cache) < first_progress,
        "fixed locations come before the walk"
    );
    item(&home.join("code/wt"));
    assert_eq!(first[item(&cache)].1["category"]["id"], "caches");
    assert_eq!(first[item(&cache)].1["item"]["preselect"], true);

    let second = events(port, &token, "done");
    assert_eq!(second, whole, "a reconnect replays every event");

    let lines: Vec<u64> = first
        .iter()
        .filter_map(|(_, d)| d["item"]["line"].as_u64())
        .collect();
    assert_eq!(
        lines,
        (1..=lines.len() as u64).collect::<Vec<_>>(),
        "every recorded item carries its line in scan.tsv"
    );
    assert_eq!(
        post_to(port, "/preview", &picks_body(&token, "", &run, &[], None)),
        200
    );
    let approve = picks_body(&token, "approve", &run, &[cache.to_str().unwrap()], None);
    assert_eq!(post_to(port, "/decide", &approve), 200);
    assert_eq!(child.wait().unwrap().code(), Some(0));
    let mut stdout = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    let lines: Vec<&str> = stdout.lines().collect();
    let run = Path::new(lines[0]);
    assert!(run.starts_with(home.join(".cache/disk-clean")), "{stdout}");
    assert!(run.join("scan.tsv").is_file() && run.join("disk.tsv").is_file());
    assert_eq!(Path::new(lines[1]), run.join("selection.json"));
    let sel = fs::read_to_string(run.join("selection.json")).unwrap();
    assert!(sel.contains(cache.to_str().unwrap()));
}

#[cfg(target_os = "linux")]
#[test]
fn review_without_run_dir_streams_the_scan_on_linux() {
    let t = common::temp_dir("live");
    let home = t.0.join("home");
    let bin = t.0.join("bin");
    let gate = t.0.join("gate");
    fs::create_dir_all(home.join(".cache/app")).unwrap();
    fs::write(home.join(".cache/app/blob"), vec![7u8; 64 * 1024]).unwrap();
    fs::create_dir_all(home.join("code")).unwrap();
    common::sh(
        &home.join("code"),
        "git init -q -b main repo && cd repo && echo a >a && git add a && git commit -qm init && git worktree add -q -b wt ../wt main",
    );
    blocking_docker(&bin, &gate);
    let (mut child, port, token) = spawn_live(&home, &bin);

    let (status, page) = get(port, "/");
    assert_eq!(status, 200);
    let json = page
        .split_once(r#"<script id="disk-clean-data" type="application/json">"#)
        .and_then(|(_, rest)| rest.split_once("</script>"))
        .map(|(json, _)| json)
        .expect("data script");
    let data = serde_json::from_str::<Value>(json).unwrap();
    assert_eq!(data["live"], true);
    assert_eq!(data["trash"], serde_json::json!([]));
    assert!(data["run"].as_str().unwrap().starts_with("run-"), "{data}");
    assert!(page.contains(&token));
    assert_eq!(get(port, "/events?token=wrong").0, 403);

    let mut first = latest_growing(&events(port, &token, "walked"));
    let run = live_run(&home);
    let caught_up = events(port, &token, "replayed");
    assert!(
        caught_up.len() >= first.len() - 1 && caught_up.iter().all(|(n, _)| n != "replayed"),
        "a connection replays its backlog, then says it has caught up"
    );
    let listed = Some(lines_in(&run));
    assert_eq!(
        post_to(port, "/preview", &picks_body(&token, "", &run, &[], listed)),
        200
    );
    assert_eq!(
        post_to(
            port,
            "/decide",
            &picks_body(&token, "approve", &run, &[], listed)
        ),
        409
    );
    fs::write(&gate, "").unwrap();
    let rest = events(port, &token, "done");
    let replay_of_first = rest[..first.len()].to_vec();
    assert_eq!(
        replay_of_first, first,
        "a new connection replays from the start"
    );
    first = rest;

    let docker_rows: Vec<&(String, Value)> = first
        .iter()
        .filter(|(n, d)| {
            d["item"]["path"] == "cmd:docker-prune"
                || (n == "unlisted" && d["path"] == "cmd:docker-prune")
        })
        .collect();
    assert_eq!(docker_rows.len(), 2, "{docker_rows:?}");
    assert_eq!(docker_rows[0].1["item"]["checking"], true);
    assert_eq!(docker_rows[1].0, "unlisted", "docker answered nothing");
    let wt = home.join("code/wt");
    let wt_rows: Vec<&Value> = first
        .iter()
        .filter(|(n, d)| n == "item" && d["item"]["path"] == wt.to_str().unwrap())
        .map(|(_, d)| d)
        .collect();
    assert_eq!(wt_rows[0]["item"]["checking"], true, "{wt_rows:?}");
    assert!(wt_rows.last().unwrap()["item"].get("checking").is_none());
    let whole = first.clone();
    first.retain(|(n, d)| n != "unlisted" && d["item"]["checking"] != true);

    let names: Vec<&str> = first.iter().map(|(n, _)| n.as_str()).collect();
    let walked = names.iter().position(|n| *n == "walked").unwrap();
    assert_eq!(names[0], "disk");
    assert_eq!(names.last(), Some(&"done"));
    assert_eq!(names.iter().filter(|n| **n == "walked").count(), 1);
    assert!(
        names[1..walked]
            .iter()
            .all(|n| *n == "item" || *n == "progress" || *n == "growing"),
        "{names:?}"
    );
    assert!(
        names[walked + 1..names.len() - 1]
            .iter()
            .all(|n| *n == "item")
    );
    let mut last = 0;
    for (name, data) in &first {
        let ms = data["elapsed_ms"]
            .as_u64()
            .unwrap_or_else(|| panic!("{name} lacks elapsed_ms"));
        assert!(ms >= last, "{name} went back in time");
        last = ms;
    }
    assert!(first[walked].1["worktrees"].as_u64().unwrap() <= 1);
    let item = |path: &Path| {
        first
            .iter()
            .position(|(n, d)| n == "item" && d["item"]["path"] == path.to_str().unwrap())
            .unwrap_or_else(|| panic!("no item for {}", path.display()))
    };
    let cache = home.join(".cache/app");
    let first_progress = names
        .iter()
        .position(|n| *n == "progress")
        .unwrap_or(walked);
    assert!(
        item(&cache) < first_progress,
        "fixed locations come before the walk"
    );
    item(&home.join("code/wt"));
    assert_eq!(
        first[item(&cache)].1["item"]["preselect"],
        false,
        "an unnamed child of ~/.cache is shown, not ticked"
    );

    let second = events(port, &token, "done");
    assert_eq!(second, whole, "a reconnect replays every event");

    let lines: Vec<u64> = first
        .iter()
        .filter_map(|(_, d)| d["item"]["line"].as_u64())
        .collect();
    assert_eq!(
        lines,
        (1..=lines.len() as u64).collect::<Vec<_>>(),
        "every recorded item carries its line in scan.tsv"
    );
    assert_eq!(
        post_to(port, "/preview", &picks_body(&token, "", &run, &[], None)),
        200
    );
    let approve = picks_body(&token, "approve", &run, &[cache.to_str().unwrap()], None);
    assert_eq!(post_to(port, "/decide", &approve), 200);
    assert_eq!(child.wait().unwrap().code(), Some(0));
    let mut stdout = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    let lines: Vec<&str> = stdout.lines().collect();
    let run = Path::new(lines[0]);
    assert!(run.starts_with(home.join(".cache/disk-clean")), "{stdout}");
    assert!(run.join("scan.tsv").is_file() && run.join("disk.tsv").is_file());
    assert_eq!(Path::new(lines[1]), run.join("selection.json"));
    let sel = fs::read_to_string(run.join("selection.json")).unwrap();
    assert!(sel.contains(cache.to_str().unwrap()));
}

#[cfg(unix)]
fn spawn_live(home: &Path, bin: &Path) -> (common::Reaped, u16, String) {
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
    let mut child = common::reaped(
        common::bin(home)
            .arg("review")
            .env("PATH", path)
            .env("DISK_CLEAN_SKIP_MAP", "1")
            .env("DISK_CLEAN_WATCH_START", "1")
            .env("DISK_CLEAN_NO_BROWSER", "1")
            .env("DISK_CLEAN_MIN_BYTES", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    );
    let mut stderr = BufReader::new(child.stderr.take().unwrap());
    let url = loop {
        let mut line = String::new();
        assert!(stderr.read_line(&mut line).unwrap() > 0, "no url line");
        if let Some(url) = line.trim().strip_prefix("review UI: ") {
            break url.to_string();
        }
    };
    std::thread::spawn(move || std::io::copy(&mut stderr, &mut std::io::sink()));
    let port: u16 = url
        .trim_end_matches('/')
        .rsplit(':')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let (_, page) = get(port, "/");
    let reported = page
        .split_once(r#"<meta name="disk-clean-home" content=""#)
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(home, _)| home.to_string())
        .expect("home meta");
    assert_eq!(
        Path::new(&reported).canonicalize().unwrap(),
        home.canonicalize().unwrap()
    );
    let token = page
        .split_once(r#"<meta name="disk-clean-token" content=""#)
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(token, _)| token.to_string())
        .expect("token meta");
    (child, port, token)
}

#[cfg(unix)]
#[test]
fn rescan_restarts_the_scan_in_place() {
    let t = common::temp_dir("rescan");
    let home = t.0.join("home");
    let bin = t.0.join("bin");
    let gate = t.0.join("gate");
    let old = common::app_caches(&home).join("old");
    let new = common::app_caches(&home).join("new");
    fs::create_dir_all(&old).unwrap();
    fs::write(old.join("blob"), vec![7u8; 64 * 1024]).unwrap();
    blocking_docker(&bin, &gate);
    let (mut child, port, token) = spawn_live(&home, &bin);
    let rescan = |token: &str| post_to(port, "/rescan", &format!(r#"{{"token": "{token}"}}"#));
    let preview = || {
        let run = live_run(&home);
        let listed = Some(lines_in(&run));
        post_to(port, "/preview", &picks_body(&token, "", &run, &[], listed))
    };

    assert_eq!(rescan("wrong"), 403);
    assert_eq!(rescan(&token), 409, "a scan is running");
    let mut stream = open_events(port, &token);
    fs::write(&gate, "").unwrap();
    let first = read_until(&mut stream, "done");
    assert_eq!(preview(), 200);

    fs::remove_file(&gate).unwrap();
    fs::remove_dir_all(&old).unwrap();
    fs::create_dir_all(&new).unwrap();
    fs::write(new.join("blob"), vec![7u8; 64 * 1024]).unwrap();
    assert_eq!(rescan(&token), 202);
    assert_eq!(rescan(&token), 409, "the rescan is running");
    let head = read_until(&mut stream, "rescan");
    assert_eq!(
        head.len(),
        1,
        "nothing of the old scan is sent again: {head:?}"
    );
    assert_eq!(head[0].1["elapsed_ms"], 0);
    assert_eq!(preview(), 200);
    let run = live_run(&home);
    assert_eq!(
        post_to(
            port,
            "/decide",
            &picks_body(&token, "approve", &run, &[], Some(lines_in(&run)))
        ),
        409
    );
    fs::write(&gate, "").unwrap();
    let second = read_until(&mut stream, "done");
    assert_eq!(second[0].0, "disk");
    assert_eq!(second.iter().filter(|(n, _)| n == "done").count(), 1);
    let paths = |events: &[(String, Value)]| -> Vec<String> {
        events
            .iter()
            .filter(|(n, _)| n == "item")
            .filter_map(|(_, d)| d["item"]["path"].as_str().map(String::from))
            .collect()
    };
    assert!(paths(&first).contains(&old.display().to_string()));
    assert!(paths(&second).contains(&new.display().to_string()));
    assert!(!paths(&second).contains(&old.display().to_string()));
    let mut last = 0;
    for (name, data) in &second {
        let ms = data["elapsed_ms"].as_u64().unwrap();
        assert!(ms >= last, "{name} went back in time");
        last = ms;
    }

    let replay = events(port, &token, "done");
    assert_eq!(
        replay[0].0, "rescan",
        "a reconnect replays only the current scan"
    );
    assert_eq!(replay[1..], latest_growing(&second)[..]);
    assert_eq!(preview(), 200);

    let approve = picks_body(
        &token,
        "approve",
        &run,
        &[old.to_str().unwrap(), new.to_str().unwrap()],
        None,
    );
    assert_eq!(post_to(port, "/decide", &approve), 200);
    assert_eq!(child.wait().unwrap().code(), Some(0));
    let mut stdout = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    let run = Path::new(stdout.lines().next().unwrap());
    let sel: Value =
        serde_json::from_str(&fs::read_to_string(run.join("selection.json")).unwrap()).unwrap();
    let chosen: Vec<&str> = sel["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["path"].as_str().unwrap())
        .collect();
    assert_eq!(chosen, [new.to_str().unwrap()]);
}

fn finished_review(tag: &str) -> (common::TempDir, common::Reaped, u16, String) {
    let t = common::temp_dir(tag);
    let home = t.0.join("h");
    let run = t.0.join("run");
    let cache = home.join("Library/Caches/a");
    fs::create_dir_all(&cache).unwrap();
    fs::create_dir_all(&run).unwrap();
    fs::write(
        run.join("scan.tsv"),
        format!(
            "caches\tApplication caches\tdesc\tsafe\t1\trm\t-\t~/Library/Caches/a\t{}\t2048\tnote\t3\texact\n",
            common::text(&cache)
        ),
    )
    .unwrap();
    let mut child = common::reaped(
        common::bin(&home)
            .args(["review", &common::text(&run)])
            .env("DISK_CLEAN_NO_BROWSER", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    );
    let mut stderr = BufReader::new(child.stderr.take().unwrap());
    let mut line = String::new();
    stderr.read_line(&mut line).unwrap();
    let port: u16 = line
        .trim()
        .trim_end_matches('/')
        .rsplit(':')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    std::thread::spawn(move || std::io::copy(&mut stderr, &mut std::io::sink()));
    let (_, page) = get(port, "/");
    let token = page
        .split_once(r#"<meta name="disk-clean-token" content=""#)
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(token, _)| token.to_string())
        .expect("token meta");
    (t, child, port, token)
}

fn raw(method: &str, target: &str, headers: &str, body: &str) -> String {
    format!(
        "{method} {target} HTTP/1.1\r\n{headers}Content-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

const DEEP_LINKS: [&str; 7] = [
    "/cleanup",
    "/cleanup/caches?view=cards&q=%22a%22",
    "/cleanup/confirm",
    "/storage/Users/you/Library%20Support?shape=treemap",
    "/insights?overlay=progress&log=problems",
    "/no/such/page",
    "/events/",
];

#[test]
fn deep_links_get_the_page_and_api_routes_are_unchanged() {
    let (_t, mut child, port, token) = finished_review("deep");
    let (status, page) = get(port, "/");
    assert_eq!(status, 200);
    for target in DEEP_LINKS {
        let (status, body) = get(port, target);
        assert_eq!(status, 200, "GET {target}");
        assert_eq!(
            body, page,
            "GET {target} serves the same page with its token"
        );
    }
    assert_eq!(get(port, "/events").0, 403);
    assert_eq!(get(port, "/events?token=wrong").0, 403);
    for route in ["/decide", "/preview", "/rescan"] {
        assert_eq!(get(port, route).0, 404, "GET {route}");
    }
    assert_eq!(
        post_to(port, "/cleanup", &format!(r#"{{"token": "{token}"}}"#)),
        404
    );
    let body = format!(r#"{{"token": "{token}", "decision": "cancel", "items": []}}"#);
    assert_eq!(post(port, &body), 200);
    assert_eq!(child.wait().unwrap().code(), Some(5));
}

#[test]
fn a_foreign_host_or_origin_is_refused_everywhere() {
    let (t, mut child, port, token) = finished_review("rebind");
    let body = format!(r#"{{"token": "{token}", "decision": "cancel", "items": []}}"#);
    let json = "Content-Type: application/json\r\n";
    for host in [
        format!("evil.example:{port}"),
        "evil.example".to_string(),
        "127.0.0.1".to_string(),
        format!("127.0.0.2:{port}"),
    ] {
        let headers = format!("Host: {host}\r\nOrigin: http://{host}\r\n{json}");
        for (method, target) in [
            ("GET", "/".to_string()),
            ("GET", "/storage/Users".to_string()),
            ("GET", format!("/events?token={token}")),
            ("POST", "/preview".to_string()),
            ("POST", "/rescan".to_string()),
            ("POST", "/decide".to_string()),
        ] {
            let sent = if method == "GET" { "" } else { body.as_str() };
            assert_eq!(
                request(port, raw(method, &target, &headers, sent)).0,
                403,
                "{method} {target} with Host {host}"
            );
        }
    }
    let local = format!("Host: 127.0.0.1:{port}\r\n");
    let preview = picks_body(&token, "", &t.0.join("run"), &[], None);
    let plain = format!("{local}Content-Type: text/plain\r\n");
    assert_eq!(
        request(port, raw("POST", "/preview", &plain, &preview)).0,
        403
    );
    assert_eq!(
        request(port, raw("POST", "/preview", &local, &preview)).0,
        403
    );
    let foreign = format!("{local}{json}Origin: http://evil.example\r\n");
    assert_eq!(
        request(port, raw("POST", "/preview", &foreign, &preview)).0,
        403
    );
    let own = format!("{local}{json}Origin: http://127.0.0.1:{port}\r\n");
    assert_eq!(
        request(port, raw("POST", "/preview", &own, &preview)).0,
        200
    );
    let named = format!("Host: localhost:{port}\r\n");
    assert_eq!(request(port, raw("GET", "/", &named, "")).0, 200);
    assert_eq!(post(port, &body), 200);
    assert_eq!(child.wait().unwrap().code(), Some(5));
}

#[test]
fn oversized_slow_and_excess_requests_are_turned_away() {
    let (_t, mut child, port, token) = finished_review("limits");
    let local = format!("Host: 127.0.0.1:{port}\r\n");
    let padded = format!("{local}X-Pad: {}\r\n", "a".repeat(17 * 1024));
    assert_eq!(request(port, raw("GET", "/", &padded, "")).0, 431);
    let long = format!("/cleanup/caches?drop={}", "a1b2c3d4.".repeat(22_000));
    assert_eq!(
        get(port, &long).0,
        200,
        "a long selection in the URL still loads"
    );
    let too_long = format!("/cleanup/caches?drop={}", "a1b2c3d4.".repeat(30_000));
    let (status, page) = get(port, &too_long);
    assert_eq!(status, 431);
    assert!(
        page.contains("This address is too long for disk-clean"),
        "{page}"
    );
    let huge = format!(
        "POST /preview HTTP/1.1\r\n{local}Content-Type: application/json\r\nContent-Length: 2000000\r\n\r\n"
    );
    assert_eq!(request(port, huge).0, 413);
    let mut sender = common::connect(port);
    let mut reader = sender.try_clone().unwrap();
    let body = vec![b'x'; 2_000_000];
    let head = format!(
        "POST /preview HTTP/1.1\r\n{local}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    let writer = std::thread::spawn(move || {
        let _ = sender.write_all(head.as_bytes());
        let _ = sender.write_all(&body);
    });
    let mut answer = Vec::new();
    reader
        .read_to_end(&mut answer)
        .expect("an oversized body is answered, not reset");
    writer.join().unwrap();
    assert!(String::from_utf8_lossy(&answer).starts_with("HTTP/1.0 413"));

    let started = std::time::Instant::now();
    let mut slow = common::connect(port);
    write!(slow, "GET / HTTP/1.1\r\n{local}").unwrap();
    let mut answer = String::new();
    slow.read_to_string(&mut answer).unwrap();
    assert!(answer.starts_with("HTTP/1.0 408"), "{answer}");
    assert!(started.elapsed() >= std::time::Duration::from_secs(9));

    let streams: Vec<_> = (0..64).map(|_| open_events(port, &token)).collect();
    assert_eq!(get(port, "/").0, 503);
    drop(streams);
    let dropped = std::time::Instant::now();
    while get(port, "/").0 != 200 {
        assert!(
            dropped.elapsed() < std::time::Duration::from_millis(1500),
            "closed event streams still hold their slots"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert_eq!(
        post(
            port,
            &format!(r#"{{"token": "{token}", "decision": "cancel"}}"#)
        ),
        200
    );
    assert_eq!(child.wait().unwrap().code(), Some(5));
}

fn post_reply(port: u16, route: &str, body: &str) -> (u16, String) {
    let raw = format!(
        "POST {route} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    request(port, raw)
}

#[cfg(unix)]
fn blocking_docker(bin: &Path, gate: &Path) {
    fs::create_dir_all(bin).unwrap();
    let docker = bin.join("docker");
    fs::write(
        &docker,
        format!(
            "#!/bin/sh\nwhile [ ! -e '{}' ]; do [ -d '{}' ] || exit 1; sleep 0.05; done\nexit 1\n",
            gate.display(),
            bin.display()
        ),
    )
    .unwrap();
    common::status(Command::new("chmod").arg("+x").arg(&docker));
}

#[cfg(unix)]
fn listed_paths(reader: &mut BufReader<TcpStream>, wanted: &[&Path]) {
    let mut missing: Vec<String> = wanted.iter().map(|p| p.display().to_string()).collect();
    while !missing.is_empty() {
        for (_, data) in read_until(reader, "item") {
            if data["item"]["checking"] != true {
                missing.retain(|p| data["item"]["path"] != p.as_str());
            }
        }
    }
}

fn picks_body(
    token: &str,
    decision: &str,
    run: &Path,
    wanted: &[&str],
    listed: Option<usize>,
) -> String {
    let mut lines = disk_clean::util::complete_lines(&run.join("scan.tsv"));
    if let Some(count) = listed {
        lines.truncate(count);
    }
    let categories = disk_clean::review::categories_of(&lines);
    let drop: Vec<String> = categories.iter().map(|c| format!("_{}", c.id)).collect();
    let add: Vec<String> = wanted.iter().map(|p| short_token(p)).collect();
    let items: Vec<Listed> = categories
        .iter()
        .flat_map(|c| {
            c.items.iter().filter(|i| !i.report).map(|i| Listed {
                path: &i.path,
                section: &c.id,
                preselect: i.preselect,
            })
        })
        .collect();
    let (add, drop) = (add.join("."), drop.join("."));
    let selected = decode(&items, &add, &drop);
    serde_json::json!({
        "token": token,
        "decision": decision,
        "add": add,
        "drop": drop,
        "listed": listed,
        "fingerprint": fingerprint(&selected),
    })
    .to_string()
}

#[cfg(unix)]
fn live_run(home: &Path) -> std::path::PathBuf {
    let runs: Vec<_> = fs::read_dir(home.join(".cache/disk-clean"))
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("run-"))
        })
        .collect();
    assert_eq!(runs.len(), 1, "{runs:?}");
    runs[0].clone()
}

#[cfg(unix)]
fn lines_in(run: &Path) -> usize {
    disk_clean::util::complete_lines(&run.join("scan.tsv")).len()
}

#[cfg(unix)]
#[test]
fn approving_while_the_scan_runs_uses_what_was_listed() {
    let t = common::temp_dir("midscan");
    let home = t.0.join("home");
    let (bin, gate) = (t.0.join("bin"), t.0.join("gate"));
    let take = common::app_caches(&home).join("take");
    let keep = common::app_caches(&home).join("keep");
    let never = home.join("never-listed");
    for dir in [&take, &keep, &never] {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("blob"), vec![7u8; 64 * 1024]).unwrap();
    }
    blocking_docker(&bin, &gate);
    let (mut child, port, token) = spawn_live(&home, &bin);
    let mut stream = open_events(port, &token);
    listed_paths(&mut stream, &[&take, &keep]);

    let run = live_run(&home);
    let listed = Some(lines_in(&run));
    let (take_s, never_s) = (take.to_str().unwrap(), never.to_str().unwrap());
    let (status, body) = post_reply(
        port,
        "/preview",
        &picks_body(&token, "", &run, &[take_s, never_s], listed),
    );
    assert_eq!(status, 200, "{body}");
    let plan: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(plan["count"], 1, "{plan}");
    assert_eq!(plan["paths"][0]["path"], take.to_str().unwrap());
    assert_eq!(
        post_reply(
            port,
            "/decide",
            &picks_body(&token, "approve", &run, &[never_s], listed)
        )
        .0,
        409,
        "a path the scan never listed is refused"
    );
    assert!(child.try_wait().unwrap().is_none(), "still scanning");

    assert_eq!(
        post_reply(
            port,
            "/decide",
            &picks_body(&token, "approve", &run, &[take_s, never_s], listed)
        )
        .0,
        200
    );
    let code = child.wait().unwrap().code();
    let mut stdout = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    fs::write(&gate, "").unwrap();
    assert_eq!(code, Some(0), "{stdout}");
    let lines: Vec<&str> = stdout.lines().collect();
    let run = Path::new(lines[0]);
    assert_eq!(Path::new(lines[1]), run.join("selection.json"));

    let scan = fs::read_to_string(run.join("scan.tsv")).unwrap();
    assert!(scan.ends_with('\n'), "{scan}");
    let recorded: Vec<&str> = scan
        .lines()
        .map(|l| {
            let cols: Vec<&str> = l.split('\t').collect();
            assert_eq!(cols.len(), 13, "{l}");
            cols[8]
        })
        .collect();
    assert!(recorded.contains(&take.to_str().unwrap()));
    assert!(recorded.contains(&keep.to_str().unwrap()));
    assert!(
        !recorded.contains(&"cmd:docker-prune"),
        "rows still being checked are never recorded"
    );
    let sel: Value =
        serde_json::from_str(&fs::read_to_string(run.join("selection.json")).unwrap()).unwrap();
    let chosen: Vec<&str> = sel["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["path"].as_str().unwrap())
        .collect();
    assert_eq!(chosen, [take.to_str().unwrap()]);
    assert_eq!(sel["mode"], "trash");
    common::assert_inside_ram_disk(&take);

    let dry = common::cli(&["clean", "--dry-run", run.to_str().unwrap()], &home, &[]);
    assert_eq!(dry.status.code(), Some(0));
    let dry = String::from_utf8_lossy(&dry.stdout).into_owned();
    assert!(
        dry.contains(&format!("trash -- {}\n", take.display())),
        "{dry}"
    );
    assert!(!dry.contains(keep.to_str().unwrap()), "{dry}");

    let real = common::cli(&["clean", run.to_str().unwrap()], &home, &[]);
    assert_eq!(
        real.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&real.stderr)
    );
    common::wait_for("the cleanup", std::time::Duration::from_secs(20), || {
        fs::read_to_string(run.join("status")).is_ok_and(|s| s.trim() == "done")
    });
    assert!(
        !take.exists(),
        "the approved, listed path was moved to the Trash"
    );
    assert!(
        keep.join("blob").is_file(),
        "a listed but unapproved path stays"
    );
    assert!(never.join("blob").is_file(), "a path never listed stays");
    let trashed: Vec<Value> = common::events_of(run)
        .into_iter()
        .filter(|e| e["event"] == "trashed")
        .collect();
    assert_eq!(trashed.len(), 1);
    assert_eq!(trashed[0]["path"], take.to_str().unwrap());
    common::assert_record_inside_ram_disk(&home);
}

#[test]
fn a_five_thousand_change_selection_previews_approves_and_reloads() {
    let t = common::temp_dir("big-selection");
    let (home, run) = (t.0.join("h"), t.0.join("run"));
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&run).unwrap();
    let h = common::text(&home);
    let paths: Vec<String> = (0..10_000)
        .map(|i| format!("{h}/tmp/item-{i:05}"))
        .collect();
    let rows: String = paths
        .iter()
        .map(|p| {
            format!("temp\tYour macOS temp\tdesc\tsafe\t1\trm\t-\t{p}\t{p}\t4096\t\t3\texact\n")
        })
        .collect();
    fs::write(run.join("scan.tsv"), rows).unwrap();
    let mut child = common::reaped(
        common::bin(&home)
            .args(["review", &common::text(&run)])
            .env("DISK_CLEAN_NO_BROWSER", "1")
            .env("DISK_CLEAN_WATCH_START", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    );
    let mut stderr = BufReader::new(child.stderr.take().unwrap());
    let mut line = String::new();
    stderr.read_line(&mut line).unwrap();
    let port: u16 = line
        .trim()
        .trim_end_matches('/')
        .rsplit(':')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    std::thread::spawn(move || std::io::copy(&mut stderr, &mut std::io::sink()));
    let (_, page) = get(port, "/");
    let token = page
        .split_once(r#"<meta name="disk-clean-token" content=""#)
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(token, _)| token.to_string())
        .unwrap();

    let dropped: Vec<String> = paths.iter().step_by(2).map(|p| short_token(p)).collect();
    let drop = dropped.join(".");
    assert_eq!(dropped.len(), 5000);
    let url = format!("/cleanup/temp?drop={drop}");
    assert!(url.len() > 40_000, "{}", url.len());
    assert_eq!(
        get(port, &url).0,
        200,
        "the page reloads with the selection in its URL"
    );

    let kept: Vec<String> = paths.iter().skip(1).step_by(2).cloned().collect();
    let body = serde_json::json!({
        "token": token,
        "decision": "approve",
        "add": "",
        "drop": drop,
        "fingerprint": fingerprint(&kept),
    })
    .to_string();
    let (status, plan) = post_reply(port, "/preview", &body);
    assert_eq!(status, 200, "{plan}");
    let plan: Value = serde_json::from_str(&plan).unwrap();
    assert_eq!(
        plan["rejected"].as_array().unwrap().len(),
        5000,
        "none exist on disk"
    );
    assert_eq!(post_reply(port, "/decide", &body).0, 200);
    assert_eq!(child.wait().unwrap().code(), Some(0));
    let sel: Value =
        serde_json::from_str(&fs::read_to_string(run.join("selection.json")).unwrap()).unwrap();
    let mut chosen: Vec<String> = sel["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["path"].as_str().unwrap().to_string())
        .collect();
    chosen.sort();
    assert_eq!(chosen, kept);
}
