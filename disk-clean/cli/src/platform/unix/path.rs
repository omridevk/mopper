use std::path::Path;

pub fn raw_home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

pub fn path_text(p: &Path) -> Option<String> {
    p.to_str().map(str::to_string)
}

pub fn split_root(p: &str) -> Option<(&str, &str)> {
    p.starts_with('/').then(|| p.split_at(1))
}
