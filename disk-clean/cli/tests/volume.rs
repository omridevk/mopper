#[cfg(windows)]
mod common;

use std::path::Path;
#[cfg(unix)]
use std::process::Command;

#[cfg(unix)]
#[test]
fn volume_stats_match_df() {
    let mount = disk_clean::util::data_mount();
    let stats = disk_clean::util::volume_stats(&mount).unwrap();
    let out = Command::new("df").arg("-k").arg(&mount).output().unwrap();
    let text = String::from_utf8(out.stdout).unwrap();
    let cols: Vec<u64> = text
        .lines()
        .nth(1)
        .unwrap()
        .split_whitespace()
        .skip(1)
        .take(3)
        .map(|v| v.parse().unwrap())
        .collect();
    let close = |a: u64, b: u64| a.abs_diff(b) <= 64 * 1024 * 1024;
    assert_eq!(stats.total, cols[0] * 1024);
    assert!(
        close(stats.used, cols[1] * 1024),
        "used {} vs df {}",
        stats.used,
        cols[1] * 1024
    );
    assert!(
        close(stats.avail, cols[2] * 1024),
        "avail {} vs df {}",
        stats.avail,
        cols[2] * 1024
    );
    assert!(Path::new(&mount).is_dir());
}

#[cfg(windows)]
#[test]
fn volume_stats_match_the_drive_info() {
    let mount = disk_clean::util::data_mount();
    let stats = disk_clean::util::volume_stats(&mount).unwrap();
    let drive = &common::text(&mount)[..2];
    let info = common::powershell(&format!(
        "$d = [System.IO.DriveInfo]::new('{drive}\\'); \"$($d.TotalSize) $($d.TotalFreeSpace) $($d.AvailableFreeSpace)\""
    ));
    let cols: Vec<u64> = info
        .split_whitespace()
        .map(|v| v.parse().unwrap())
        .collect();
    let close = |a: u64, b: u64| a.abs_diff(b) <= 64 * 1024 * 1024;
    assert_eq!(stats.total, cols[0]);
    assert!(
        close(stats.used, cols[0] - cols[1]),
        "used {} vs drive info {}",
        stats.used,
        cols[0] - cols[1]
    );
    assert!(
        close(stats.avail, cols[2]),
        "avail {} vs drive info {}",
        stats.avail,
        cols[2]
    );
    assert!(Path::new(&mount).is_dir());
}
