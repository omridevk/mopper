use crate::platform;
use crate::scan::{
    Cat, Config, Ctx, Row, SIMS_KEY, age_of, children_of, existing, h, row, size_bytes, sized,
};
use crate::util;
use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

const PKG_CACHE: &[&str] = &[
    ".npm/_cacache",
    "Library/Caches/Yarn",
    ".yarn/berry/cache",
    "Library/Caches/pnpm",
    ".bun/install/cache",
    "Library/Caches/pip",
    ".cache/pip",
    ".cache/uv",
    "Library/Caches/Homebrew",
];
const PKG_CACHE_TAIL: &[&str] = &[
    "Library/Caches/go-build",
    ".cargo/registry/cache",
    ".cache/ms-playwright",
    "Library/Caches/ms-playwright",
    ".cache/puppeteer",
    "Library/Caches/CocoaPods",
    ".composer/cache",
    ".cache/yarn",
    "Library/Caches/electron",
    "Library/Caches/node-gyp",
    "Library/Caches/deno",
];
const PKG_STORE: &[&str] = &[
    ".cargo/registry/src",
    "go/pkg/mod",
    ".m2/repository",
    ".gradle/caches",
    ".gem",
];
const PNPM_STORE: &[&str] = &["Library/pnpm/store", ".local/share/pnpm/store"];
const XCODE: &[&str] = &[
    "Library/Developer/Xcode/DerivedData",
    "Library/Developer/CoreSimulator/Caches",
    "Library/Developer/Xcode/iOS DeviceSupport",
    "Library/Developer/Xcode/watchOS DeviceSupport",
    "Library/Developer/Xcode/UserData/IB Support",
];
const XCODE_ARCHIVES: &str = "Library/Developer/Xcode/Archives";
const SIM_DEVICES: &str = "Library/Developer/CoreSimulator/Devices";
const CRASH_REPORTER: &str = "Library/Application Support/CrashReporter";
const DIAGNOSTIC_REPORTS: &str = "Library/Logs/DiagnosticReports";
const IOS_BACKUP: &str = "Library/Application Support/MobileSync/Backup";

pub const HOME_SYSTEM_DIRS: &[&str] = &["Library", ".Trash"];
pub const SYSTEM_TMP: &str = "/private/tmp";
pub const PNPM_STORE_NOTE: &str = " Size is apparent: pnpm clones package files from ~/Library/pnpm/store, so deleting frees only blocks no other project or the store still holds.";
pub const SIMS_COMMAND: &str = "xcrun simctl delete unavailable";
pub const THIS_COMPUTER: &str = "this Mac";
pub const DOCKER_NOTE: &str = "Frees space INSIDE Docker's sparse VM disk image, which does not shrink — macOS gets little or none of it back. Reclaim it on the host by resetting the Docker VM disk in Docker Desktop. Named volumes are never touched.";

pub fn downloads_dir(home: &str) -> PathBuf {
    PathBuf::from(format!("{home}/Downloads"))
}

pub fn has_sims(home: &str) -> bool {
    platform::which("xcrun") && Path::new(&format!("{home}/{SIM_DEVICES}")).is_dir()
}

pub fn probe_sims(home: &str) -> usize {
    if !has_sims(home) {
        return 0;
    }
    util::output("xcrun", &["simctl", "list", "devices"])
        .map(|(_, out)| out.lines().filter(|l| l.contains("unavailable")).count())
        .unwrap_or(0)
}

pub fn probe_pkg_cache() -> Option<String> {
    if !platform::which("brew") {
        return None;
    }
    let (_, out) = util::output("brew", &["--cache"])?;
    let out = out.trim_end_matches('\n').to_string();
    (!out.is_empty()).then_some(out)
}

pub fn probe_snapshots() -> usize {
    util::output("tmutil", &["listlocalsnapshots", "/"])
        .map(|(_, out)| out.lines().filter(|l| l.contains("com.apple")).count())
        .unwrap_or(0)
}

pub fn plan_locations(home: &str, tmp_base: Option<&str>) -> (HashSet<PathBuf>, HashSet<PathBuf>) {
    let hp = |rel: &str| PathBuf::from(format!("{home}/{rel}"));
    let mut exact: HashSet<PathBuf> = [PKG_CACHE, PKG_CACHE_TAIL, PKG_STORE, PNPM_STORE, XCODE]
        .concat()
        .iter()
        .map(|r| hp(r))
        .collect();
    exact.extend(
        [
            XCODE_ARCHIVES,
            SIM_DEVICES,
            CRASH_REPORTER,
            DIAGNOSTIC_REPORTS,
        ]
        .iter()
        .map(|r| hp(r)),
    );
    let mut parents: HashSet<PathBuf> = [".Trash", "Library/Caches", "Library/Logs", IOS_BACKUP]
        .iter()
        .map(|r| hp(r))
        .collect();
    parents.insert(downloads_dir(home));
    parents.insert(PathBuf::from(SYSTEM_TMP));
    if let Some(base) = tmp_base {
        for sub in ["T", "C", "X"] {
            parents.insert(PathBuf::from(format!("{base}/{sub}")));
        }
    }
    (exact, parents)
}

pub(crate) fn scan_trash_and_tools(
    ctx: &Ctx,
    rows: &mut Vec<Row>,
    cfg: &Config,
    brew_cache: Option<&str>,
) {
    scan_trash(ctx, rows);
    scan_pkg(ctx, rows, cfg, brew_cache);
    scan_xcode(ctx, rows, cfg);
}

pub(crate) fn scan_app_data(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    scan_ios_backups(ctx, rows, cfg);
    scan_caches(ctx, rows, cfg);
    scan_logs(ctx, rows, cfg);
}

pub(crate) fn scan_temp(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config, tmp_base: Option<&str>) {
    scan_user_tmpdir(ctx, rows, cfg, tmp_base);
    scan_private_tmp(ctx, rows, cfg);
}

fn scan_trash(ctx: &Ctx, rows: &mut Vec<Row>) {
    let cat = Cat {
        id: "trash",
        title: "Trash",
        desc: "Items already in the macOS Trash.",
        risk: "safe",
        pre: "1",
    };
    let list = children_of(ctx, &h(ctx, ".Trash"));
    sized(ctx, rows, &cat, &list, "Permanently removed.", 1);
}

fn scan_caches(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let cat = Cat {
        id: "caches",
        title: "Application caches",
        desc: "~/Library/Caches — regenerated automatically by each app.",
        risk: "safe",
        pre: "1",
    };
    let list = children_of(ctx, &h(ctx, "Library/Caches"));
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "App rebuilds this on next launch.",
        cfg.min_bytes,
    );
}

fn scan_logs(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let cat = Cat {
        id: "logs",
        title: "Logs and crash reports",
        desc: "Diagnostic output kept by apps and macOS.",
        risk: "safe",
        pre: "1",
    };
    let mut list = children_of(ctx, &h(ctx, "Library/Logs"));
    list.extend(existing(vec![
        h(ctx, CRASH_REPORTER),
        h(ctx, DIAGNOSTIC_REPORTS),
    ]));
    sized(ctx, rows, &cat, &list, "Diagnostics only.", cfg.min_bytes);
}

fn scan_pkg(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config, brew_cache: Option<&str>) {
    let mut list: Vec<PathBuf> = PKG_CACHE.iter().map(|r| h(ctx, r)).collect();
    list.extend(brew_cache.map(PathBuf::from));
    list.extend(PKG_CACHE_TAIL.iter().map(|r| h(ctx, r)));
    let cat = Cat {
        id: "pkg-cache",
        title: "Package manager caches",
        desc: "Download caches for npm, brew, pip, cargo, go and friends.",
        risk: "safe",
        pre: "1",
    };
    sized(
        ctx,
        rows,
        &cat,
        &existing(list),
        "Re-downloaded on next install.",
        cfg.min_bytes,
    );

    let cat = Cat {
        id: "pkg-store",
        title: "Package manager stores",
        desc: "Extracted dependency sources. Safe to delete but slower to restore.",
        risk: "review",
        pre: "0",
    };
    let list = existing(PKG_STORE.iter().map(|r| h(ctx, r)).collect());
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Re-downloaded and re-extracted on next build.",
        cfg.min_bytes,
    );

    let cat = Cat {
        id: "pnpm-store",
        title: "pnpm content store",
        desc: "The store that existing node_modules hard-link into.",
        risk: "review",
        pre: "0",
    };
    let list = existing(PNPM_STORE.iter().map(|r| h(ctx, r)).collect());
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Breaks every existing node_modules on this Mac until each project reinstalls.",
        cfg.min_bytes,
    );
}

fn scan_xcode(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let cat = Cat {
        id: "xcode",
        title: "Xcode build data",
        desc: "Derived data, simulator caches and device support files.",
        risk: "safe",
        pre: "1",
    };
    let list = existing(XCODE.iter().map(|r| h(ctx, r)).collect());
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Xcode regenerates on next build or device connect.",
        cfg.min_bytes,
    );

    let cat = Cat {
        id: "xcode-archives",
        title: "Xcode archives",
        desc: "Built .xcarchive bundles. Needed to re-submit or symbolicate an old build.",
        risk: "review",
        pre: "0",
    };
    let list = existing(vec![h(ctx, XCODE_ARCHIVES)]);
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Not recoverable without rebuilding that exact commit.",
        cfg.min_bytes,
    );
}

pub(crate) fn sims_row(label: &str, bytes: u64) -> Row {
    let cat = Cat {
        id: "xcode-sims",
        title: "Unavailable simulators",
        desc: "Simulator devices whose runtime is no longer installed.",
        risk: "safe",
        pre: "1",
    };
    row(
        &cat,
        "cmd",
        "xcode-unavailable-sims",
        label,
        SIMS_KEY,
        bytes,
        "Rough estimate. Removes only devices macOS already marks unavailable.",
        "-",
        "estimate",
    )
}

pub(crate) fn scan_sims(ctx: &Ctx, rows: &mut Vec<Row>, sims: usize) {
    if sims > 0 {
        let bytes = size_bytes(ctx, &h(ctx, SIM_DEVICES)).unwrap_or(0) / 3;
        rows.push(sims_row(&format!("{SIMS_COMMAND} ({sims} devices)"), bytes));
    }
}

fn scan_ios_backups(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let cat = Cat {
        id: "ios-backups",
        title: "iOS device backups",
        desc: "Local iPhone and iPad backups.",
        risk: "review",
        pre: "0",
    };
    let list = children_of(ctx, &h(ctx, IOS_BACKUP));
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Not recoverable. Only delete if the device backs up to iCloud.",
        cfg.min_bytes,
    );
}

fn scan_private_tmp(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let tmp = Path::new(SYSTEM_TMP);
    if !tmp.is_dir() {
        return;
    }
    let uid = platform::uid();
    let list: Vec<PathBuf> = children_of(ctx, tmp)
        .into_iter()
        .filter(|p| fs::symlink_metadata(p).is_ok_and(|m| m.uid() == uid))
        .collect();
    let cat = Cat {
        id: "private-tmp",
        title: "Temp files in /private/tmp",
        desc: "Entries in /private/tmp that belong to you. Tools recreate what they need, but a running process may still be using one.",
        risk: "review",
        pre: "0",
    };
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Recreated on demand.",
        cfg.min_bytes,
    );
}

fn scan_user_tmpdir(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config, base: Option<&str>) {
    let Some(base) = base.filter(|b| Path::new(b).is_dir()) else {
        return;
    };
    let mut list = children_of(ctx, &PathBuf::from(format!("{base}/T")));
    list.extend(children_of(ctx, &PathBuf::from(format!("{base}/C"))));
    let cat = Cat {
        id: "user-tmpdir",
        title: "Your macOS temp and cache folder",
        desc: "The per-user $TMPDIR tree. Rebuilt automatically, but a running process may still be using one.",
        risk: "review",
        pre: "0",
    };
    sized(ctx, rows, &cat, &list, "Rebuilt on demand.", cfg.min_bytes);

    let cat = Cat {
        id: "code-sign-clones",
        title: "App code-signing clones",
        desc: "Copies macOS makes of an app bundle while the app runs. They pile up and are rarely cleaned. Sizes are apparent — clones share disk blocks with the app, so the space actually returned is only the blocks of app versions no longer on disk.",
        risk: "review",
        pre: "0",
    };
    for d in children_of(ctx, &PathBuf::from(format!("{base}/X"))) {
        let Some(name) = d.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with('.') || !name.ends_with(".code_sign_clone") || !d.is_dir() {
            continue;
        }
        let Some(bytes) = size_bytes(ctx, &d) else {
            continue;
        };
        if bytes < cfg.min_bytes {
            continue;
        }
        let Some(s) = d.to_str() else { continue };
        rows.push(row(
            &cat,
            "rm",
            "-",
            &format!("$TMPDIR/../X/{name}"),
            s,
            bytes,
            "Quit the app first. Frees far less than the size shown.",
            &age_of(ctx, &d),
            "estimate",
        ));
    }
}
