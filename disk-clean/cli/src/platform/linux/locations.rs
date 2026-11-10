use super::trash::home_trash;
use crate::platform;
use crate::scan::{Cat, Config, Ctx, Row, SIMS_KEY, children_of, existing, h, row, sized};
use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

const PKG_CACHE: &[&str] = &[
    ".npm/_cacache",
    ".npm/_npx",
    ".cache/pnpm",
    ".cache/yarn",
    ".yarn/berry/cache",
    ".bun/install/cache",
    ".cache/pip",
    ".cache/uv",
    ".cache/pypoetry/cache",
    ".cache/pypoetry/artifacts",
    ".cache/pre-commit",
    ".cache/node/corepack",
    ".cargo/registry/cache",
    ".cache/go-build",
    ".cache/composer",
    ".cache/deno",
    ".cache/electron",
    ".cache/node-gyp",
    ".cache/Homebrew",
    ".cache/ms-playwright",
    ".cache/puppeteer",
    ".cache/huggingface/xet",
];
const CCACHE: &str = ".cache/ccache";
const CCACHE_CONF: &str = "ccache.conf";
const PKG_STORE: &[&str] = &[
    ".cargo/registry/src",
    "go/pkg/mod",
    ".m2/repository",
    ".gradle/caches",
    ".gem",
];
const PNPM_STORE: &str = ".local/share/pnpm/store";
const CACHE: &str = ".cache";
const APP_CACHES: &[&str] = &[
    "google-chrome",
    "chromium",
    "mozilla",
    "thumbnails",
    "fontconfig",
];
const SHADER_CACHE: &str = "mesa_shader_cache";
const NEVER: &[&str] = &[
    "disk-clean",
    "huggingface",
    "pypoetry",
    "JetBrains",
    "bazel",
    "torch",
];
const FLATPAK_APPS: &str = ".var/app";
const SNAPS: &str = "snap";
const VAR_TMP: &str = "/var/tmp";

pub const HOME_SYSTEM_DIRS: &[&str] = &[".cache", ".config", ".local", ".var", "snap"];
pub const SYSTEM_TMP: &str = "/tmp";
pub const PNPM_STORE_NOTE: &str = " Size is apparent: pnpm hard-links package files from ~/.local/share/pnpm/store, so deleting frees only files no other project or the store still links.";
pub const SIMS_COMMAND: &str = "";
pub const THIS_COMPUTER: &str = "this computer";
pub const DOCKER_NOTE: &str = "With Docker Desktop the space stays inside its VM disk until that disk is reset in Docker Desktop. Named volumes are never touched.";

pub fn downloads_dir(home: &str) -> PathBuf {
    super::protected::user_dirs(home)
        .into_iter()
        .rev()
        .find(|(name, path)| name == "DOWNLOAD" && path != home)
        .map_or_else(
            || PathBuf::from(format!("{home}/Downloads")),
            |(_, path)| PathBuf::from(path),
        )
}

pub fn has_sims(_home: &str) -> bool {
    false
}

pub fn probe_sims(_home: &str) -> usize {
    0
}

pub fn probe_pkg_cache() -> Option<String> {
    None
}

pub fn probe_snapshots() -> usize {
    0
}

fn real_dirs(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| fs::symlink_metadata(p).is_ok_and(|m| m.is_dir()))
                .collect()
        })
        .unwrap_or_default()
}

fn sandbox_caches(flatpak_apps: &Path, snaps: &Path) -> Vec<PathBuf> {
    let mut list: Vec<PathBuf> = real_dirs(flatpak_apps)
        .into_iter()
        .map(|app| app.join("cache"))
        .collect();
    for snap in real_dirs(snaps) {
        list.extend(real_dirs(&snap).into_iter().map(|rev| rev.join(".cache")));
    }
    list.retain(|c| fs::symlink_metadata(c).is_ok_and(|m| m.is_dir()));
    list
}

pub fn plan_locations(home: &str, _tmp_base: Option<&str>) -> (HashSet<PathBuf>, HashSet<PathBuf>) {
    let hp = |rel: &str| PathBuf::from(format!("{home}/{rel}"));
    let exact: HashSet<PathBuf> = [PKG_CACHE, PKG_STORE, &[PNPM_STORE]]
        .concat()
        .iter()
        .map(|r| hp(r))
        .collect();
    let mut parents: HashSet<PathBuf> = [CACHE, CCACHE].iter().map(|r| hp(r)).collect();
    parents.insert(home_trash(home).join("files"));
    parents.insert(downloads_dir(home));
    parents.extend(sandbox_caches(&hp(FLATPAK_APPS), &hp(SNAPS)));
    parents.insert(PathBuf::from(SYSTEM_TMP));
    parents.insert(PathBuf::from(VAR_TMP));
    (exact, parents)
}

pub(crate) fn scan_trash_and_tools(
    ctx: &Ctx,
    rows: &mut Vec<Row>,
    cfg: &Config,
    _pkg_cache: Option<&str>,
) {
    scan_trash(ctx, rows);
    scan_pkg(ctx, rows, cfg);
}

pub(crate) fn scan_app_data(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    scan_caches(ctx, rows, cfg);
    scan_other_caches(ctx, rows, cfg);
}

pub(crate) fn scan_temp(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config, _tmp_base: Option<&str>) {
    let cat = Cat {
        id: "tmp",
        title: "Temp files in /tmp and /var/tmp",
        desc: "Entries in /tmp and /var/tmp that belong to you. Tools recreate what they need, but a running process may still be using one.",
        risk: "review",
        pre: "0",
    };
    sized(
        ctx,
        rows,
        &cat,
        &own_entries(ctx, SYSTEM_TMP),
        "Recreated on demand. If /tmp lives in memory (tmpfs), a trashed item keeps its RAM until the Trash is emptied and is gone at reboot.",
        cfg.min_bytes,
    );
    sized(
        ctx,
        rows,
        &cat,
        &own_entries(ctx, VAR_TMP),
        "Recreated on demand.",
        cfg.min_bytes,
    );
}

fn own_entries(ctx: &Ctx, dir: &str) -> Vec<PathBuf> {
    let uid = platform::uid();
    let volume_trash = format!(".Trash-{uid}");
    children_of(ctx, Path::new(dir))
        .into_iter()
        .filter(|p| {
            p.file_name()
                .is_some_and(|n| n != ".Trash" && *n != *volume_trash)
        })
        .filter(|p| fs::symlink_metadata(p).is_ok_and(|m| m.uid() == uid))
        .collect()
}

fn scan_trash(ctx: &Ctx, rows: &mut Vec<Row>) {
    let cat = Cat {
        id: "trash",
        title: "Trash",
        desc: "Items already in the Trash.",
        risk: "safe",
        pre: "1",
    };
    let list = children_of(ctx, &home_trash(&ctx.home).join("files"));
    sized(ctx, rows, &cat, &list, "Permanently removed.", 1);
}

fn scan_pkg(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let cat = Cat {
        id: "pkg-cache",
        title: "Package manager caches",
        desc: "Download and build caches for npm, pnpm, yarn, pip, uv, cargo, go, ccache and friends.",
        risk: "safe",
        pre: "1",
    };
    let list = existing(PKG_CACHE.iter().map(|r| h(ctx, r)).collect());
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Re-downloaded on next install.",
        cfg.min_bytes,
    );
    let list: Vec<PathBuf> = children_of(ctx, &h(ctx, CCACHE))
        .into_iter()
        .filter(|p| p.file_name().is_some_and(|n| n != CCACHE_CONF))
        .collect();
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Builds are slower until the compiler cache refills. Your ccache.conf stays.",
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
    let list = existing(vec![h(ctx, PNPM_STORE)]);
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Existing node_modules keep their hard-linked files, so this frees only packages no project links any more. Every project re-downloads on its next install.",
        cfg.min_bytes,
    );
}

fn is_app_cache(name: &str) -> bool {
    APP_CACHES.contains(&name) || name.starts_with(SHADER_CACHE)
}

fn scan_caches(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let cat = Cat {
        id: "caches",
        title: "Application caches",
        desc: "Browser, graphics driver and thumbnail caches in ~/.cache, and the cache folders of Flatpak and Snap apps. Regenerated automatically.",
        risk: "safe",
        pre: "1",
    };
    let mut list: Vec<PathBuf> = children_of(ctx, &h(ctx, CACHE))
        .into_iter()
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(is_app_cache)
        })
        .collect();
    for cache in sandbox_caches(&h(ctx, FLATPAK_APPS), &h(ctx, SNAPS)) {
        list.extend(children_of(ctx, &cache).into_iter().filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| !NEVER.contains(&n))
        }));
    }
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "App rebuilds this on next launch.",
        cfg.min_bytes,
    );
}

fn is_other_cache(name: &str) -> bool {
    let rel = format!("{CACHE}/{name}");
    let listed = PKG_CACHE
        .iter()
        .chain(&[CCACHE])
        .any(|p| *p == rel || p.starts_with(&format!("{rel}/")));
    !listed && !is_app_cache(name) && !NEVER.contains(&name)
}

fn scan_other_caches(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let cat = Cat {
        id: "other-caches",
        title: "Other caches",
        desc: "Everything else in ~/.cache. Most apps rebuild what they keep here, but some store data they cannot recreate, so check each one.",
        risk: "review",
        pre: "0",
    };
    let list: Vec<PathBuf> = children_of(ctx, &h(ctx, CACHE))
        .into_iter()
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(is_other_cache)
        })
        .collect();
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Rebuilt by the app that owns it, if it can.",
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
        "-",
        label,
        SIMS_KEY,
        bytes,
        "Rough estimate.",
        "-",
        "estimate",
    )
}

pub(crate) fn scan_sims(_ctx: &Ctx, _rows: &mut Vec<Row>, _sims: usize) {}
