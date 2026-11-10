use crate::util::spawn;
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::process::Command;

pub fn utility_qos() {
    // SAFETY: setpriority on PRIO_PROCESS with this thread's id only changes the calling thread's nice value.
    unsafe { libc::setpriority(libc::PRIO_PROCESS, libc::gettid() as libc::id_t, 10) };
}

pub fn open_in_browser(url: &str) -> io::Result<()> {
    let mut child = spawn(Command::new("xdg-open").arg(url))?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

pub fn fill_random(buf: &mut [u8]) {
    let mut filled = 0;
    while filled < buf.len() {
        let rest = &mut buf[filled..];
        // SAFETY: getrandom writes at most rest.len() bytes into rest.
        let n = unsafe { libc::getrandom(rest.as_mut_ptr().cast(), rest.len(), 0) };
        match usize::try_from(n) {
            Ok(n) => filled += n,
            Err(_) => {
                let e = io::Error::last_os_error();
                assert!(e.kind() == io::ErrorKind::Interrupted, "getrandom: {e}");
            }
        }
    }
}

pub fn process_cwds() -> Vec<String> {
    let uid = crate::platform::uid();
    let Ok(procs) = fs::read_dir("/proc") else {
        return Vec::new();
    };
    procs
        .flatten()
        .filter(|p| {
            p.file_name()
                .to_str()
                .is_some_and(|n| n.bytes().all(|b| b.is_ascii_digit()))
        })
        .filter(|p| p.metadata().is_ok_and(|m| m.uid() == uid))
        .filter_map(|p| fs::read_link(p.path().join("cwd")).ok())
        .filter_map(|cwd| cwd.into_os_string().into_string().ok())
        .collect()
}
