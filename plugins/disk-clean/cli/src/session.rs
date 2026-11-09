use crate::clean;
use crate::http;
use crate::platform;
use crate::util;
use serde_json::{Value, json};
use std::fs;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const LOCK: &str = "session.lock";
const FILE: &str = "session.json";
const NOTICES: &str = "notices";
const WAIT_EVERY: Duration = Duration::from_millis(200);
const TAIL_EVERY: Duration = Duration::from_millis(100);
const HEARTBEAT: Duration = Duration::from_secs(15);
const STOP_WITHIN: Duration = Duration::from_secs(10);
pub const ENDED: i32 = 5;
pub const CLOSED: i32 = 3;

pub fn claim(dir: &Path) -> io::Result<Option<fs::File>> {
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(LOCK))?;
    Ok(file.try_lock().is_ok().then_some(file))
}

pub fn is_open(dir: &Path) -> bool {
    !clean::lock_is_free(&dir.join(LOCK))
}

fn owner_only() -> fs::OpenOptions {
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options
}

pub fn write(dir: &Path, port: u16, token: &str) -> io::Result<()> {
    let info = json!({"port": port, "token": token, "pid": std::process::id()});
    owner_only()
        .open(dir.join(FILE))?
        .write_all(info.to_string().as_bytes())
}

pub fn close(dir: &Path) {
    let _ = fs::remove_file(dir.join(FILE));
}

fn claimed(marker: &Path) -> bool {
    fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(marker)
        .is_ok()
}

pub fn notice(dir: &Path, kind: &str, line: &str) {
    let notices = dir.join(NOTICES);
    if let Err(e) = fs::create_dir_all(&notices) {
        eprintln!("disk-clean: could not record a notice for Claude: {e}");
        return;
    }
    let body = json!({"kind": kind, "line": line}).to_string();
    for k in 1.. {
        let path = notices.join(format!("{k}.json"));
        match fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
        {
            Ok(mut file) => {
                if let Err(e) = file.write_all(body.as_bytes()) {
                    eprintln!("disk-clean: could not record a notice for Claude: {e}");
                }
                return;
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                eprintln!("disk-clean: could not record a notice for Claude: {e}");
                return;
            }
        }
    }
}

fn notices(dir: &Path) -> Vec<(u64, PathBuf)> {
    let mut found: Vec<(u64, PathBuf)> = fs::read_dir(dir.join(NOTICES))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let n = e
                .file_name()
                .to_str()?
                .strip_suffix(".json")?
                .parse()
                .ok()?;
            Some((n, e.path()))
        })
        .collect();
    found.sort_unstable();
    found
}

fn next_notice(dir: &Path) -> Option<Value> {
    notices(dir).into_iter().find_map(|(_, path)| {
        let body: Value = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
        claimed(&path.with_extension("woke")).then_some(body)
    })
}

fn run_dir_of(run_dir: Option<String>, name: &str) -> Result<PathBuf, i32> {
    let Some(dir) = run_dir.filter(|d| !d.is_empty()) else {
        eprintln!("usage: disk-clean {name} RUN_DIR");
        return Err(2);
    };
    let dir = PathBuf::from(dir);
    if !dir.is_dir() {
        eprintln!("no run directory at {}", dir.display());
        return Err(2);
    }
    Ok(dir)
}

pub fn wait(run_dir: Option<String>) -> io::Result<i32> {
    let dir = match run_dir_of(run_dir, "wait") {
        Ok(dir) => dir,
        Err(code) => return Ok(code),
    };
    loop {
        for n in clean::decisions(&dir) {
            let path = clean::decision_path(&dir, n);
            if claimed(&path.with_extension("woke")) {
                println!("decision {n} {}", util::shown(&path));
                return Ok(0);
            }
        }
        if let Some(body) = next_notice(&dir) {
            println!("{}", body.get("line").and_then(Value::as_str).unwrap_or(""));
            let ended = body.get("kind").and_then(Value::as_str) == Some("ended");
            return Ok(if ended { ENDED } else { 0 });
        }
        if !is_open(&dir) {
            println!(
                "stopped: no disk-clean session is open for {}",
                util::shown(&dir)
            );
            return Ok(CLOSED);
        }
        std::thread::sleep(WAIT_EVERY);
    }
}

fn ask_to_stop(port: u16, token: &str) -> io::Result<u16> {
    let body = json!({"token": token}).to_string();
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_read_timeout(Some(STOP_WITHIN))?;
    write!(
        stream,
        "POST /stop HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )?;
    let mut answer = String::new();
    stream.read_to_string(&mut answer)?;
    Ok(answer
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0))
}

pub fn stop(run_dir: Option<String>) -> io::Result<i32> {
    let dir = match run_dir_of(run_dir, "stop") {
        Ok(dir) => dir,
        Err(code) => return Ok(code),
    };
    if !is_open(&dir) {
        println!("no disk-clean session is open for {}", util::shown(&dir));
        return Ok(CLOSED);
    }
    let info: Option<Value> = fs::read(dir.join(FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    let port = info
        .as_ref()
        .and_then(|i| i.get("port")?.as_u64())
        .and_then(|p| u16::try_from(p).ok());
    let token = info
        .as_ref()
        .and_then(|i| i.get("token")?.as_str())
        .unwrap_or("");
    let Some(port) = port.filter(|_| !token.is_empty()) else {
        eprintln!("the session is still starting; try again in a moment");
        return Ok(1);
    };
    let status = ask_to_stop(port, token)?;
    if status != 200 {
        eprintln!("the session answered {status} to stop");
        return Ok(1);
    }
    let deadline = Instant::now() + STOP_WITHIN;
    while is_open(&dir) {
        if Instant::now() >= deadline {
            eprintln!("the session accepted stop but is still running");
            return Ok(1);
        }
        std::thread::sleep(WAIT_EVERY);
    }
    println!(
        "stopped: the disk-clean session for {} is closed",
        util::shown(&dir)
    );
    Ok(0)
}

struct Tail {
    inode: Option<u128>,
    offset: u64,
    pending: Vec<u8>,
}

fn sse(name: &str, data: &str) -> String {
    format!("event: {name}\ndata: {data}\n\n")
}

pub fn complete_events(pending: &mut Vec<u8>) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    while let Some(end) = pending.iter().position(|b| *b == b'\n') {
        let line: Vec<u8> = pending.drain(..=end).collect();
        let Ok(event) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if let Some(name) = event.get("event").and_then(Value::as_str)
            && !name.is_empty()
            && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
        {
            out.push((name.to_string(), event.clone()));
        }
    }
    out
}

fn read_from(path: &Path, tail: &mut Tail) {
    let Ok(mut file) = fs::File::open(path) else {
        return;
    };
    let Ok(meta) = file.metadata() else {
        return;
    };
    let id = platform::file_id(&file);
    if tail.inode != id || meta.len() < tail.offset {
        *tail = Tail {
            inode: id,
            offset: 0,
            pending: Vec::new(),
        };
    }
    if file.seek(SeekFrom::Start(tail.offset)).is_ok()
        && let Ok(n) = file.read_to_end(&mut tail.pending)
    {
        tail.offset += n as u64;
    }
}

pub struct Follower {
    path: PathBuf,
    tail: Tail,
}

pub fn follower(dir: &Path, from_end: bool) -> Follower {
    let path = dir.join(clean::EVENTS);
    let mut tail = Tail {
        inode: None,
        offset: 0,
        pending: Vec::new(),
    };
    if from_end {
        read_from(&path, &mut tail);
        complete_events(&mut tail.pending);
    }
    Follower { path, tail }
}

pub fn next_events(follower: &mut Follower) -> Vec<(String, Value)> {
    read_from(&follower.path, &mut follower.tail);
    complete_events(&mut follower.tail.pending)
}

pub fn stream_events(out: &mut TcpStream, dir: &Path) {
    let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\nconnection: close\r\n\r\n";
    if out.write_all(head.as_bytes()).is_err() {
        return;
    }
    let mut follower = follower(dir, false);
    let mut quiet = Instant::now();
    let mut replayed = false;
    loop {
        let mut chunk: String = next_events(&mut follower)
            .iter()
            .map(|(name, event)| sse(name, &event.to_string()))
            .collect();
        if !replayed {
            chunk.push_str(&sse("replayed", "{}"));
            replayed = true;
        }
        if chunk.is_empty() && http::client_gone(out) {
            return;
        }
        if chunk.is_empty() && quiet.elapsed() >= HEARTBEAT {
            chunk = ":\n\n".to_string();
        }
        if !chunk.is_empty() {
            if out.write_all(chunk.as_bytes()).is_err() {
                return;
            }
            quiet = Instant::now();
        }
        std::thread::sleep(TAIL_EVERY);
    }
}
