use crate::clean::inside;

const PERSONAL: &[&str] = &[
    "documents",
    "desktop",
    "pictures",
    "movies",
    "music",
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".claude",
    "library/mail",
    "library/messages",
];
const SYSTEM: &[&str] = &[
    "/System",
    "/Library",
    "/Applications",
    "/usr",
    "/bin",
    "/sbin",
    "/etc",
    "/var",
    "/private",
    "/opt",
];

pub fn is_protected(p: &str, home: &str) -> bool {
    let (p, home) = (p.to_ascii_lowercase(), home.to_ascii_lowercase());
    if p == home || inside(&home, &p) {
        return true;
    }
    let Some(rest) = p.strip_prefix(&format!("{home}/")) else {
        return false;
    };
    let personal = PERSONAL
        .iter()
        .any(|name| rest == *name || inside(rest, name));
    let keychains = rest == "library"
        || rest
            .strip_prefix("library/")
            .is_some_and(|r| r.contains("keychains"));
    personal || keychains
}

pub fn in_allowed_root(p: &str, home: &str, tmp_base: Option<&str>) -> bool {
    let in_user_temp = tmp_base.filter(|b| !b.is_empty()).is_some_and(|base| {
        ["T", "C", "X"]
            .iter()
            .any(|sub| inside(p, &format!("{base}/{sub}")))
    });
    if inside(p, "/private/tmp") || in_user_temp {
        return true;
    }
    inside(p, home) && !SYSTEM.iter().any(|s| p == *s || inside(p, s))
}
