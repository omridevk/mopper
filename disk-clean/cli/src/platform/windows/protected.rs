use super::disk::{is_fixed_drive, is_local_disk, local_disks};
use super::path::{
    at_or_within, at_or_within16, known_folder, same_text, same16, text16, user_folder, wide,
    within, within16,
};
use super::walk::{CLOUD_ATTRS, find_each, find_one, is_cloud_tag, kind_of};
use crate::platform::split_root;
use crate::walk::Kind;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT,
};
use windows::Win32::Security::{
    EqualSid, GetTokenInformation, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
    TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows::Win32::Storage::FileSystem::GetLongPathNameW;
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::UI::Shell::{
    FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_LocalAppData, FOLDERID_Music, FOLDERID_Pictures,
    FOLDERID_ProgramData, FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86, FOLDERID_RoamingAppData,
    FOLDERID_SkyDrive, FOLDERID_UserProfiles, FOLDERID_Videos, FOLDERID_Windows,
};
use windows::core::{GUID, PCWSTR, PWSTR};

const PERSONAL: &[(&GUID, &str)] = &[
    (&FOLDERID_Documents, "Documents"),
    (&FOLDERID_Desktop, "Desktop"),
    (&FOLDERID_Pictures, "Pictures"),
    (&FOLDERID_Music, "Music"),
    (&FOLDERID_Videos, "Videos"),
];
const IN_HOME: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".azure",
    ".claude",
    ".docker",
    ".cache/disk-clean",
    ".rustup",
    ".cargo/bin",
    ".pyenv/pyenv-win",
    ".vscode",
    ".vscode-shared",
];
const IN_ROAMING: &[&str] = &[
    "gnupg",
    "Microsoft/Protect",
    "Microsoft/Credentials",
    "Microsoft/Crypto",
    "Microsoft/SystemCertificates",
    "Mozilla/Firefox/Profiles",
    "Thunderbird/Profiles",
    "Bitwarden",
    "KeePass",
    "JetBrains",
    "npm",
    "nvm",
];
const IN_LOCAL: &[&str] = &[
    "Microsoft/Credentials",
    "Microsoft/Vault",
    "Microsoft/Outlook",
    "1Password",
    "Docker/wsl",
    "nvm",
    "Volta",
    "Android/Sdk",
    "Programs",
];
const ROOT_ENV: &[&str] = &[
    "OneDrive",
    "OneDriveConsumer",
    "OneDriveCommercial",
    "NVM_HOME",
    "NVM_SYMLINK",
    "VOLTA_HOME",
    "ANDROID_HOME",
];
const SCOOP_KEEP: &[&str] = &["apps", "persist", "shims", "buckets"];
const NEVER_EXTENSIONS: &[&str] = &["pst", "ost", "kdbx", "vhdx", "vhd"];
const BROWSER_CACHES: &[&str] = &[
    "*/Cache",
    "*/Code Cache",
    "*/GPUCache",
    "ShaderCache",
    "GrShaderCache",
];
const LOCAL_CACHES_ONLY: &[(&str, &[&str])] = &[
    ("Google/Chrome/User Data", BROWSER_CACHES),
    ("Microsoft/Edge/User Data", BROWSER_CACHES),
    ("Packages", &["*/TempState", "*/LocalCache"]),
    ("Microsoft/VisualStudio", &["*/ComponentModelCache"]),
];
const ROAMING_CACHES_ONLY: &[(&str, &[&str])] = &[
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
const SYSTEM: &[&GUID] = &[
    &FOLDERID_Windows,
    &FOLDERID_ProgramFiles,
    &FOLDERID_ProgramFilesX86,
    &FOLDERID_ProgramData,
];
pub(super) const RECYCLE_BIN: &str = "$Recycle.Bin";
const SYSTEM_VOLUME_INFORMATION: &str = "System Volume Information";
const NEVER_AT_ROOT: &[&str] = &[
    "Windows",
    "Program Files",
    "Program Files (x86)",
    "ProgramData",
    "$WinREAgent",
    "Recovery",
    "PerfLogs",
    "pagefile.sys",
    "hiberfil.sys",
    "swapfile.sys",
];

fn app_data(home: &str, var: &str, id: &GUID, default: &str) -> Vec<String> {
    let mut bases = vec![format!("{home}/{default}")];
    for base in [user_folder(var, id), known_folder(id)]
        .into_iter()
        .flatten()
    {
        if !bases.iter().any(|b| same_text(b, &base)) {
            bases.push(base);
        }
    }
    bases
}

fn local_bases(home: &str) -> Vec<String> {
    app_data(
        home,
        "LOCALAPPDATA",
        &FOLDERID_LocalAppData,
        "AppData/Local",
    )
}

fn roaming_bases(home: &str) -> Vec<String> {
    app_data(home, "APPDATA", &FOLDERID_RoamingAppData, "AppData/Roaming")
}

fn env_root(name: &str) -> Option<String> {
    std::env::var_os(name).and_then(|v| crate::platform::path_text(Path::new(&v)))
}

fn never_roots(home: &str) -> Vec<String> {
    let mut roots: Vec<String> = PERSONAL
        .iter()
        .flat_map(|(id, name)| [known_folder(id), Some(format!("{home}/{name}"))])
        .flatten()
        .collect();
    roots.extend(known_folder(&FOLDERID_SkyDrive));
    roots.push(format!("{home}/OneDrive"));
    roots.extend(ROOT_ENV.iter().filter_map(|name| env_root(name)));
    roots.extend(IN_HOME.iter().map(|rel| format!("{home}/{rel}")));
    let scoop = env_root("SCOOP").unwrap_or_else(|| format!("{home}/scoop"));
    roots.extend(SCOOP_KEEP.iter().map(|rel| format!("{scoop}/{rel}")));
    for base in roaming_bases(home) {
        roots.extend(IN_ROAMING.iter().map(|rel| format!("{base}/{rel}")));
    }
    for base in local_bases(home) {
        roots.extend(IN_LOCAL.iter().map(|rel| format!("{base}/{rel}")));
    }
    roots
}

fn matches(rel: &str, pattern: &str) -> bool {
    let (rel, pattern): (Vec<&str>, Vec<&str>) =
        (rel.split('/').collect(), pattern.split('/').collect());
    rel.len() >= pattern.len()
        && pattern
            .iter()
            .zip(&rel)
            .all(|(want, have)| *want == "*" || same_text(want, have))
}

fn outside_caches(p: &[u16], root: &[u16], caches: &[&str]) -> bool {
    same16(p, root)
        || (within16(p, root)
            && String::from_utf16(&p[root.len() + 1..])
                .is_ok_and(|rel| !caches.iter().any(|c| matches(&rel, c))))
}

struct Rules {
    home: Vec<u16>,
    app_data: Vec<Vec<u16>>,
    caches_only: Vec<(Vec<u16>, &'static [&'static str])>,
    never: Vec<Vec<u16>>,
    temp: Vec<Vec<u16>>,
    profiles: Option<Vec<u16>>,
    system: Vec<Vec<u16>>,
}

fn cache_roots(
    bases: &[String],
    rules: &[(&str, &'static [&'static str])],
) -> Vec<(Vec<u16>, &'static [&'static str])> {
    bases
        .iter()
        .flat_map(|base| {
            rules
                .iter()
                .map(move |(rel, caches)| (text16(&format!("{base}/{rel}")), *caches))
        })
        .collect()
}

fn build_rules(home: &str) -> Rules {
    let (local, roaming) = (local_bases(home), roaming_bases(home));
    let mut caches = cache_roots(&local, LOCAL_CACHES_ONLY);
    caches.extend(cache_roots(&roaming, ROAMING_CACHES_ONLY));
    Rules {
        home: text16(home),
        app_data: [format!("{home}/AppData")]
            .iter()
            .chain(&local)
            .chain(&roaming)
            .map(|base| text16(base))
            .collect(),
        caches_only: caches,
        never: never_roots(home).iter().map(|root| text16(root)).collect(),
        temp: local
            .iter()
            .map(|base| text16(&format!("{base}/Temp")))
            .collect(),
        profiles: known_folder(&FOLDERID_UserProfiles).map(|users| text16(&users)),
        system: SYSTEM
            .iter()
            .filter_map(|id| known_folder(id))
            .filter(|s| !at_or_within(home, s))
            .map(|s| text16(&s))
            .collect(),
    }
}

fn rules(home: &str) -> Arc<Rules> {
    static BUILT: Mutex<Vec<(String, Arc<Rules>)>> = Mutex::new(Vec::new());
    let mut built = BUILT.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((_, rules)) = built.iter().find(|(known, _)| known == home) {
        return Arc::clone(rules);
    }
    let rules = Arc::new(build_rules(home));
    built.push((home.to_string(), Arc::clone(&rules)));
    rules
}

fn short_name(p: &str) -> bool {
    let mut end = 0;
    for part in p.split('/') {
        end += part.len();
        if part.contains('~') {
            let prefix = wide(Path::new(&p[..end]));
            let mut long = vec![0u16; 32_768];
            // SAFETY: GetLongPathNameW reads the NUL-terminated prefix and writes at most long.len() characters into long.
            let len =
                unsafe { GetLongPathNameW(PCWSTR(prefix.as_ptr()), Some(&mut long)) } as usize;
            let resolved = (len > 0 && len < long.len())
                .then(|| {
                    crate::platform::path_text(Path::new(&super::path::from_wide(&long[..len])))
                })
                .flatten();
            if !resolved.is_some_and(|r| same_text(&r, &p[..end])) {
                return true;
            }
        }
        end += 1;
    }
    false
}

fn is_cloud(attrs: u32, tag: u32) -> bool {
    attrs & CLOUD_ATTRS != 0 || is_cloud_tag(attrs, tag)
}

struct Listing {
    cloud: Vec<String>,
    links: HashMap<String, bool>,
}

thread_local! {
    static FOLDERS: RefCell<Option<HashMap<PathBuf, Option<Listing>>>> = const { RefCell::new(None) };
}

pub fn planning<T>(plan: impl FnOnce() -> T) -> T {
    FOLDERS.set(Some(HashMap::new()));
    let planned = plan();
    FOLDERS.set(None);
    planned
}

fn listing(dir: &Path) -> Option<Listing> {
    let mut listed = Listing {
        cloud: Vec::new(),
        links: HashMap::new(),
    };
    for (name, attrs, tag) in find_each(dir)? {
        let Ok(name) = name.into_string() else {
            continue;
        };
        if is_cloud(attrs, tag) {
            listed.cloud.push(name.clone());
        }
        listed
            .links
            .insert(name, kind_of(attrs, tag) == Kind::Symlink);
    }
    Some(listed)
}

fn listed<T>(at: &Path, answer: impl FnOnce(&Listing, &str) -> T) -> Option<T> {
    let (dir, name) = (at.parent()?, at.file_name()?.to_str()?);
    FOLDERS.with_borrow_mut(|folders| {
        let folders = folders.as_mut()?;
        if !folders.contains_key(dir) {
            folders.insert(dir.to_path_buf(), listing(dir));
        }
        folders[dir].as_ref().map(|listing| answer(listing, name))
    })
}

fn listed_cloud(at: &Path) -> Option<bool> {
    listed(at, |listing, name| {
        listing.cloud.iter().any(|n| same_text(n, name))
    })
}

pub fn is_link(p: &Path) -> Option<bool> {
    let from_listing = listed(p, |listing, name| {
        // ponytail: a name missing exactly is matched by a scan of the folder; only gone items pay it.
        listing.links.get(name).copied().or_else(|| {
            listing
                .links
                .iter()
                .find(|(listed, _)| same_text(listed, name))
                .map(|(_, link)| *link)
        })
    });
    from_listing.unwrap_or_else(|| {
        fs::symlink_metadata(p)
            .ok()
            .map(|m| m.file_type().is_symlink())
    })
}

fn in_cloud(p: &str, home: &str) -> bool {
    let mut at = Path::new(p);
    loop {
        let cloud = listed_cloud(at)
            .unwrap_or_else(|| find_one(at).is_some_and(|(attrs, tag)| is_cloud(attrs, tag)));
        if cloud {
            return true;
        }
        match at.parent() {
            Some(up) if crate::platform::path_text(up).is_some_and(|u| within(&u, home)) => at = up,
            _ => return false,
        }
    }
}

pub fn is_protected(p: &str, home: &str) -> bool {
    let (rules, p16) = (rules(home), text16(p));
    if at_or_within16(&rules.home, &p16) {
        return true;
    }
    let never_ext = Path::new(p)
        .extension()
        .and_then(|x| x.to_str())
        .is_some_and(|x| NEVER_EXTENSIONS.iter().any(|n| x.eq_ignore_ascii_case(n)));
    never_ext
        || rules.app_data.iter().any(|base| same16(&p16, base))
        || rules
            .caches_only
            .iter()
            .any(|(root, caches)| outside_caches(&p16, root, caches))
        || rules.never.iter().any(|root| at_or_within16(&p16, root))
        || short_name(p)
        || in_cloud(p, home)
}

fn in_own_recycle_bin(p: &str) -> bool {
    let (Some((root, rest)), Some(sid)) = (split_root(p), user_sid()) else {
        return false;
    };
    within(rest, &format!("{RECYCLE_BIN}/{sid}")) && is_fixed_drive(root)
}

fn in_system(p: &str, p16: &[u16], rules: &Rules) -> bool {
    let Some((_, rest)) = split_root(p) else {
        return true;
    };
    let other_profile = rules
        .profiles
        .as_ref()
        .is_some_and(|users| within16(p16, users) && !at_or_within16(p16, &rules.home));
    other_profile
        || at_or_within(rest, SYSTEM_VOLUME_INFORMATION)
        || NEVER_AT_ROOT.iter().any(|name| at_or_within(rest, name))
        || (at_or_within(rest, RECYCLE_BIN) && !in_own_recycle_bin(p))
        || rules.system.iter().any(|s| at_or_within16(p16, s))
}

fn real_text(p: &str) -> Option<String> {
    crate::platform::path_text(&fs::canonicalize(p).ok()?)
}

fn named_at_root(root: &str) -> Vec<String> {
    fs::read_dir(root)
        .map(|list| {
            list.flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|name| {
                    NEVER_AT_ROOT
                        .iter()
                        .chain(&[SYSTEM_VOLUME_INFORMATION, RECYCLE_BIN])
                        .any(|never| same_text(name, never))
                })
                .map(|name| format!("{root}{name}"))
                .collect()
        })
        .unwrap_or_default()
}

fn other_profiles(home: &str) -> Vec<String> {
    let Some(users) = known_folder(&FOLDERID_UserProfiles) else {
        return Vec::new();
    };
    fs::read_dir(&users)
        .map(|list| {
            list.flatten()
                .filter_map(|e| crate::platform::path_text(&e.path()))
                .filter(|profile| !at_or_within(home, profile))
                .collect()
        })
        .unwrap_or_default()
}

pub fn drives_to_walk(home: &str) -> (Vec<PathBuf>, HashSet<PathBuf>) {
    let drives = local_disks();
    let mut never: Vec<String> = drives.iter().flat_map(|root| named_at_root(root)).collect();
    never.extend(other_profiles(home));
    never.extend(
        SYSTEM
            .iter()
            .filter_map(|id| known_folder(id))
            .chain(never_roots(home))
            .filter(|root| !at_or_within(root, home))
            .filter_map(|root| real_text(&root)),
    );
    let never = never
        .into_iter()
        .filter(|root| !at_or_within(home, root))
        .map(PathBuf::from)
        .collect();
    (drives.into_iter().map(PathBuf::from).collect(), never)
}

pub fn belongs_to_user(path: &Path, home: &str) -> bool {
    crate::platform::path_text(path).is_some_and(|p| within(&p, home)) || owned_by_user(path)
}

fn owned_or_restored_into_owned(p: &Path) -> bool {
    if is_link(p).is_some() {
        return owned_by_user(p);
    }
    p.parent().is_some_and(owned_by_user)
}

fn on_own_local_disk(p: &str) -> bool {
    split_root(p).is_some_and(|(root, rest)| {
        !rest.is_empty() && is_local_disk(root) && owned_or_restored_into_owned(Path::new(p))
    })
}

pub fn in_allowed_root(p: &str, home: &str, tmp_base: Option<&str>) -> bool {
    let (rules, p16) = (rules(home), text16(p));
    if in_system(p, &p16, &rules) {
        return false;
    }
    let tmp_base = tmp_base.filter(|t| !t.is_empty());
    let temp_folder = rules.temp.iter().any(|temp| at_or_within16(&p16, temp))
        || tmp_base.is_some_and(|temp| at_or_within(p, temp));
    (within16(&p16, &rules.home) && !temp_folder)
        || tmp_base.is_some_and(|t| within(p, t))
        || in_own_recycle_bin(p)
        || (!at_or_within16(&p16, &rules.home) && !temp_folder && on_own_local_disk(p))
}

fn token_user() -> Option<&'static [u64]> {
    static USER: OnceLock<Option<Vec<u64>>> = OnceLock::new();
    USER.get_or_init(read_token_user).as_deref()
}

fn read_token_user() -> Option<Vec<u64>> {
    let mut token = HANDLE::default();
    // SAFETY: OpenProcessToken writes the token handle of this process into the local.
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()? };
    let mut len = 0u32;
    // SAFETY: the first call only reports the size the TOKEN_USER needs; the second writes at most len bytes into buf, which is 8-byte aligned for TOKEN_USER and at least len bytes long; the token is closed exactly once.
    unsafe {
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        let read = GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr().cast::<c_void>()),
            len,
            &mut len,
        );
        let _ = CloseHandle(token);
        read.ok().map(|()| buf)
    }
}

fn user_sid_of(token_user: &[u64]) -> PSID {
    // SAFETY: token_user holds a TOKEN_USER written by GetTokenInformation, whose Sid points inside the same buffer.
    unsafe { (*token_user.as_ptr().cast::<TOKEN_USER>()).User.Sid }
}

pub(super) fn user_sid() -> Option<String> {
    static SID: OnceLock<Option<String>> = OnceLock::new();
    SID.get_or_init(|| {
        let user = token_user()?;
        let mut text = PWSTR::null();
        // SAFETY: ConvertSidToStringSidW reads the SID inside user and returns a LocalAlloc'd string we read once and free.
        unsafe {
            ConvertSidToStringSidW(user_sid_of(user), &mut text).ok()?;
            let sid = text.to_string().ok();
            LocalFree(Some(HLOCAL(text.0.cast())));
            sid
        }
    })
    .clone()
}

pub(super) fn owned_by_user(path: &Path) -> bool {
    let Some(user) = token_user() else {
        return false;
    };
    let name = wide(path);
    let mut owner = PSID::default();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    // SAFETY: GetNamedSecurityInfoW reads the NUL-terminated name and returns an owner SID pointing into a LocalAlloc'd descriptor, freed once after EqualSid reads both SIDs.
    unsafe {
        let read = GetNamedSecurityInfoW(
            PCWSTR(name.as_ptr()),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            None,
            None,
            &mut descriptor,
        );
        let same = read.is_ok() && EqualSid(owner, user_sid_of(user)).is_ok();
        if !descriptor.0.is_null() {
            LocalFree(Some(HLOCAL(descriptor.0)));
        }
        same
    }
}
