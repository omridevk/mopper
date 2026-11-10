use std::net::TcpListener;
use std::os::fd::AsRawFd;

pub fn wait_for_connection(listener: &TcpListener) {
    let mut waiting = libc::pollfd {
        fd: listener.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: poll reads and writes only the one pollfd it is given.
    unsafe { libc::poll(&mut waiting, 1, -1) };
}
