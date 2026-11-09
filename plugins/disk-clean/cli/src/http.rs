use crate::platform;
use crate::util;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

pub const LINE_MAX: usize = 256 * 1024;
pub const HEAD_MAX: usize = 16 * 1024;
const DRAIN_MAX: usize = 8 << 20;
const DRAIN_TIME: Duration = Duration::from_secs(2);
pub const BODY_MAX: usize = 1 << 20;
pub const REQUEST_TIME: Duration = Duration::from_secs(10);
pub const CONNECTIONS: usize = 64;

const TOO_LARGE_HEAD: &str = "431 Request Header Fields Too Large";
const TOO_LARGE_BODY: &str = "413 Content Too Large";
const TOO_SLOW: &str = "408 Request Timeout";
const BAD: &str = "400 Bad Request";

pub struct Request {
    pub method: String,
    pub target: String,
    pub host: String,
    pub origin: Option<String>,
    pub json: bool,
    pub body: Vec<u8>,
}

pub fn respond(stream: &mut TcpStream, status: &str, kind: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.0 {status}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
}

const TOO_LONG_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Address too long</title><body style=\"font:15px system-ui;margin:3rem;max-width:40rem\"><h1 style=\"font-size:1.3rem\">This address is too long for disk-clean</h1><p>The address carries your selection, and this one is longer than disk-clean accepts. Nothing was deleted.</p><p><a href=\"/\">Open disk-clean without the selection</a></p>";

fn drain(stream: &mut TcpStream) {
    let _ = stream.shutdown(std::net::Shutdown::Write);
    let deadline = Instant::now() + DRAIN_TIME;
    let mut chunk = [0u8; 16 * 1024];
    let mut left = DRAIN_MAX;
    while left > 0 {
        let wait = deadline.saturating_duration_since(Instant::now());
        if wait.is_zero() || stream.set_read_timeout(Some(wait)).is_err() {
            return;
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => left = left.saturating_sub(n),
        }
    }
}

pub fn refuse(stream: &mut TcpStream, status: &str) {
    if status == TOO_LARGE_HEAD {
        respond(
            stream,
            status,
            "text/html; charset=utf-8",
            TOO_LONG_PAGE.as_bytes(),
        );
    } else {
        let text = status.split_once(' ').map_or(status, |(_, t)| t);
        respond(stream, status, "text/plain", text.to_lowercase().as_bytes());
    }
    if status == TOO_LARGE_HEAD || status == TOO_LARGE_BODY {
        drain(stream);
    }
}

fn read_more(
    stream: &mut TcpStream,
    buf: &mut Vec<u8>,
    deadline: Instant,
) -> Result<(), Option<&'static str>> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err(Some(TOO_SLOW));
    }
    let _ = stream.set_read_timeout(Some(left));
    let mut chunk = [0u8; 4096];
    match stream.read(&mut chunk) {
        Ok(0) => Err(None),
        Ok(n) => {
            buf.extend_from_slice(&chunk[..n]);
            Ok(())
        }
        Err(e)
            if matches!(
                e.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
            ) =>
        {
            Err(Some(TOO_SLOW))
        }
        Err(_) => Err(None),
    }
}

fn find(buf: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    let start = from.saturating_sub(needle.len() - 1);
    buf.get(start..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|i| start + i)
}

fn oversized(buf: &[u8], line_end: Option<usize>) -> bool {
    match line_end {
        Some(line) => line > LINE_MAX || buf.len() - line > HEAD_MAX,
        None => buf.len() > LINE_MAX,
    }
}

fn is_json(content_type: &str) -> bool {
    content_type
        .split(';')
        .next()
        .is_some_and(|t| t.trim().eq_ignore_ascii_case("application/json"))
}

pub fn read_request(stream: &mut TcpStream) -> Result<Request, Option<&'static str>> {
    let deadline = Instant::now() + REQUEST_TIME;
    let mut buf = Vec::new();
    let (mut searched, mut line_end) = (0, None);
    let end = loop {
        line_end = line_end.or_else(|| find(&buf, searched, b"\r\n"));
        if let Some(end) = find(&buf, searched, b"\r\n\r\n") {
            break end + 4;
        }
        if oversized(&buf, line_end) {
            return Err(Some(TOO_LARGE_HEAD));
        }
        searched = buf.len();
        read_more(stream, &mut buf, deadline)?;
    };
    if oversized(&buf[..end], line_end) {
        return Err(Some(TOO_LARGE_HEAD));
    }
    let head = std::str::from_utf8(&buf[..end]).map_err(|_| Some(BAD))?;
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split_whitespace();
    let method = first.next().unwrap_or("").to_string();
    let target = first.next().unwrap_or("").to_string();
    let (mut hosts, mut origin, mut json, mut length) = (Vec::new(), None, false, 0usize);
    for (name, value) in lines.filter_map(|l| l.split_once(':')) {
        let (name, value) = (name.trim().to_ascii_lowercase(), value.trim());
        match name.as_str() {
            "host" => hosts.push(value.to_string()),
            "origin" => origin = Some(value.to_string()),
            "content-type" => json = is_json(value),
            "content-length" => length = value.parse().map_err(|_| Some(BAD))?,
            _ => {}
        }
    }
    let [host] = hosts.as_slice() else {
        return Err(Some(BAD));
    };
    if length > BODY_MAX {
        return Err(Some(TOO_LARGE_BODY));
    }
    while buf.len() < end + length {
        read_more(stream, &mut buf, deadline)?;
    }
    let _ = stream.set_read_timeout(None);
    Ok(Request {
        method,
        target,
        host: host.clone(),
        origin,
        json,
        body: buf[end..end + length].to_vec(),
    })
}

pub fn is_local_host(req: &Request, port: u16) -> bool {
    [format!("127.0.0.1:{port}"), format!("localhost:{port}")]
        .iter()
        .any(|allowed| req.host.eq_ignore_ascii_case(allowed))
}

pub fn is_trusted_post(req: &Request) -> bool {
    let own_origin = format!("http://{}", req.host);
    req.json
        && req
            .origin
            .as_deref()
            .is_none_or(|o| o.eq_ignore_ascii_case(&own_origin))
}

pub fn is_own_origin_post(req: &Request, port: u16) -> bool {
    is_local_host(req, port)
        && req.json
        && req
            .origin
            .as_deref()
            .is_some_and(|o| o.eq_ignore_ascii_case(&format!("http://{}", req.host)))
}

pub fn client_gone(stream: &TcpStream) -> bool {
    if stream.set_nonblocking(true).is_err() {
        return true;
    }
    let gone = match stream.peek(&mut [0u8; 1]) {
        Ok(0) => true,
        Ok(_) => false,
        Err(e) => e.kind() != io::ErrorKind::WouldBlock,
    };
    let _ = stream.set_nonblocking(false);
    gone
}

fn turn_away(mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
    let _ = stream.read(&mut [0u8; HEAD_MAX]);
    let text = "service unavailable";
    respond(
        &mut stream,
        "503 Service Unavailable",
        "text/plain",
        text.as_bytes(),
    );
}

fn accept(listener: &TcpListener) -> io::Result<TcpStream> {
    platform::wait_for_connection(listener);
    let (stream, _) = util::with_fd_lock(|| listener.accept())?;
    stream.set_nonblocking(false)?;
    Ok(stream)
}

pub fn serve(listener: TcpListener, handle: impl Fn(TcpStream) + Send + Sync + 'static) {
    let handle = Arc::new(handle);
    let open = Arc::new(AtomicUsize::new(0));
    if let Err(e) = listener.set_nonblocking(true) {
        eprintln!("could not make the listener non-blocking: {e}");
        return;
    }
    loop {
        let Ok(stream) = accept(&listener) else {
            continue;
        };
        if open.load(Ordering::SeqCst) >= CONNECTIONS {
            turn_away(stream);
            continue;
        }
        open.fetch_add(1, Ordering::SeqCst);
        let (handle, open) = (Arc::clone(&handle), Arc::clone(&open));
        std::thread::spawn(move || {
            handle(stream);
            open.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

pub fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub const POST_ROUTES: [&str; 6] = ["/decide", "/preview", "/rescan", "/undo", "/empty", "/stop"];

pub const STREAMS: [&str; 2] = ["/events", "/clean-events"];

pub fn is_page_route(route: &str) -> bool {
    route.starts_with('/') && !STREAMS.contains(&route) && !POST_ROUTES.contains(&route)
}

pub fn query_token(target: &str) -> &str {
    target
        .split_once('?')
        .map_or("", |(_, q)| q)
        .split('&')
        .find_map(|kv| kv.strip_prefix("token="))
        .unwrap_or("")
}
