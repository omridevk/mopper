use std::net::TcpListener;
use std::os::windows::io::AsRawSocket;
use windows::Win32::Networking::WinSock::{POLLRDNORM, SOCKET, WSAPOLLFD, WSAPoll};

pub fn wait_for_connection(listener: &TcpListener) {
    let mut waiting = WSAPOLLFD {
        fd: SOCKET(listener.as_raw_socket() as usize),
        events: POLLRDNORM,
        revents: Default::default(),
    };
    // SAFETY: WSAPoll reads and writes only the one WSAPOLLFD it is given.
    unsafe { WSAPoll(&mut waiting, 1, -1) };
}
