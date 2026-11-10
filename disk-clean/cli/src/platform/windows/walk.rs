use super::path::wide;
use crate::walk::{Kind, Meta};
use std::ffi::{OsString, c_void};
use std::fs;
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::fs::MetadataExt;
use std::path::Path;
use windows::Win32::Foundation::{CloseHandle, ERROR_NO_MORE_FILES, FILETIME, HANDLE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_PINNED,
    FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_RECALL_ON_OPEN,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_ATTRIBUTE_UNPINNED,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_EXTD_DIR_INFO, FILE_ID_INFO,
    FILE_INFO_BY_HANDLE_CLASS, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_STANDARD_INFO, FIND_FIRST_EX_LARGE_FETCH,
    FileAttributeTagInfo, FileIdExtdDirectoryInfo, FileIdExtdDirectoryRestartInfo, FileIdInfo,
    FileStandardInfo, FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW,
    FindNextFileW, GetFileAttributesExW, GetFileExInfoStandard, GetFileInformationByHandleEx,
    OPEN_EXISTING, WIN32_FILE_ATTRIBUTE_DATA, WIN32_FIND_DATAW,
};
use windows::core::PCWSTR;

const NAME_SURROGATE: u32 = 0x2000_0000;
const IO_REPARSE_TAG_CLOUD: u32 = 0x9000_001A;
const CLOUD_TAG_MASK: u32 = 0xFFFF_0FFF;
const NO_OPEN: u32 = FILE_ATTRIBUTE_RECALL_ON_OPEN.0
    | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS.0
    | FILE_ATTRIBUTE_OFFLINE.0;
pub(super) const CLOUD_ATTRS: u32 = FILE_ATTRIBUTE_RECALL_ON_OPEN.0
    | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS.0
    | FILE_ATTRIBUTE_PINNED.0
    | FILE_ATTRIBUTE_UNPINNED.0;
const EPOCH_AS_FILETIME: i64 = 116_444_736_000_000_000;
const TICKS_PER_SECOND: i64 = 10_000_000;

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
    "bin",
    "obj",
    "packages",
    ".vs",
    "TestResults",
    "Library",
    "DerivedDataCache",
    "Intermediate",
    "Saved",
];
pub const ANY_AGE_NAMES: &[&str] = &[
    ".vs",
    "TestResults",
    "Library",
    "DerivedDataCache",
    "Intermediate",
    "Saved",
];
pub(super) const UNREAL_OUTPUT: &[&str] = &["DerivedDataCache", "Intermediate", "Saved"];
const DOTNET_PROJECTS: &[&str] = &["csproj", "fsproj", "vbproj"];
const SOLUTIONS: &[&str] = &["sln", "slnx"];
const UNREAL_PROJECTS: &[&str] = &["uproject"];

pub fn is_build_output(d: &Path) -> bool {
    match d.file_name().and_then(|n| n.to_str()) {
        Some("target") => d.with_file_name("Cargo.toml").is_file(),
        Some("bin" | "obj") => has_sibling(d, |f| has_extension(f, DOTNET_PROJECTS)),
        Some(name) => name != "packages" && !ANY_AGE_NAMES.contains(&name),
        None => true,
    }
}

pub(super) fn is_project_output(d: &Path) -> bool {
    match d.file_name().and_then(|n| n.to_str()) {
        Some(".vs") => has_sibling(d, |f| has_extension(f, SOLUTIONS)),
        Some("Library") => {
            d.with_file_name("Assets").is_dir() && d.with_file_name("ProjectSettings").is_dir()
        }
        Some("packages") => d.with_file_name("packages.config").is_file(),
        Some("TestResults") => has_sibling(d, is_test_project),
        Some(name) if UNREAL_OUTPUT.contains(&name) => {
            has_sibling(d, |f| has_extension(f, UNREAL_PROJECTS))
        }
        _ => false,
    }
}

fn has_extension(file: &Path, wanted: &[&str]) -> bool {
    file.extension()
        .and_then(|x| x.to_str())
        .is_some_and(|x| wanted.iter().any(|w| x.eq_ignore_ascii_case(w)))
}

fn is_test_project(file: &Path) -> bool {
    has_extension(file, DOTNET_PROJECTS)
        && file
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.ends_with("Test") || s.ends_with("Tests"))
}

fn has_sibling(d: &Path, wanted: impl Fn(&Path) -> bool) -> bool {
    d.parent()
        .and_then(|dir| fs::read_dir(dir).ok())
        .is_some_and(|mut list| list.any(|e| e.is_ok_and(|e| wanted(Path::new(&e.file_name())))))
}

const LIST_BUFFER_WORDS: usize = 8192;

fn unix_seconds(ticks: i64) -> i64 {
    (ticks - EPOCH_AS_FILETIME).div_euclid(TICKS_PER_SECOND)
}

fn unix_time(t: FILETIME) -> i64 {
    unix_seconds((i64::from(t.dwHighDateTime) << 32) | i64::from(t.dwLowDateTime))
}

pub(super) fn is_cloud_tag(attrs: u32, tag: u32) -> bool {
    attrs & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 && tag & CLOUD_TAG_MASK == IO_REPARSE_TAG_CLOUD
}

pub(super) fn kind_of(attrs: u32, tag: u32) -> Kind {
    let reparse = attrs & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0;
    if reparse && tag & NAME_SURROGATE != 0 {
        Kind::Symlink
    } else if is_cloud_tag(attrs, tag) {
        Kind::Other
    } else if attrs & FILE_ATTRIBUTE_DIRECTORY.0 != 0 {
        Kind::Dir
    } else {
        Kind::File
    }
}

fn open(name: &[u16], access: u32) -> Option<HANDLE> {
    // SAFETY: CreateFileW reads the NUL-terminated name; it opens for the given metadata or listing access only and never follows a reparse point.
    unsafe {
        CreateFileW(
            PCWSTR(name.as_ptr()),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
        .ok()
    }
}

fn info<T: Default>(handle: HANDLE, class: FILE_INFO_BY_HANDLE_CLASS) -> Option<T> {
    let mut out = T::default();
    // SAFETY: GetFileInformationByHandleEx writes at most size_of::<T>() bytes into out, which is the struct the class names.
    unsafe {
        GetFileInformationByHandleEx(
            handle,
            class,
            (&mut out as *mut T).cast::<c_void>(),
            std::mem::size_of::<T>() as u32,
        )
        .ok()?;
    }
    Some(out)
}

fn close(handle: HANDLE) {
    // SAFETY: the handle came from CreateFileW and is closed exactly once.
    let _ = unsafe { CloseHandle(handle) };
}

pub(super) fn identity(handle: HANDLE) -> Option<(u64, u64, u64)> {
    let id: FILE_ID_INFO = info(handle, FileIdInfo)?;
    let file = u128::from_le_bytes(id.FileId.Identifier);
    Some((id.VolumeSerialNumber, file as u64, (file >> 64) as u64))
}

pub fn dev_and_ino(path: &str) -> io::Result<(u64, u64, u64)> {
    let handle = open(&wide(Path::new(path)), FILE_READ_ATTRIBUTES.0)
        .ok_or_else(io::Error::last_os_error)?;
    let id = identity(handle).ok_or_else(io::Error::last_os_error);
    close(handle);
    id
}

fn find_first(pattern: &[u16], data: &mut WIN32_FIND_DATAW) -> windows::core::Result<HANDLE> {
    // SAFETY: FindFirstFileExW reads the NUL-terminated pattern and writes one WIN32_FIND_DATAW into data.
    unsafe {
        FindFirstFileExW(
            PCWSTR(pattern.as_ptr()),
            FindExInfoBasic,
            (data as *mut WIN32_FIND_DATAW).cast::<c_void>(),
            FindExSearchNameMatch,
            None,
            FIND_FIRST_EX_LARGE_FETCH,
        )
    }
}

pub(super) fn find_one(path: &Path) -> Option<(u32, u32)> {
    let mut data = WIN32_FIND_DATAW::default();
    let find = find_first(&wide(path), &mut data).ok()?;
    // SAFETY: find is the open search handle and is closed exactly once.
    let _ = unsafe { FindClose(find) };
    Some((data.dwFileAttributes, data.dwReserved0))
}

pub(super) fn find_each(dir: &Path) -> Option<Vec<(OsString, u32, u32)>> {
    let mut data = WIN32_FIND_DATAW::default();
    let find = find_first(&wide(&dir.join("*")), &mut data).ok()?;
    let mut out = Vec::new();
    let done = loop {
        out.push((
            super::path::from_wide(&data.cFileName),
            data.dwFileAttributes,
            data.dwReserved0,
        ));
        // SAFETY: find is the open search handle; FindNextFileW writes one WIN32_FIND_DATAW into data.
        if let Err(e) = unsafe { FindNextFileW(find, &mut data) } {
            break e.code() == ERROR_NO_MORE_FILES.to_hresult();
        }
    };
    // SAFETY: find is the open search handle and is closed exactly once.
    let _ = unsafe { FindClose(find) };
    done.then_some(out)
}

fn entry_meta(e: &FILE_ID_EXTD_DIR_INFO, dev: u64) -> Meta {
    let kind = kind_of(e.FileAttributes, e.ReparsePointTag);
    let id = u128::from_le_bytes(e.FileId.Identifier);
    Meta {
        dev,
        ino: id as u64,
        ino_hi: (id >> 64) as u64,
        nlink: if kind == Kind::File { 2 } else { 1 },
        blocks: (e.AllocationSize.max(0) as u64).div_ceil(512),
        size: e.EndOfFile.max(0) as u64,
        mtime: unix_seconds(e.LastWriteTime),
        kind,
    }
}

fn entries_in(buf: &[u64], out: &mut Vec<(OsString, Option<Meta>)>, dev: u64) {
    let bytes = buf.as_ptr().cast::<u8>();
    let mut at = 0usize;
    loop {
        // SAFETY: GetFileInformationByHandleEx filled buf with a chain of FILE_ID_EXTD_DIR_INFO
        // records, each 8-byte aligned and starting NextEntryOffset bytes after the previous one;
        // the name's FileNameLength bytes follow FileName inside the same record.
        let (entry, name) = unsafe {
            let entry = &*bytes.add(at).cast::<FILE_ID_EXTD_DIR_INFO>();
            let name = std::slice::from_raw_parts(
                std::ptr::addr_of!(entry.FileName).cast::<u16>(),
                entry.FileNameLength as usize / 2,
            );
            (entry, OsString::from_wide(name))
        };
        if name != "." && name != ".." {
            out.push((name, Some(entry_meta(entry, dev))));
        }
        if entry.NextEntryOffset == 0 {
            return;
        }
        at += entry.NextEntryOffset as usize;
    }
}

fn list(handle: HANDLE) -> io::Result<Vec<(OsString, Option<Meta>)>> {
    let (dev, _, _) = identity(handle).ok_or_else(io::Error::last_os_error)?;
    let mut buf = vec![0u64; LIST_BUFFER_WORDS];
    let mut class = FileIdExtdDirectoryRestartInfo;
    let mut out = Vec::new();
    loop {
        // SAFETY: buf is 8-byte aligned and the length passed is its size in bytes; the call
        // writes whole FILE_ID_EXTD_DIR_INFO records into it.
        let read = unsafe {
            GetFileInformationByHandleEx(
                handle,
                class,
                buf.as_mut_ptr().cast::<c_void>(),
                (buf.len() * size_of::<u64>()) as u32,
            )
        };
        if read.is_err() {
            let e = io::Error::last_os_error();
            if e.raw_os_error() == Some(ERROR_NO_MORE_FILES.0 as i32) {
                return Ok(out);
            }
            return Err(e);
        }
        entries_in(&buf, &mut out, dev);
        class = FileIdExtdDirectoryInfo;
    }
}

pub fn read_dir_bulk(dir: &Path) -> io::Result<Vec<(OsString, Option<Meta>)>> {
    let handle = open(&wide(dir), FILE_LIST_DIRECTORY.0 | FILE_READ_ATTRIBUTES.0)
        .ok_or_else(io::Error::last_os_error)?;
    let listed = list(handle);
    close(handle);
    listed
}

pub fn meta_at(path: &Path) -> Option<Meta> {
    let name = wide(path);
    let mut data = WIN32_FILE_ATTRIBUTE_DATA::default();
    // SAFETY: GetFileAttributesExW reads the NUL-terminated name and writes one WIN32_FILE_ATTRIBUTE_DATA into data; it never opens the file.
    unsafe {
        GetFileAttributesExW(
            PCWSTR(name.as_ptr()),
            GetFileExInfoStandard,
            (&mut data as *mut WIN32_FILE_ATTRIBUTE_DATA).cast::<c_void>(),
        )
        .ok()?;
    }
    let attrs = data.dwFileAttributes;
    let mut meta = Meta {
        size: (u64::from(data.nFileSizeHigh) << 32) | u64::from(data.nFileSizeLow),
        mtime: unix_time(data.ftLastWriteTime),
        nlink: 1,
        kind: kind_of(attrs, 0),
        ..Meta::default()
    };
    if attrs & NO_OPEN != 0 {
        let parent = open(&wide(path.parent()?), FILE_READ_ATTRIBUTES.0)?;
        let id = identity(parent);
        close(parent);
        meta.dev = id?.0;
        return Some(meta);
    }
    let handle = open(&name, FILE_READ_ATTRIBUTES.0)?;
    let tag = if attrs & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        info::<FILE_ATTRIBUTE_TAG_INFO>(handle, FileAttributeTagInfo).map(|t| t.ReparseTag)
    } else {
        Some(0)
    };
    let id = identity(handle);
    let standard: Option<FILE_STANDARD_INFO> = info(handle, FileStandardInfo);
    close(handle);
    let ((dev, ino, ino_hi), standard) = (id?, standard?);
    meta.kind = kind_of(attrs, tag?);
    meta.dev = dev;
    meta.ino = ino;
    meta.ino_hi = ino_hi;
    meta.blocks = (standard.AllocationSize.max(0) as u64).div_ceil(512);
    if meta.kind == Kind::File {
        meta.nlink = u64::from(standard.NumberOfLinks);
    }
    Some(meta)
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
    let ticks = m.last_write_time() as i64;
    Meta {
        dev: 0,
        ino: 0,
        ino_hi: 0,
        nlink: 1,
        blocks: m.file_size().div_ceil(512),
        size: m.file_size(),
        mtime: unix_seconds(ticks),
        kind,
    }
}
