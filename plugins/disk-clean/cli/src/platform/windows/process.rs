use crate::util::spawn;
use std::fs;
use std::io;
use std::os::windows::io::{AsRawHandle, RawHandle};
use std::os::windows::process::CommandExt;
use std::process::{Child, Command};
use windows::Win32::Foundation::{HANDLE, HANDLE_FLAG_INHERIT, HANDLE_FLAGS, SetHandleInformation};
use windows::Win32::Security::Cryptography::ProcessPrng;
use windows::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize,
};
use windows::Win32::System::Threading::{
    CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, DETACHED_PROCESS, GetCurrentThread,
    SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::{HSTRING, w};

const LOCK_HANDLE: &str = "DISK_CLEAN_LOCK_HANDLE";
const SHELL_EXECUTE_OK: isize = 32;

pub fn utility_qos() {
    // SAFETY: SetThreadPriority on the current-thread pseudo handle only moves the calling thread into background mode; a second call fails harmlessly.
    let _ = unsafe { SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN) };
}

pub fn open_in_browser(url: &str) -> io::Result<()> {
    let url = HSTRING::from(url);
    // SAFETY: COM is initialised for this thread as ShellExecuteW asks and released only if this call initialised it; ShellExecuteW reads the two NUL-terminated strings.
    let opened = unsafe {
        let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        let opened = ShellExecuteW(None, w!("open"), &url, None, None, SW_SHOWNORMAL);
        if com.is_ok() {
            CoUninitialize();
        }
        opened
    };
    if opened.0 as isize > SHELL_EXECUTE_OK {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub fn fill_random(buf: &mut [u8]) {
    // SAFETY: ProcessPrng fills exactly buf.len() bytes of the buffer; it always succeeds.
    let _ = unsafe { ProcessPrng(buf) };
}

pub fn process_cwds() -> Vec<String> {
    Vec::new()
}

pub fn which(name: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths).any(|dir| {
            fs::metadata(dir.join(name).with_extension("exe")).is_ok_and(|m| m.is_file())
        })
    })
}

pub fn spawn_detached(cmd: &mut Command) -> io::Result<Child> {
    for handle in [
        io::stdin().as_raw_handle(),
        io::stdout().as_raw_handle(),
        io::stderr().as_raw_handle(),
    ] {
        set_inherit(handle, false);
    }
    cmd.creation_flags((DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW).0);
    spawn(cmd)
}

fn set_inherit(handle: RawHandle, on: bool) {
    let flags = if on {
        HANDLE_FLAG_INHERIT
    } else {
        HANDLE_FLAGS(0)
    };
    // SAFETY: SetHandleInformation only changes the inherit flag of a handle this process owns.
    let _ = unsafe { SetHandleInformation(HANDLE(handle), HANDLE_FLAG_INHERIT.0, flags) };
}

pub fn pass_lock(cmd: &mut Command, lock: &fs::File) {
    let handle = lock.as_raw_handle();
    set_inherit(handle, true);
    cmd.env(LOCK_HANDLE, (handle as usize).to_string());
}

pub fn keep_lock_from_commands() {
    if let Some(handle) = std::env::var(LOCK_HANDLE)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
    {
        set_inherit(handle as RawHandle, false);
    }
}
