use crate::util::{self, spawn};
use std::io;
use std::process::Command;

pub fn utility_qos() {
    // SAFETY: pthread_set_qos_class_self_np only changes the calling thread's scheduling class.
    unsafe { libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0) };
}

pub fn open_in_browser(url: &str) -> io::Result<()> {
    spawn(Command::new("open").arg(url))
        .and_then(|mut c| c.wait())
        .map(drop)
}

pub fn fill_random(buf: &mut [u8]) {
    // SAFETY: arc4random_buf fills exactly buf.len() bytes of the buffer.
    unsafe { libc::arc4random_buf(buf.as_mut_ptr().cast(), buf.len()) };
}

pub fn process_cwds() -> Vec<String> {
    let uid = crate::platform::uid().to_string();
    util::output("lsof", &["-a", "-d", "cwd", "-u", &uid, "-Fn"])
        .map(|(_, out)| {
            out.lines()
                .filter_map(|l| l.strip_prefix('n'))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}
