use crate::platform::VolumeStats;
use crate::util::output;
use std::ffi::{CStr, CString};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

pub fn volume_stats(path: &Path) -> Option<VolumeStats> {
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: statfs fills the zeroed struct; we read it only on success.
    let s = unsafe {
        let mut s: libc::statfs = std::mem::zeroed();
        if libc::statfs(c.as_ptr(), &mut s) != 0 {
            return None;
        }
        s
    };
    let bsize = s.f_bsize as u64;
    let kb = |n: u64| n * bsize / 1024 * 1024;
    let used = match space_used(&c) {
        Some(bytes) => bytes / 1024 * 1024,
        None => kb(s.f_blocks.saturating_sub(s.f_bfree)),
    };
    Some(VolumeStats {
        total: kb(s.f_blocks),
        used,
        avail: kb(s.f_bavail),
    })
}

fn space_used(path: &CStr) -> Option<u64> {
    let mut list = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: 0,
        volattr: libc::ATTR_VOL_INFO | libc::ATTR_VOL_SPACEUSED,
        dirattr: 0,
        fileattr: 0,
        forkattr: 0,
    };
    let mut buf = [0u8; 16];
    // SAFETY: getattrlist writes at most buf.len() bytes into buf.
    let rc = unsafe {
        libc::getattrlist(
            path.as_ptr(),
            (&mut list as *mut libc::attrlist).cast(),
            buf.as_mut_ptr().cast(),
            buf.len(),
            0,
        )
    };
    let bytes: [u8; 8] = buf[4..12].try_into().ok()?;
    (rc == 0).then(|| i64::from_ne_bytes(bytes).max(0) as u64)
}

pub fn data_mount() -> PathBuf {
    let data = Path::new("/System/Volumes/Data");
    if data.is_dir() && volume_stats(data).is_some() {
        data.to_path_buf()
    } else {
        PathBuf::from("/")
    }
}

pub fn user_tmp_base() -> Option<String> {
    let (ok, out) = output("getconf", &["DARWIN_USER_TEMP_DIR"])?;
    let d = out.trim_end_matches('\n');
    if !ok || d.is_empty() {
        return None;
    }
    let d = d.strip_suffix('/').unwrap_or(d);
    let parent = Path::new(d).parent()?.to_str()?.to_string();
    if parent.starts_with("/var/folders/") {
        Some(format!("/private{parent}"))
    } else if parent.starts_with("/private/var/folders/") {
        Some(parent)
    } else {
        None
    }
}
