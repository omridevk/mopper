use crate::clean::{already_trashed, inside};
use std::fs;
use std::sync::{Mutex, PoisonError};

const PERSONAL: &[&str] = &[
    "desktop",
    "documents",
    "pictures",
    "music",
    "videos",
    "templates",
    "public",
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".claude",
    ".config/gh",
    ".config/gcloud",
    ".local/share/keyrings",
    ".gnome2/keyrings",
    ".local/share/kwalletd",
    ".password-store",
    ".pki",
    ".config/google-chrome",
    ".config/chromium",
    ".mozilla",
    ".thunderbird",
    ".local/share/evolution",
    "maildir",
    "mail",
    ".docker",
    ".cache/disk-clean",
    ".android",
];
const HF_TOKENS: &[&str] = &["huggingface/token", "huggingface/stored_tokens"];
const USER_DIRS: &[&str] = &[
    "DESKTOP",
    "DOCUMENTS",
    "PICTURES",
    "MUSIC",
    "VIDEOS",
    "TEMPLATES",
    "PUBLICSHARE",
];
const SYSTEM: &[&str] = &[
    "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/var", "/opt", "/boot", "/root", "/srv",
    "/snap", "/proc", "/sys", "/dev", "/run", "/nix",
];

type UserDirs = Vec<(String, String)>;

static LAST_USER_DIRS: Mutex<Option<(String, String, UserDirs)>> = Mutex::new(None);

pub(super) fn user_dirs(home: &str) -> UserDirs {
    let config = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|d| d.starts_with('/'))
        .unwrap_or_else(|| format!("{home}/.config"));
    let file = format!("{config}/user-dirs.dirs");
    let mut last = LAST_USER_DIRS
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if let Some((cached_file, cached_home, dirs)) = last.as_ref()
        && *cached_file == file
        && cached_home == home
    {
        return dirs.clone();
    }
    let dirs = read_user_dirs(&file, home);
    *last = Some((file, home.to_string(), dirs.clone()));
    dirs
}

fn read_user_dirs(file: &str, home: &str) -> UserDirs {
    let Ok(text) = fs::read_to_string(file) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| {
            let (key, value) = line.trim().split_once('=')?;
            let name = key.strip_prefix("XDG_")?.strip_suffix("_DIR")?;
            let value = value.strip_prefix('"')?.strip_suffix('"')?;
            let path = match value.strip_prefix("$HOME") {
                Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{home}{rest}"),
                Some(_) => return None,
                None => value.to_string(),
            };
            let path = path.trim_end_matches('/');
            path.starts_with('/')
                .then(|| (name.to_string(), path.to_string()))
        })
        .collect()
}

pub fn is_protected(p: &str, raw_home: &str) -> bool {
    let (p, home) = (p.to_ascii_lowercase(), raw_home.to_ascii_lowercase());
    if p == home || inside(&home, &p) {
        return true;
    }
    let personal = p.strip_prefix(&format!("{home}/")).is_some_and(|rest| {
        let rooted = format!("/{rest}");
        PERSONAL
            .iter()
            .any(|name| rest == *name || inside(rest, name))
            || HF_TOKENS
                .iter()
                .any(|t| rooted.ends_with(&format!("/{t}")) || rooted.contains(&format!("/{t}/")))
    });
    personal
        || user_dirs(raw_home)
            .into_iter()
            .filter(|(name, _)| USER_DIRS.contains(&name.as_str()))
            .map(|(_, dir)| dir.to_ascii_lowercase())
            .any(|dir| p == dir || inside(&p, &dir))
}

pub fn in_allowed_root(p: &str, home: &str, _tmp_base: Option<&str>) -> bool {
    if inside(p, "/tmp") || inside(p, "/var/tmp") || already_trashed(p, home) {
        return true;
    }
    inside(p, home)
        && !SYSTEM
            .iter()
            .any(|s| (p == *s || inside(p, s)) && !inside(home, s))
}
