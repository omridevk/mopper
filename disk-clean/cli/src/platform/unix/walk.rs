use crate::walk::{Kind, Meta};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

pub const DEV_NAMES: &[&str] = &[
    ".venv",
    "venv",
    "target",
    ".next",
    ".nuxt",
    ".turbo",
    ".svelte-kit",
    ".parcel-cache",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
];
pub const ANY_AGE_NAMES: &[&str] = &[];

pub fn is_build_output(d: &Path) -> bool {
    d.file_name().is_none_or(|n| n != "target") || d.with_file_name("Cargo.toml").is_file()
}

pub fn meta_at(path: &Path) -> Option<Meta> {
    fs::symlink_metadata(path).ok().map(|m| meta_of(&m))
}

pub fn meta_of(m: &fs::Metadata) -> Meta {
    let t = m.file_type();
    let kind = if t.is_symlink() {
        Kind::Symlink
    } else if t.is_dir() {
        Kind::Dir
    } else if t.is_file() {
        Kind::File
    } else {
        Kind::Other
    };
    Meta {
        dev: m.dev(),
        ino: m.ino(),
        ino_hi: 0,
        nlink: m.nlink(),
        blocks: m.blocks(),
        size: m.size(),
        mtime: m.mtime(),
        kind,
    }
}
