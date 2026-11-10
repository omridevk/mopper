use crate::util::spawn;
use std::fs;
use std::io;
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};

const LOCK_FD: &str = "DISK_CLEAN_LOCK_FD";
pub const LOCK_INHERITS: bool = true;

pub fn which(name: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths).any(|dir| {
            fs::metadata(dir.join(name)).is_ok_and(|m| {
                m.is_file()
                    && std::os::unix::fs::PermissionsExt::mode(&m.permissions()) & 0o111 != 0
            })
        })
    })
}

pub fn spawn_detached(cmd: &mut Command) -> io::Result<Child> {
    // SAFETY: setsid is async-signal-safe and only detaches the child into its own session.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    spawn(cmd)
}

pub fn pass_lock(cmd: &mut Command, lock: &fs::File) {
    let fd = lock.as_raw_fd();
    cmd.env(LOCK_FD, fd.to_string());
    // SAFETY: in the forked child, fcntl only clears close-on-exec on the lock fd so the worker inherits the lock.
    unsafe {
        cmd.pre_exec(move || match libc::fcntl(fd, libc::F_SETFD, 0) {
            -1 => Err(io::Error::last_os_error()),
            _ => Ok(()),
        });
    }
}

pub fn keep_lock_from_commands() {
    if let Some(fd) = std::env::var(LOCK_FD)
        .ok()
        .and_then(|v| v.parse::<RawFd>().ok())
    {
        // SAFETY: only sets close-on-exec on the inherited lock fd, so commands the worker runs never hold the lock.
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    }
}
