use std::ffi::CStr;

pub fn local_time(fmt: &CStr) -> String {
    let mut buf = [0u8; 64];
    // SAFETY: time/localtime_r/strftime write only into the locals passed to them.
    let len = unsafe {
        let t = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        libc::strftime(buf.as_mut_ptr().cast(), buf.len(), fmt.as_ptr(), &tm)
    };
    String::from_utf8_lossy(&buf[..len]).into_owned()
}

pub fn local_midnights(now: i64, days: usize) -> Vec<i64> {
    // SAFETY: localtime_r/mktime read and write only the local tm.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&now, &mut tm) };
    let today = tm.tm_mday;
    (0..days as i32)
        .map(|d| {
            let mut t = tm;
            (t.tm_hour, t.tm_min, t.tm_sec, t.tm_isdst) = (0, 0, 0, -1);
            t.tm_mday = today - d;
            // SAFETY: as above.
            unsafe { libc::mktime(&mut t) }
        })
        .collect()
}

pub fn day_label(midnight: i64) -> String {
    let mut buf = [0u8; 16];
    // SAFETY: localtime_r/strftime write only into the locals passed to them.
    let len = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&midnight, &mut tm);
        libc::strftime(
            buf.as_mut_ptr().cast(),
            buf.len(),
            c"%Y-%m-%d".as_ptr(),
            &tm,
        )
    };
    String::from_utf8_lossy(&buf[..len]).into_owned()
}
