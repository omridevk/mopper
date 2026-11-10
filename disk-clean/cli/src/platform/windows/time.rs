use std::ffi::{CStr, c_char};

unsafe extern "C" {
    fn strftime(buf: *mut c_char, max: usize, fmt: *const c_char, tm: *const libc::tm) -> usize;
    #[link_name = "_mktime64"]
    fn mktime(tm: *mut libc::tm) -> libc::time_t;
}

pub fn local_time(fmt: &CStr) -> String {
    let mut buf = [0u8; 64];
    // SAFETY: time/localtime_s/strftime write only into the locals passed to them.
    let len = unsafe {
        let t = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_s(&mut tm, &t);
        strftime(buf.as_mut_ptr().cast(), buf.len(), fmt.as_ptr(), &tm)
    };
    String::from_utf8_lossy(&buf[..len]).into_owned()
}

pub fn local_midnights(now: i64, days: usize) -> Vec<i64> {
    // SAFETY: libc::tm is plain integers, so all zeroes is a valid value.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: localtime_s reads now and writes only the local tm.
    unsafe { libc::localtime_s(&mut tm, &now) };
    let today = tm.tm_mday;
    (0..days as i32)
        .map(|d| {
            let mut t = tm;
            (t.tm_hour, t.tm_min, t.tm_sec, t.tm_isdst) = (0, 0, 0, -1);
            t.tm_mday = today - d;
            // SAFETY: mktime reads and normalises only the local copy t.
            unsafe { mktime(&mut t) }
        })
        .collect()
}

pub fn day_label(midnight: i64) -> String {
    let mut buf = [0u8; 16];
    // SAFETY: localtime_s/strftime write only into the locals passed to them.
    let len = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_s(&mut tm, &midnight);
        strftime(
            buf.as_mut_ptr().cast(),
            buf.len(),
            c"%Y-%m-%d".as_ptr(),
            &tm,
        )
    };
    String::from_utf8_lossy(&buf[..len]).into_owned()
}
