use super::path::{at_or_within, known_folder, wide, within};
use crate::platform::{VolumeStats, path_text, split_root};
use std::fs;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU32, Ordering};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetTempPath2W, GetVolumeInformationW,
    QueryDosDeviceW,
};
use windows::Win32::UI::Shell::FOLDERID_Windows;
use windows::core::{HSTRING, PCWSTR};

const DRIVE_FIXED: u32 = 3;
const MAX_PATH: usize = 260;

pub fn volume_stats(path: &Path) -> Option<VolumeStats> {
    let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
    let name = wide(path);
    // SAFETY: GetDiskFreeSpaceExW reads the NUL-terminated name and writes the three locals.
    unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR(name.as_ptr()),
            Some(&mut avail),
            Some(&mut total),
            Some(&mut free),
        )
        .ok()?;
    }
    Some(VolumeStats {
        total,
        used: total.saturating_sub(free),
        avail,
    })
}

pub fn data_mount() -> PathBuf {
    let home = crate::util::home();
    PathBuf::from(split_root(&home).map_or("C:/", |(root, _)| root))
}

pub(super) fn is_fixed_drive(root: &str) -> bool {
    let name = HSTRING::from(root.replace('/', "\\"));
    // SAFETY: GetDriveTypeW only reads the NUL-terminated root name.
    unsafe { GetDriveTypeW(&name) == DRIVE_FIXED }
}

fn is_subst(letter: u8) -> bool {
    let mut target = [0u16; 1024];
    let device = HSTRING::from(format!("{}:", char::from(letter)));
    // SAFETY: QueryDosDeviceW reads the NUL-terminated device name and writes at most target.len() units.
    let len = unsafe { QueryDosDeviceW(&device, Some(&mut target)) } as usize;
    len > 0
        && super::path::from_wide(&target[..len])
            .to_string_lossy()
            .starts_with(r"\??\")
}

pub(super) fn drive_roots() -> impl Iterator<Item = String> {
    // SAFETY: GetLogicalDrives has no preconditions and only returns a bitmask.
    let drives = unsafe { GetLogicalDrives() };
    (0..26u8)
        .filter(move |i| drives & (1 << i) != 0 && !is_subst(b'A' + i))
        .map(|i| format!("{}:/", char::from(b'A' + i)))
}

pub(super) fn is_local_disk(root: &str) -> bool {
    static CONFIRMED: AtomicU32 = AtomicU32::new(0);
    let Some(letter) = root
        .bytes()
        .next()
        .filter(u8::is_ascii_alphabetic)
        .map(|l| l.to_ascii_uppercase())
    else {
        return false;
    };
    let bit = 1u32 << (letter - b'A');
    if CONFIRMED.load(Ordering::Relaxed) & bit != 0 {
        return true;
    }
    let root = format!("{}:\\", char::from(letter));
    let mut fs_name = [0u16; 261];
    let local = !is_subst(letter)
        && is_fixed_drive(&root)
        // SAFETY: GetVolumeInformationW reads the NUL-terminated root and writes into fs_name only.
        && unsafe {
            GetVolumeInformationW(&HSTRING::from(&root), None, None, None, None, Some(&mut fs_name))
        }
        .is_ok()
        && ["NTFS", "ReFS"].contains(&super::path::from_wide(&fs_name).to_string_lossy().as_ref());
    if local {
        CONFIRMED.fetch_or(bit, Ordering::Relaxed);
    }
    local
}

static CHOSEN: OnceLock<u32> = OnceLock::new();

pub fn choose_drives(list: &str) -> Result<(), String> {
    if list.eq_ignore_ascii_case("all") {
        return Ok(());
    }
    let mut chosen = 0u32;
    for name in list
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|n| !n.is_empty())
    {
        let [letter @ (b'a'..=b'z' | b'A'..=b'Z')] = name.as_bytes() else {
            return Err(format!("--drives {name}: not a drive letter"));
        };
        let letter = letter.to_ascii_uppercase();
        let drive = char::from(letter);
        if !is_local_disk(&format!("{drive}:/")) {
            return Err(format!(
                "--drives: {drive}: is not a fixed local NTFS or ReFS drive"
            ));
        }
        chosen |= 1 << (letter - b'A');
    }
    if chosen == 0 {
        return Err("--drives takes drive letters (C,D or \"C D\") or all".to_string());
    }
    let _ = CHOSEN.set(chosen);
    Ok(())
}

pub(super) fn local_disks() -> Vec<String> {
    drive_roots()
        .filter(|root| {
            CHOSEN
                .get()
                .is_none_or(|chosen| chosen & 1 << (root.as_bytes()[0] - b'A') != 0)
        })
        .filter(|root| is_local_disk(root))
        .collect()
}

pub fn user_tmp_base() -> Option<String> {
    let mut buf = [0u16; MAX_PATH + 1];
    // SAFETY: GetTempPath2W writes at most buf.len() characters into buf.
    let len = unsafe { GetTempPath2W(Some(&mut buf)) } as usize;
    if len == 0 || len > buf.len() {
        return None;
    }
    let raw = super::path::from_wide(&buf[..len]);
    let tmp = path_text(&fs::canonicalize(&raw).ok()?)?;
    let home = crate::util::home();
    if home.is_empty() || at_or_within(&home, &tmp) || crate::util::is_root(&tmp) {
        return None;
    }
    if within(&tmp, &home) {
        return Some(tmp);
    }
    let in_windows = known_folder(&FOLDERID_Windows).is_some_and(|w| at_or_within(&tmp, &w));
    let (root, _) = split_root(&tmp)?;
    (!in_windows && is_fixed_drive(root)).then_some(tmp)
}

pub fn file_id(file: &fs::File) -> Option<u128> {
    let (_, low, high) = super::walk::identity(HANDLE(file.as_raw_handle()))?;
    Some(u128::from(high) << 64 | u128::from(low))
}
