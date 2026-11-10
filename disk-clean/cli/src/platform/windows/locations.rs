use super::disk::{drive_roots, is_fixed_drive, local_disks};
use super::path::{known_folder, user_folder, within};
use super::protected::{owned_by_user, user_sid};
use super::trash::bin_folder;
use super::walk::{UNREAL_OUTPUT, find_one, is_project_output};
use crate::platform::{self, path_text};
use crate::scan::{
    Cat, Config, Ctx, Row, SIMS_KEY, age_of, artifacts, children_of, existing, h, row, size_bytes,
    sized,
};
use crate::util::tilde;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
use windows::Win32::UI::Shell::{
    FOLDERID_Downloads, FOLDERID_LocalAppData, FOLDERID_RoamingAppData,
};

pub const HOME_SYSTEM_DIRS: &[&str] = &["AppData", "scoop", ".vscode-shared"];
pub const SYSTEM_TMP: &str = "";
pub const PNPM_STORE_NOTE: &str = " Size is apparent: pnpm hard-links package files from %LOCALAPPDATA%\\pnpm\\store, so deleting frees only files no other project or the store still links.";
pub const SIMS_COMMAND: &str = "";
pub const THIS_COMPUTER: &str = "this PC";
pub const DOCKER_NOTE: &str = "Frees space inside Docker Desktop's disk image, which does not shrink on its own: Windows gets the space back only after Docker Desktop's purge or with a sparse disk. Named volumes are never touched.";

const TEMP_TICKED_DAYS: i64 = 7;
const IDE_TICKED_DAYS: i64 = 180;
const BROWSER_PROFILE_CACHES: &[&str] = &["Cache", "Code Cache", "GPUCache"];
const BROWSER_CACHES: &[&str] = &["ShaderCache", "GrShaderCache"];
const BROWSERS: &[&str] = &["Google/Chrome/User Data", "Microsoft/Edge/User Data"];
const ELECTRON_CACHES: &[(&str, &[&str])] = &[
    (
        "Code",
        &["Cache", "CachedData", "Code Cache", "GPUCache", "logs"],
    ),
    (
        "Slack",
        &[
            "Cache",
            "Code Cache",
            "GPUCache",
            "Service Worker/CacheStorage",
        ],
    ),
    ("discord", &["Cache", "Code Cache", "GPUCache"]),
];
const LOCAL_CACHES: &[&str] = &[
    "Microsoft/Windows/INetCache",
    "D3DSCache",
    "NVIDIA/DXCache",
    "NVIDIA/GLCache",
    "AMD/DxCache",
];
const EXPLORER: &str = "Microsoft/Windows/Explorer";
const EXPLORER_CACHES: &[&str] = &["thumbcache_", "iconcache_"];
const LOGS: &[&str] = &[
    "CrashDumps",
    "Microsoft/Windows/WER/ReportArchive",
    "Microsoft/Windows/WER/ReportQueue",
];
const DEV_REVIEW: &[&str] = &["Unity/cache", "UnrealEngine/Common/DerivedDataCache"];
const IDE_DIRS: &[(&str, &str)] = &[("JetBrains", ""), ("Google", "AndroidStudio")];
const DOCKER_DISKS: &[&str] = &[
    "Docker/wsl/disk/docker_data.vhdx",
    "Docker/wsl/data/ext4.vhdx",
];
const KNOWN_LOCAL: &[&str] = &[
    "Microsoft",
    "Packages",
    "Google",
    "Mozilla",
    "JetBrains",
    "Temp",
    "Programs",
    "npm-cache",
    "pnpm-cache",
    "pnpm",
    "Yarn",
    "pip",
    "uv",
    "go-build",
    "electron",
    "node-gyp",
    "ms-playwright",
    "deno",
    "Composer",
    "NuGet",
    "vcpkg",
    "Unity",
    "UnrealEngine",
    "D3DSCache",
    "NVIDIA",
    "AMD",
    "CrashDumps",
    "Docker",
    "Android",
    "ConnectedDevicesPlatform",
    "Comms",
    "PlaceholderTileLogoFolder",
    "Publishers",
    "VirtualStore",
    "PeerDistRepub",
];
const KNOWN_ROAMING: &[&str] = &["Microsoft", "Code", "Slack", "discord", "Mozilla"];

struct Places {
    home: String,
    local: String,
    roaming: String,
}

fn places(home: &str) -> Places {
    Places {
        home: home.to_string(),
        local: user_folder("LOCALAPPDATA", &FOLDERID_LocalAppData)
            .unwrap_or_else(|| format!("{home}/AppData/Local")),
        roaming: user_folder("APPDATA", &FOLDERID_RoamingAppData)
            .unwrap_or_else(|| format!("{home}/AppData/Roaming")),
    }
}

fn env_dir(home: &str, var: &str, default: String) -> String {
    std::env::var_os(var)
        .and_then(|v| path_text(Path::new(&v)))
        .filter(|p| within(p, home))
        .unwrap_or(default)
}

fn pkg_caches(p: &Places) -> Vec<String> {
    let (h, l) = (p.home.as_str(), p.local.as_str());
    let npm = env_dir(h, "npm_config_cache", format!("{l}/npm-cache"));
    let cargo = env_dir(h, "CARGO_HOME", format!("{h}/.cargo"));
    let scoop = env_dir(h, "SCOOP", format!("{h}/scoop"));
    vec![
        format!("{npm}/_cacache"),
        format!("{npm}/_npx"),
        format!("{l}/pnpm-cache"),
        env_dir(h, "YARN_CACHE_FOLDER", format!("{l}/Yarn/Cache")),
        format!("{l}/Yarn/Berry/cache"),
        env_dir(h, "PIP_CACHE_DIR", format!("{l}/pip/Cache")),
        format!("{cargo}/registry/cache"),
        env_dir(h, "GOCACHE", format!("{l}/go-build")),
        env_dir(h, "electron_config_cache", format!("{l}/electron/Cache")),
        format!("{l}/node-gyp/Cache"),
        env_dir(h, "PLAYWRIGHT_BROWSERS_PATH", format!("{l}/ms-playwright")),
        env_dir(h, "PUPPETEER_CACHE_DIR", format!("{h}/.cache/puppeteer")),
        env_dir(h, "DENO_DIR", format!("{l}/deno")),
        env_dir(h, "COMPOSER_CACHE_DIR", format!("{l}/Composer")),
        env_dir(h, "NUGET_HTTP_CACHE_PATH", format!("{l}/NuGet/v3-cache")),
        format!("{l}/NuGet/plugins-cache"),
        format!("{scoop}/cache"),
    ]
}

fn linked_caches(p: &Places) -> Vec<(String, &'static str)> {
    let (h, l) = (p.home.as_str(), p.local.as_str());
    vec![
        (
            env_dir(
                h,
                "BUN_INSTALL_CACHE_DIR",
                format!("{h}/.bun/install/cache"),
            ),
            "Re-downloaded on next install. Size is apparent: bun hard-links these files into node_modules, so deleting frees only files no project still links.",
        ),
        (
            env_dir(h, "UV_CACHE_DIR", format!("{l}/uv/cache")),
            "Re-downloaded on next install. Size is apparent: uv hard-links these files into virtual environments, so deleting frees only files no environment still links.",
        ),
    ]
}

fn pkg_stores(p: &Places) -> Vec<String> {
    let (h, l) = (p.home.as_str(), p.local.as_str());
    let cargo = env_dir(h, "CARGO_HOME", format!("{h}/.cargo"));
    let gopath = env_dir(h, "GOPATH", format!("{h}/go"));
    let gradle = env_dir(h, "GRADLE_USER_HOME", format!("{h}/.gradle"));
    let conan = env_dir(h, "CONAN_HOME", format!("{h}/.conan2"));
    vec![
        format!("{cargo}/registry/src"),
        format!("{cargo}/git/db"),
        format!("{cargo}/git/checkouts"),
        env_dir(h, "GOMODCACHE", format!("{gopath}/pkg/mod")),
        format!("{gradle}/caches"),
        format!("{gradle}/wrapper/dists"),
        format!("{h}/.m2/repository"),
        env_dir(h, "NUGET_PACKAGES", format!("{h}/.nuget/packages")),
        format!("{h}/.gem"),
        env_dir(
            h,
            "VCPKG_DEFAULT_BINARY_CACHE",
            format!("{l}/vcpkg/archives"),
        ),
        format!("{conan}/p"),
    ]
}

fn pnpm_store(p: &Places) -> String {
    format!("{}/pnpm/store", p.local)
}

fn real_dirs(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    find_one(p).is_some_and(|(attrs, _)| {
                        attrs & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0
                            && fs::symlink_metadata(p).is_ok_and(|m| m.is_dir())
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn app_caches(p: &Places) -> Vec<PathBuf> {
    let (l, r) = (p.local.as_str(), p.roaming.as_str());
    let mut list: Vec<PathBuf> = LOCAL_CACHES
        .iter()
        .map(|rel| PathBuf::from(format!("{l}/{rel}")))
        .collect();
    list.extend(
        real_dirs(Path::new(&format!("{l}/Packages")))
            .into_iter()
            .map(|app| app.join("TempState")),
    );
    for browser in BROWSERS {
        let data = PathBuf::from(format!("{l}/{browser}"));
        list.extend(BROWSER_CACHES.iter().map(|c| data.join(c)));
        for profile in real_dirs(&data) {
            list.extend(BROWSER_PROFILE_CACHES.iter().map(|c| profile.join(c)));
        }
    }
    for (app, caches) in ELECTRON_CACHES {
        list.extend(
            caches
                .iter()
                .map(|c| PathBuf::from(format!("{r}/{app}/{c}"))),
        );
    }
    list.extend(
        real_dirs(Path::new(&format!("{l}/Mozilla/Firefox/Profiles")))
            .into_iter()
            .map(|profile| profile.join("cache2")),
    );
    list.extend(
        real_dirs(Path::new(&format!("{l}/Microsoft/VisualStudio")))
            .into_iter()
            .map(|version| version.join("ComponentModelCache")),
    );
    existing(list)
}

fn recycle_bins() -> Vec<PathBuf> {
    let Some(sid) = user_sid() else {
        return Vec::new();
    };
    drive_roots()
        .filter(|root| is_fixed_drive(root))
        .filter_map(|root| bin_folder(&root).map(|bin| PathBuf::from(format!("{bin}/{sid}"))))
        .filter(|bin| bin.is_dir())
        .collect()
}

fn original_path(info: &Path) -> Option<String> {
    let bytes = fs::read(info).ok()?;
    let version = i64::from_le_bytes(bytes.get(0..8)?.try_into().ok()?);
    let text = match version {
        1 => bytes.get(24..24 + 520)?,
        2 => {
            let chars = u32::from_le_bytes(bytes.get(24..28)?.try_into().ok()?) as usize;
            bytes.get(28..28 + 2 * chars)?
        }
        _ => return None,
    };
    let units: Vec<u16> = text
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|c| *c != 0)
        .collect();
    path_text(Path::new(&String::from_utf16(&units).ok()?))
}

pub fn downloads_dir(home: &str) -> PathBuf {
    known_folder(&FOLDERID_Downloads)
        .filter(|k| within(k, home))
        .map_or_else(|| PathBuf::from(format!("{home}/Downloads")), PathBuf::from)
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

pub fn plan_locations(home: &str, tmp_base: Option<&str>) -> (HashSet<PathBuf>, HashSet<PathBuf>) {
    let p = places(home);
    let mut exact: HashSet<PathBuf> = pkg_caches(&p)
        .into_iter()
        .chain(linked_caches(&p).into_iter().map(|(path, _)| path))
        .chain(pkg_stores(&p))
        .chain([pnpm_store(&p)])
        .chain(LOGS.iter().map(|rel| format!("{}/{rel}", p.local)))
        .chain(DEV_REVIEW.iter().map(|rel| format!("{}/{rel}", p.local)))
        .chain(DOCKER_DISKS.iter().map(|rel| format!("{}/{rel}", p.local)))
        .map(PathBuf::from)
        .collect();
    exact.extend(app_caches(&p));
    let mut parents: HashSet<PathBuf> = [
        p.local.clone(),
        p.roaming.clone(),
        format!("{}/{EXPLORER}", p.local),
        format!("{}/Packages", p.local),
        format!("{}/JetBrains", p.local),
        format!("{}/Google", p.local),
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect();
    parents.extend(recycle_bins());
    parents.insert(downloads_dir(home));
    parents.extend(tmp_base.map(PathBuf::from));
    (exact, parents)
}

pub(crate) fn scan_trash_and_tools(
    ctx: &Ctx,
    rows: &mut Vec<Row>,
    cfg: &Config,
    _pkg_cache: Option<&str>,
) {
    scan_recycle_bin(ctx, rows);
    scan_pkg(ctx, rows, cfg);
}

pub(crate) fn scan_app_data(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let p = places(&ctx.home);
    scan_caches(ctx, rows, cfg, &p);
    scan_logs_and_ides(ctx, rows, cfg, &p);
    scan_review(ctx, rows, cfg, &p);
    scan_project_output(ctx, rows, cfg);
    scan_other_app_data(ctx, rows, cfg, &p);
    scan_disks(ctx, rows, cfg, &p);
}

pub(crate) fn scan_temp(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config, tmp_base: Option<&str>) {
    let Some(base) = tmp_base.filter(|b| Path::new(b).is_dir()) else {
        return;
    };
    let (old, new): (Vec<PathBuf>, Vec<PathBuf>) = children_of(ctx, Path::new(base))
        .into_iter()
        .filter(|entry| owned_by_user(entry))
        .partition(|entry| idle_days(ctx, entry) >= TEMP_TICKED_DAYS);
    let old_cat = Cat {
        id: "tmp-old",
        title: "Old temp files",
        desc: "Entries in your temp folder that belong to you and are untouched for a week.",
        risk: "safe",
        pre: "1",
    };
    let new_cat = Cat {
        id: "tmp",
        title: "Temp files",
        desc: "Newer entries in your temp folder that belong to you; a running program may still be using one.",
        risk: "review",
        pre: "0",
    };
    for (cat, list) in [(old_cat, old), (new_cat, new)] {
        sized(
            ctx,
            rows,
            &cat,
            &list,
            "Recreated on demand.",
            cfg.min_bytes,
        );
    }
}

fn idle_days(ctx: &Ctx, path: &Path) -> i64 {
    age_of(ctx, path).parse().unwrap_or(0)
}

fn scan_recycle_bin(ctx: &Ctx, rows: &mut Vec<Row>) {
    let cat = Cat {
        id: "trash",
        title: "Recycle Bin",
        desc: "Items already in the Recycle Bin.",
        risk: "safe",
        pre: "1",
    };
    for bin in recycle_bins() {
        for item in children_of(ctx, &bin) {
            let Some(tail) = item
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_prefix("$R"))
            else {
                continue;
            };
            let (Some(s), Some(bytes)) = (path_text(&item), size_bytes(ctx, &item)) else {
                continue;
            };
            if bytes < 1 {
                continue;
            }
            let label = original_path(&bin.join(format!("$I{tail}")))
                .map_or_else(|| s.clone(), |o| tilde(&o, &ctx.home));
            rows.push(row(
                &cat,
                "rm",
                "-",
                &label,
                &s,
                bytes,
                "Permanently removed.",
                &age_of(ctx, &item),
                "exact",
            ));
        }
    }
}

fn mark_estimate(rows: &mut [Row]) {
    for r in rows {
        r[12] = "estimate".to_string();
    }
}

fn scan_pkg(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let p = places(&ctx.home);
    let cat = Cat {
        id: "pkg-cache",
        title: "Package manager caches",
        desc: "Download and build caches for npm, pnpm, yarn, bun, pip, uv, cargo, go, NuGet and friends.",
        risk: "safe",
        pre: "1",
    };
    let list = existing(pkg_caches(&p).into_iter().map(PathBuf::from).collect());
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Re-downloaded on next install.",
        cfg.min_bytes,
    );
    for (path, note) in linked_caches(&p) {
        let start = rows.len();
        sized(
            ctx,
            rows,
            &cat,
            &existing(vec![PathBuf::from(path)]),
            note,
            cfg.min_bytes,
        );
        mark_estimate(&mut rows[start..]);
    }

    let cat = Cat {
        id: "pkg-store",
        title: "Package manager stores",
        desc: "Extracted dependency sources. Safe to delete but slower to restore.",
        risk: "review",
        pre: "0",
    };
    let list = existing(pkg_stores(&p).into_iter().map(PathBuf::from).collect());
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
    let list = existing(vec![PathBuf::from(pnpm_store(&p))]);
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "Existing node_modules keep their hard-linked files, so this frees only packages no project links any more. Every project re-downloads on its next install.",
        cfg.min_bytes,
    );
}

fn scan_caches(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config, p: &Places) {
    let cat = Cat {
        id: "caches",
        title: "Application caches",
        desc: "Browser, graphics driver, thumbnail and app caches. Regenerated automatically; an app that is running keeps its cache in use until it quits.",
        risk: "safe",
        pre: "1",
    };
    let mut list = app_caches(p);
    list.extend(
        children_of(ctx, Path::new(&format!("{}/{EXPLORER}", p.local)))
            .into_iter()
            .filter(|f| {
                f.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                    let n = n.to_ascii_lowercase();
                    n.ends_with(".db") && EXPLORER_CACHES.iter().any(|c| n.starts_with(c))
                })
            }),
    );
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "App rebuilds this on next launch.",
        cfg.min_bytes,
    );
}

struct Ide {
    path: PathBuf,
    product: String,
    version: Vec<u32>,
}

fn ide_folders(dir: &Path, prefix: &str) -> Vec<Ide> {
    real_dirs(dir)
        .into_iter()
        .filter_map(|path| {
            let name = path.file_name()?.to_str()?.to_string();
            let at = name.find(|c: char| c.is_ascii_digit())?;
            let (product, version) = name.split_at(at);
            let version: Vec<u32> = version
                .split('.')
                .map(str::parse)
                .collect::<Result<_, _>>()
                .ok()?;
            (!product.is_empty() && product.starts_with(prefix)).then(|| Ide {
                product: product.to_string(),
                version,
                path,
            })
        })
        .collect()
}

fn scan_logs_and_ides(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config, p: &Places) {
    let old_cat = Cat {
        id: "ide-old",
        title: "Old IDE versions",
        desc: "Cache and index folders of JetBrains IDE and Android Studio versions a newer version replaced, untouched for over 180 days.",
        risk: "safe",
        pre: "1",
    };
    let other_cat = Cat {
        id: "ide-caches",
        title: "IDE caches and local history",
        desc: "Cache and index folders of JetBrains IDEs and Android Studio. They also hold Local History, which is your own data.",
        risk: "review",
        pre: "0",
    };
    let mut logs: Vec<PathBuf> = LOGS
        .iter()
        .map(|rel| PathBuf::from(format!("{}/{rel}", p.local)))
        .collect();
    for (dir, prefix) in IDE_DIRS {
        let folders = ide_folders(Path::new(&format!("{}/{dir}", p.local)), prefix);
        for ide in &folders {
            let replaced = folders
                .iter()
                .any(|other| other.product == ide.product && other.version > ide.version);
            let idle = idle_days(ctx, &ide.path) > IDE_TICKED_DAYS;
            let (cat, note) = if replaced && idle {
                (
                    &old_cat,
                    "A newer version of this IDE is in use. Rebuilt if this version is opened again.",
                )
            } else {
                logs.push(ide.path.join("log"));
                (
                    &other_cat,
                    "Indexes are rebuilt, but Local History in this folder is lost.",
                )
            };
            sized(
                ctx,
                rows,
                cat,
                &existing(vec![ide.path.clone()]),
                note,
                cfg.min_bytes,
            );
        }
    }
    let cat = Cat {
        id: "logs",
        title: "Logs and crash reports",
        desc: "Crash dumps, Windows Error Reporting reports and IDE logs.",
        risk: "safe",
        pre: "1",
    };
    sized(
        ctx,
        rows,
        &cat,
        &existing(logs),
        "Diagnostics only.",
        cfg.min_bytes,
    );
}

fn scan_review(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config, p: &Places) {
    let cat = Cat {
        id: "app-review",
        title: "App and developer data to check",
        desc: "Caches that can also hold state you may want: app local caches, classic Teams, Android emulators, Unity and Unreal caches.",
        risk: "review",
        pre: "0",
    };
    for app in real_dirs(Path::new(&format!("{}/Packages", p.local))) {
        let cache = app.join("LocalCache");
        let (Some(name), Some(s)) = (app.file_name().and_then(|n| n.to_str()), path_text(&cache))
        else {
            continue;
        };
        if !cache.is_dir() {
            continue;
        }
        let Some(bytes) = size_bytes(ctx, &cache).filter(|b| *b >= cfg.min_bytes) else {
            continue;
        };
        let app_name = name.split('_').next().unwrap_or(name);
        rows.push(row(
            &cat,
            "rm",
            "-",
            &format!("{app_name} (local cache)"),
            &s,
            bytes,
            "Not a cache by contract: the app may keep sign-in, offline data or settings here.",
            &age_of(ctx, &cache),
            "exact",
        ));
    }
    let avd = env_dir(
        &p.home,
        "ANDROID_AVD_HOME",
        h(ctx, ".android/avd").to_string_lossy().into_owned(),
    );
    let mut list: Vec<PathBuf> = children_of(ctx, Path::new(&avd))
        .into_iter()
        .filter(|d| d.extension().is_some_and(|x| x == "avd") && d.is_dir())
        .collect();
    list.push(PathBuf::from(format!("{}/Microsoft/Teams", p.roaming)));
    list.extend(
        DEV_REVIEW
            .iter()
            .map(|rel| PathBuf::from(format!("{}/{rel}", p.local))),
    );
    sized(
        ctx,
        rows,
        &cat,
        &existing(list),
        "Rebuilt or re-downloaded, but may hold data you want: check before deleting.",
        cfg.min_bytes,
    );
}

fn scan_project_output(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config) {
    let (unreal, review): (Vec<PathBuf>, Vec<PathBuf>) = artifacts(ctx)
        .iter()
        .filter(|d| is_project_output(d))
        .cloned()
        .partition(|d| {
            d.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| UNREAL_OUTPUT.contains(&n))
        });
    let cat = Cat {
        id: "project-review",
        title: "Project folders to check",
        desc: "Visual Studio .vs folders beside a solution, Unity Library folders, old NuGet packages folders untouched for 90+ days and TestResults beside a test project.",
        risk: "review",
        pre: "0",
    };
    sized(
        ctx,
        rows,
        &cat,
        &review,
        "Rebuilt by the IDE or the build, but may hold per-user settings, a long re-import or test logs: check before deleting.",
        cfg.min_bytes,
    );
    let cat = Cat {
        id: "unreal-projects",
        title: "Unreal project data (report only)",
        desc: "DerivedDataCache, Intermediate and Saved folders beside a .uproject. Listed for awareness — never deleted by this skill.",
        risk: "report",
        pre: "0",
    };
    sized(
        ctx,
        rows,
        &cat,
        &unreal,
        "DerivedDataCache and Intermediate are rebuilt by the editor; Saved holds autosaves and config.",
        1,
    );
}

fn is_known(name: &str, known: &[&str]) -> bool {
    known.iter().any(|k| k.eq_ignore_ascii_case(name))
}

fn scan_other_app_data(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config, p: &Places) {
    let cat = Cat {
        id: "app-data",
        title: "Other app data",
        desc: "Folders apps keep in AppData that disk-clean does not recognise. Some hold only caches; others hold settings or sign-in.",
        risk: "review",
        pre: "0",
    };
    let mut list = Vec::new();
    for (dir, known) in [(&p.local, KNOWN_LOCAL), (&p.roaming, KNOWN_ROAMING)] {
        list.extend(real_dirs(Path::new(dir.as_str())).into_iter().filter(|d| {
            d.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| !is_known(n, known))
                && path_text(d).is_some_and(|s| !platform::is_protected(&s, &ctx.home))
        }));
    }
    sized(
        ctx,
        rows,
        &cat,
        &list,
        "App data, not a cache: may hold settings or sign-in.",
        cfg.min_bytes,
    );
}

fn scan_disks(ctx: &Ctx, rows: &mut Vec<Row>, cfg: &Config, p: &Places) {
    let cat = Cat {
        id: "vm-disks",
        title: "WSL and Docker disks (report only)",
        desc: "Virtual disks of WSL distributions and Docker Desktop. They grow on demand and do not shrink when files inside are deleted. Listed for awareness — never deleted by this skill.",
        risk: "report",
        pre: "0",
    };
    let wsl: Vec<PathBuf> = real_dirs(Path::new(&format!("{}/Packages", p.local)))
        .into_iter()
        .map(|app| app.join("LocalState/ext4.vhdx"))
        .collect();
    sized(
        ctx,
        rows,
        &cat,
        &existing(wsl),
        "Deleting it destroys the distribution. To give space back: wsl --manage <distribution> --set-sparse true, or Optimize-VHD (needs administrator).",
        1,
    );
    let docker: Vec<PathBuf> = DOCKER_DISKS
        .iter()
        .map(|rel| PathBuf::from(format!("{}/{rel}", p.local)))
        .collect();
    sized(
        ctx,
        rows,
        &cat,
        &existing(docker),
        "Holds every Docker image, container and volume. docker system prune frees space inside it; Windows gets it back after Docker Desktop's purge or with a sparse disk.",
        1,
    );
    let cat = Cat {
        id: "pnpm-drive-stores",
        title: "pnpm stores on other drives",
        desc: "pnpm keeps a separate store on each drive that holds projects; node_modules on that drive hard-link into it.",
        risk: "review",
        pre: "0",
    };
    let stores: Vec<PathBuf> = local_disks()
        .into_iter()
        .filter(|root| !p.home.starts_with(root.as_str()))
        .map(|root| PathBuf::from(format!("{root}.pnpm-store")))
        .filter(|store| owned_by_user(store))
        .collect();
    sized(
        ctx,
        rows,
        &cat,
        &existing(stores),
        "Existing node_modules on that drive keep their hard-linked files, so this frees only packages no project links any more. Every project on that drive re-downloads on its next install. pnpm store prune, run in a project on that drive, removes only the unused packages.",
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
