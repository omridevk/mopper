use super::disk::{is_fixed_drive, is_local_disk};
use super::path::{from_wide, same_text, wide};
use super::protected::{RECYCLE_BIN, user_sid};
use crate::platform::{path_text, split_root};
use std::cell::RefCell;
use std::fs;
use std::io;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use windows::Win32::Foundation::{ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION, ERROR_SUCCESS};
use windows::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAGS_AND_ATTRIBUTES, GetDiskFreeSpaceExW,
    GetVolumeNameForVolumeMountPointW, GetVolumePathNameW, MOVE_FILE_FLAGS, MoveFileExW,
    SetFileAttributesW,
};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoCreateInstance, CoInitializeEx,
    CoTaskMemFree, CoUninitialize,
};
use windows::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
use windows::Win32::System::RestartManager::{
    CCH_RM_SESSION_KEY, RM_PROCESS_INFO, RmEndSession, RmGetList, RmRegisterResources,
    RmStartSession,
};
use windows::Win32::UI::Shell::{
    COPYENGINE_E_SHARING_VIOLATION_SRC, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
    FOF_WANTNUKEWARNING, FOFX_RECYCLEONDELETE, FileOperation, IFileOperation,
    IFileOperationProgressSink, IFileOperationProgressSink_Impl, IShellItem,
    SHCreateItemFromParsingName, SHQUERYRBINFO, SHQueryRecycleBinW, SIGDN_FILESYSPATH,
};
use windows::core::{ComObject, HRESULT, HSTRING, PCWSTR, PWSTR, Ref, implement};

pub const RESTORE_BY_HAND: &str = "Restore in the Recycle Bin";

const NO_BIN: &str = "this drive has no Recycle Bin";
const TOO_LARGE: &str = "larger than the Recycle Bin on this drive";
const BIN_OFF: &str = "the Recycle Bin is turned off on this drive";
const BIT_BUCKET: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume";
const MB: u64 = 1 << 20;
const DEFAULT_FULL_RATE_BYTES: u64 = 40 << 30;
const DELETED_FOR_GOOD: &str = "deleted for good: the Recycle Bin did not keep it";

#[derive(Clone)]
pub struct Checked {
    pub path: String,
    pub dev: u64,
    pub ino: u64,
    pub ino_hi: u64,
    pub bytes: u64,
}

fn shell_form(path: &str) -> String {
    path.replace('/', "\\")
}

fn io_error(e: windows::core::Error) -> io::Error {
    let code = e.code().0 as u32;
    if code >> 16 == 0x8007 {
        io::Error::from_raw_os_error((code & 0xFFFF) as i32)
    } else {
        io::Error::other(e)
    }
}

fn is_plain_dir(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|m| m.is_dir() && m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0)
}

pub fn no_follow() -> fs::OpenOptions {
    let mut options = fs::OpenOptions::new();
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0);
    options
}

pub fn create_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)
}

pub fn uid() -> u32 {
    0
}

pub fn same_item(path: &str, dev: u64, ino: u64, ino_hi: u64) -> Option<bool> {
    super::walk::dev_and_ino(path)
        .ok()
        .map(|id| id == (dev, ino, ino_hi))
}

pub fn is_trash_dir(dir: &Path, _home: &str) -> bool {
    let text = dir.to_string_lossy();
    let (drive, bin, sid) = match text.split('/').collect::<Vec<_>>()[..] {
        [drive, bin] => (drive, bin, None),
        [drive, bin, sid] => (drive, bin, Some(sid)),
        _ => return false,
    };
    let drive_letter = matches!(drive.as_bytes(), [letter, b':'] if letter.is_ascii_alphabetic());
    drive_letter
        && same_text(bin, RECYCLE_BIN)
        && sid.is_none_or(|sid| user_sid().is_some_and(|me| same_text(sid, &me)))
        && is_fixed_drive(&format!("{drive}\\"))
        && is_plain_dir(Path::new(&format!("{drive}/{bin}")))
        && is_plain_dir(dir)
}

pub(super) fn bin_folder(root: &str) -> Option<String> {
    let bin = fs::read_dir(root)
        .ok()?
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .find(|name| same_text(name, RECYCLE_BIN))?;
    Some(format!("{root}{bin}"))
}

fn with_identity(dir: &str, item: &Checked) -> io::Result<Option<String>> {
    Ok(fs::read_dir(dir)?
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| name.starts_with("$R"))
        .map(|name| format!("{dir}/{name}"))
        .find(|path| same_item(path, item.dev, item.ino, item.ino_hi) == Some(true)))
}

fn searched(dir: &str, item: &Checked) -> String {
    match with_identity(dir, item) {
        Ok(Some(found)) => format!("{found} has its identity"),
        Ok(None) => format!("no $R entry directly under {dir} has its identity"),
        Err(e) => format!("{dir} could not be listed: {e}"),
    }
}

pub fn find_trashed(item: &Checked, reported: &str) -> Result<String, String> {
    if Path::new(reported)
        .parent()
        .is_some_and(|dir| is_trash_dir(dir, ""))
    {
        return Err(String::new());
    }
    let Some((root, _)) = split_root(&item.path) else {
        return Err(String::new());
    };
    let Some(bin) = bin_folder(root) else {
        return Err(format!("; {root} has no {RECYCLE_BIN}"));
    };
    let own = user_sid().map(|sid| format!("{bin}/{sid}"));
    if let Some(found) = own
        .iter()
        .chain([&bin])
        .find_map(|dir| with_identity(dir, item).ok().flatten())
    {
        return Ok(found);
    }
    let at_reported = match same_item(reported, item.dev, item.ino, item.ino_hi) {
        Some(true) => "the item is at the reported path",
        Some(false) => "something else is at the reported path",
        None => "nothing is at the reported path",
    };
    let in_own = own.map_or_else(
        || "the user's SID is unknown".to_string(),
        |dir| searched(&dir, item),
    );
    Err(format!(
        "; {at_reported}; {in_own}; {}",
        searched(&bin, item)
    ))
}

fn recycle_bin(path: &Path) -> Option<HSTRING> {
    let mut root = vec![0u16; 1024];
    // SAFETY: GetVolumePathNameW reads the NUL-terminated path and writes at most root.len() units.
    unsafe { GetVolumePathNameW(PCWSTR(wide(path).as_ptr()), &mut root) }.ok()?;
    let root = from_wide(&root).to_string_lossy().into_owned();
    let root = root.strip_prefix(r"\\?\").unwrap_or(&root);
    let drive_root =
        matches!(root.as_bytes(), [letter, b':', b'\\'] if letter.is_ascii_alphabetic());
    if !drive_root || !is_local_disk(root) {
        return None;
    }
    let root = HSTRING::from(root);
    let mut info = SHQUERYRBINFO {
        cbSize: size_of::<SHQUERYRBINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: SHQueryRecycleBinW reads the NUL-terminated root and fills info, whose cbSize is set.
    unsafe { SHQueryRecycleBinW(&root, &mut info) }.ok()?;
    Some(root)
}

fn bin_value(volume: &str, name: &str) -> Option<u32> {
    let key = HSTRING::from(format!(r"{BIT_BUCKET}\{volume}"));
    let mut value = 0u32;
    let mut size = size_of::<u32>() as u32;
    // SAFETY: RegGetValueW only reads the key and value names and writes one DWORD into value.
    let read = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            &key,
            &HSTRING::from(name),
            RRF_RT_REG_DWORD,
            None,
            Some((&raw mut value).cast()),
            Some(&mut size),
        )
    };
    (read == ERROR_SUCCESS).then_some(value)
}

fn default_capacity(root: &HSTRING) -> Option<u64> {
    let mut total = 0u64;
    // SAFETY: GetDiskFreeSpaceExW reads the NUL-terminated root and writes one u64.
    unsafe { GetDiskFreeSpaceExW(root, None, Some(&mut total), None) }.ok()?;
    let first = total.min(DEFAULT_FULL_RATE_BYTES);
    Some(first / 10 + (total - first) / 20)
}

fn bin_limit(root: &HSTRING) -> Result<u64, &'static str> {
    let mut name = [0u16; 64];
    // SAFETY: GetVolumeNameForVolumeMountPointW reads the NUL-terminated root, writes into name only.
    unsafe { GetVolumeNameForVolumeMountPointW(root, &mut name) }.map_err(|_| NO_BIN)?;
    let name = from_wide(&name).to_string_lossy().into_owned();
    let volume = name
        .find('{')
        .and_then(|start| {
            name[start..]
                .find('}')
                .map(|end| &name[start..=start + end])
        })
        .ok_or(NO_BIN)?;
    if bin_value(volume, "NukeOnDelete") == Some(1) {
        return Err(BIN_OFF);
    }
    match bin_value(volume, "MaxCapacity") {
        Some(mb) => Ok(u64::from(mb) * MB),
        None => default_capacity(root).ok_or(NO_BIN),
    }
}

fn bin_problem(path: &Path, bytes: u64) -> Option<&'static str> {
    let Some(root) = recycle_bin(path) else {
        return Some(NO_BIN);
    };
    match bin_limit(&root) {
        Err(why) => Some(why),
        Ok(limit) => (bytes > limit).then_some(TOO_LARGE),
    }
}

fn holders(path: &str) -> Vec<String> {
    let mut session = 0u32;
    let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
    // SAFETY: key has room for CCH_RM_SESSION_KEY characters and the NUL.
    if unsafe { RmStartSession(&mut session, None, PWSTR(key.as_mut_ptr())) } != ERROR_SUCCESS {
        return Vec::new();
    }
    let names = holders_in(session, path);
    // SAFETY: session was started above and is ended once.
    let _ = unsafe { RmEndSession(session) };
    names
}

fn holders_in(session: u32, path: &str) -> Vec<String> {
    let file = HSTRING::from(path);
    // SAFETY: the one file name stays alive for the call.
    let registered =
        unsafe { RmRegisterResources(session, Some(&[PCWSTR(file.as_ptr())]), None, None) };
    if registered != ERROR_SUCCESS {
        return Vec::new();
    }
    let (mut needed, mut count, mut reasons) = (0u32, 0u32, 0u32);
    // SAFETY: a null list of length 0 only asks for the needed length.
    let _ = unsafe { RmGetList(session, &mut needed, &mut count, None, &mut reasons) };
    let mut list = vec![RM_PROCESS_INFO::default(); needed as usize];
    count = needed;
    // SAFETY: list holds count entries.
    let listed = unsafe {
        RmGetList(
            session,
            &mut needed,
            &mut count,
            Some(list.as_mut_ptr()),
            &mut reasons,
        )
    };
    if listed != ERROR_SUCCESS {
        return Vec::new();
    }
    let mut names: Vec<String> = list
        .iter()
        .take(count as usize)
        .map(|p| from_wide(&p.strAppName).to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .collect();
    names.sort();
    names.dedup();
    names
}

fn in_use(path: &str) -> String {
    let names = holders(path);
    if names.is_empty() {
        "in use by another program".to_string()
    } else {
        format!("in use: close {} and retry", names.join(", "))
    }
}

fn is_in_use(hr: HRESULT) -> bool {
    hr == HRESULT::from_win32(ERROR_SHARING_VIOLATION.0)
        || hr == HRESULT::from_win32(ERROR_LOCK_VIOLATION.0)
        || hr == COPYENGINE_E_SHARING_VIOLATION_SRC
}

fn path_of(item: &IShellItem) -> Option<String> {
    // SAFETY: GetDisplayName returns a CoTaskMemAlloc'd string, copied here and freed once.
    unsafe {
        let name = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let text = name.to_string().ok();
        CoTaskMemFree(Some(name.0.cast_const().cast()));
        text
    }
}

#[implement(IFileOperationProgressSink)]
struct Sink {
    seen: RefCell<Option<(HRESULT, Option<String>)>>,
}

impl IFileOperationProgressSink_Impl for Sink_Impl {
    fn StartOperations(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn FinishOperations(&self, _: HRESULT) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreRenameItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostRenameItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreMoveItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostMoveItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreCopyItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostCopyItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreDeleteItem(&self, _: u32, _: Ref<IShellItem>) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostDeleteItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        hr: HRESULT,
        created: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        self.seen
            .replace(Some((hr, created.as_ref().and_then(path_of))));
        Ok(())
    }
    fn PreNewItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostNewItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: &PCWSTR,
        _: u32,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn UpdateProgress(&self, _: u32, _: u32) -> windows::core::Result<()> {
        Ok(())
    }
    fn ResetTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn PauseTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn ResumeTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
}

fn recycle(path: &str) -> Result<String, String> {
    let refused = |e: windows::core::Error| e.message();
    let sink = ComObject::new(Sink {
        seen: RefCell::new(None),
    });
    // SAFETY: call_trash initialised COM apartment-threaded on this thread; every object made
    // here is released before this function returns.
    let done = unsafe {
        let op: IFileOperation =
            CoCreateInstance(&FileOperation, None, CLSCTX_ALL).map_err(refused)?;
        let item: IShellItem =
            SHCreateItemFromParsingName(&HSTRING::from(path), None).map_err(refused)?;
        op.SetOperationFlags(
            FOFX_RECYCLEONDELETE
                | FOF_NOCONFIRMATION
                | FOF_SILENT
                | FOF_NOERRORUI
                | FOF_WANTNUKEWARNING,
        )
        .map_err(refused)?;
        op.DeleteItem(&item, &sink.to_interface::<IFileOperationProgressSink>())
            .map_err(refused)?;
        op.PerformOperations()
    };
    let seen = sink.seen.take();
    let hr = match (&seen, &done) {
        (Some((hr, _)), _) => *hr,
        (None, Err(e)) => e.code(),
        (None, Ok(())) => HRESULT(0),
    };
    if is_in_use(hr) {
        return Err(in_use(path));
    }
    hr.ok().map_err(refused)?;
    match seen {
        Some((_, Some(landed))) => Ok(path_text(Path::new(&landed)).unwrap_or(landed)),
        Some((_, None)) => Err(DELETED_FOR_GOOD.to_string()),
        None => Err("the Recycle Bin did not report the move".to_string()),
    }
}

fn trash_one(item: &Checked) -> Result<String, String> {
    if same_item(&item.path, item.dev, item.ino, item.ino_hi) != Some(true) {
        return Err("it changed after the check".to_string());
    }
    if let Some(problem) = bin_problem(Path::new(&item.path), item.bytes) {
        return Err(problem.to_string());
    }
    recycle(&shell_form(&item.path))
}

pub fn call_trash(paths: &[Checked]) -> Vec<Result<String, String>> {
    // SAFETY: no reserved pointer; a success is balanced by CoUninitialize below on this thread.
    let init = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    if init.is_err() {
        let why = format!("the Recycle Bin could not be reached: {}", init.message());
        return paths.iter().map(|_| Err(why.clone())).collect();
    }
    let landed = paths.iter().map(trash_one).collect();
    // SAFETY: balances the successful CoInitializeEx above; trash_one released every COM object.
    unsafe { CoUninitialize() };
    landed
}

pub fn rename_excl(from: &Path, to: &Path) -> io::Result<()> {
    let (from, to) = (wide(from), wide(to));
    // SAFETY: MoveFileExW only reads the two NUL-terminated paths; no flag replaces or copies.
    unsafe {
        MoveFileExW(
            PCWSTR(from.as_ptr()),
            PCWSTR(to.as_ptr()),
            MOVE_FILE_FLAGS(0),
        )
    }
    .map_err(io_error)
}

pub fn make_removable(path: &Path) {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return;
    };
    let attrs = meta.file_attributes();
    if attrs & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return;
    }
    if attrs & FILE_ATTRIBUTE_READONLY.0 != 0 {
        let cleared = match attrs & !FILE_ATTRIBUTE_READONLY.0 {
            0 => FILE_ATTRIBUTE_NORMAL,
            rest => FILE_FLAGS_AND_ATTRIBUTES(rest),
        };
        // SAFETY: SetFileAttributesW only reads the NUL-terminated path; the entry is no reparse point.
        let _ = unsafe { SetFileAttributesW(PCWSTR(wide(path).as_ptr()), cleared) };
    }
    if !meta.is_dir() {
        return;
    }
    let Ok(list) = fs::read_dir(path) else {
        return;
    };
    for entry in list.flatten() {
        make_removable(&entry.path());
    }
}

pub fn drop_trash_info(trashed: &Path) {
    let (Some(dir), Some(name)) = (
        trashed.parent(),
        trashed.file_name().and_then(|n| n.to_str()),
    ) else {
        return;
    };
    if let Some(rest) = name.strip_prefix("$R") {
        let _ = fs::remove_file(dir.join(format!("$I{rest}")));
    }
}
