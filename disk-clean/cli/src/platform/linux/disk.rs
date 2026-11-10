use crate::platform::VolumeStats;
use std::ffi::CString;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

pub fn volume_stats(path: &Path) -> Option<VolumeStats> {
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: statvfs fills the zeroed struct; we read it only on success.
    let s = unsafe {
        let mut s: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut s) != 0 {
            return None;
        }
        s
    };
    let frsize = s.f_frsize as u64;
    let kb = |n: u64| n * frsize / 1024 * 1024;
    Some(VolumeStats {
        total: kb(s.f_blocks as u64),
        used: kb((s.f_blocks as u64).saturating_sub(s.f_bfree as u64)),
        avail: kb(s.f_bavail as u64),
    })
}

pub fn data_mount() -> PathBuf {
    let mut mount = PathBuf::from(crate::util::home());
    let Ok(dev) = fs::metadata(&mount).map(|m| m.dev()) else {
        return PathBuf::from("/");
    };
    while let Some(parent) = mount.parent()
        && fs::metadata(parent).is_ok_and(|m| m.dev() == dev)
    {
        mount = parent.to_path_buf();
    }
    mount
}

pub fn user_tmp_base() -> Option<String> {
    None
}
