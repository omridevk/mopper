use serde::Serialize;
use std::fs;
use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::Path;

pub fn no_follow() -> fs::OpenOptions {
    let mut options = fs::OpenOptions::new();
    options.custom_flags(libc::O_NOFOLLOW);
    options
}

pub fn create_private_dir(dir: &Path) -> io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

pub fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

pub fn dev_and_ino(path: &str) -> io::Result<(u64, u64, u64)> {
    fs::symlink_metadata(path).map(|m| (m.dev(), m.ino(), 0))
}

pub fn same_item(path: &str, dev: u64, ino: u64, ino_hi: u64) -> Option<bool> {
    dev_and_ino(path).ok().map(|id| id == (dev, ino, ino_hi))
}

#[derive(Serialize, Clone)]
pub struct Checked {
    pub path: String,
    pub dev: u64,
    pub ino: u64,
    #[serde(skip)]
    pub ino_hi: u64,
    #[serde(skip)]
    pub bytes: u64,
}

pub fn find_trashed(_item: &Checked, _reported: &str) -> Result<String, String> {
    Err(String::new())
}
