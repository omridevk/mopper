mod common;

use serde_json::Value;
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

const KIB: u64 = 1024;
const MIB: u64 = 1024 * KIB;
const DAY: u64 = 86400;

fn file(home: &Path, rel: &str, bytes: u64, days_old: u64) -> SystemTime {
    let p = home.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(&p, vec![7u8; bytes as usize]).unwrap();
    let mtime = SystemTime::now() - Duration::from_secs(days_old * DAY);
    fs::File::options()
        .write(true)
        .open(&p)
        .unwrap()
        .set_modified(mtime)
        .unwrap();
    mtime
}

fn kind<'a>(data: &'a Value, name: &str) -> &'a Value {
    data["by_kind"]
        .as_array()
        .unwrap()
        .iter()
        .find(|k| k["kind"] == name)
        .unwrap()
}

#[test]
fn scan_writes_insights() {
    let t = common::temp_dir("insights");
    let home = t.0.join("home");
    let run = t.0.join("run");
    let clip = file(&home, "Movies/clip.mp4", 3 * MIB, 2);
    fs::hard_link(
        home.join("Movies/clip.mp4"),
        home.join("Movies/clip-link.mp4"),
    )
    .unwrap();
    file(&home, "Documents/old/report.pdf", MIB, 400);
    file(&home, "proj/node_modules/x/big.mp4", 2 * MIB, 30);
    file(&home, "proj/.git/objects/pack/p.pack", 512 * KIB, 30);
    file(&home, "Library/Caches/app/blob.png", 256 * KIB, 30);
    file(&home, "notes.txt", 4 * KIB, 10);

    let out = common::output(
        common::bin(&home)
            .args([
                "scan",
                "--drives",
                &common::drives_arg(&home),
                &common::text(&run),
            ])
            .env("DISK_CLEAN_SKIP_MAP", "1"),
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let data: Value =
        serde_json::from_str(&fs::read_to_string(run.join("insights.json")).unwrap()).unwrap();

    for (name, bytes, files) in [
        ("video", 3 * MIB, 1),
        ("documents", MIB + 4 * KIB, 2),
        ("dependencies", 2 * MIB, 1),
        ("git", 512 * KIB, 1),
        ("caches", 256 * KIB, 1),
        ("images", 0, 0),
    ] {
        assert_eq!(kind(&data, name)["bytes"], bytes, "{name}");
        assert_eq!(kind(&data, name)["files"], files, "{name}");
    }
    assert_eq!(data["by_kind"][0]["kind"], "video");

    assert_eq!(data["age_by_folder"]["buckets"][5], "<2y");
    let old = data["age_by_folder"]["folders"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["path"] == "~/Documents/old")
        .unwrap();
    assert_eq!(old["bytes"], serde_json::json!([0, 0, 0, 0, 0, MIB, 0]));

    let secs = clip
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let day = common::local_day(secs);
    let entry = data["modified_by_day"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["day"] == day.as_str())
        .unwrap();
    assert_eq!(entry["bytes"], 3 * MIB);
    assert_eq!(entry["files"], 1);

    let largest: Vec<(&str, u64)> = data["largest_files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["path"].as_str().unwrap(), f["bytes"].as_u64().unwrap()))
        .collect();
    assert_eq!(largest.len(), 6);
    assert!(largest[0].0.starts_with("~/Movies/clip"));
    assert_eq!(
        largest[1..],
        [
            ("~/proj/node_modules/x/big.mp4", 2 * MIB),
            ("~/Documents/old/report.pdf", MIB),
            ("~/proj/.git/objects/pack/p.pack", 512 * KIB),
            ("~/Library/Caches/app/blob.png", 256 * KIB),
            ("~/notes.txt", 4 * KIB),
        ]
    );
    assert_eq!(data["largest_files"][0]["mtime"], secs);
}
