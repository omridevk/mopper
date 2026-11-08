#![allow(dead_code)]

use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

static OPENING_INHERITABLE_FDS: Mutex<()> = Mutex::new(());

pub fn with_fd_lock<T>(open: impl FnOnce() -> T) -> T {
    let _alone = OPENING_INHERITABLE_FDS
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    open()
}

pub fn spawn(cmd: &mut Command) -> Child {
    with_fd_lock(|| cmd.spawn()).unwrap()
}

pub fn output(cmd: &mut Command) -> Output {
    spawn(
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    )
    .wait_with_output()
    .unwrap()
}

pub fn status(cmd: &mut Command) -> std::process::ExitStatus {
    spawn(cmd).wait().unwrap()
}

pub fn free_port() -> u16 {
    with_fd_lock(|| TcpListener::bind("127.0.0.1:0"))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

pub fn connect(port: u16) -> TcpStream {
    let deadline = Instant::now() + Duration::from_secs(10);
    let addr = (Ipv4Addr::LOCALHOST, port).into();
    loop {
        match with_fd_lock(|| TcpStream::connect_timeout(&addr, Duration::from_millis(50))) {
            Ok(stream) => return stream,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => panic!("nothing listened on {port}: {e}"),
        }
    }
}

#[cfg(target_os = "macos")]
struct RamDisk {
    device: String,
    mount: PathBuf,
}

#[cfg(target_os = "linux")]
struct RamDisk {
    mount: PathBuf,
}

#[cfg(windows)]
struct RamDisk {
    file: PathBuf,
    mount: PathBuf,
}

static RAM: OnceLock<RamDisk> = OnceLock::new();

#[cfg(target_os = "macos")]
extern "C" fn detach_ram_disk() {
    if let Some(disk) = RAM.get() {
        let _ = Command::new("hdiutil")
            .args(["detach", "-force", &disk.device])
            .output();
    }
}

#[cfg(target_os = "macos")]
fn attach_ram_disk() -> RamDisk {
    let attach = output(Command::new("hdiutil").args(["attach", "-nomount", "ram://2097152"]));
    assert!(attach.status.success(), "hdiutil attach failed");
    let device = String::from_utf8_lossy(&attach.stdout).trim().to_string();
    assert!(
        device.starts_with("/dev/disk"),
        "unexpected device {device:?}"
    );
    let name = format!("dc-test-{}", std::process::id());
    let erased = output(Command::new("diskutil").args(["erasevolume", "APFS", &name, &device]));
    if !erased.status.success() {
        output(Command::new("hdiutil").args(["detach", "-force", &device]));
        panic!(
            "diskutil erasevolume failed: {}",
            String::from_utf8_lossy(&erased.stderr)
        );
    }
    let mount = std::fs::canonicalize(format!("/Volumes/{name}")).unwrap();
    std::fs::write(mount.join(".metadata_never_index"), b"").unwrap();
    RamDisk { device, mount }
}

#[cfg(target_os = "linux")]
fn as_root(program: &str) -> Command {
    // SAFETY: geteuid has no preconditions and cannot fail.
    if unsafe { libc::geteuid() } == 0 {
        return Command::new(program);
    }
    let mut sudo = Command::new("sudo");
    sudo.args(["-n", program]);
    sudo
}

#[cfg(target_os = "linux")]
fn mount_tmpfs(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    let mounted = output(
        as_root("mount")
            .args(["-t", "tmpfs", "-o", "size=1g,mode=0777", "tmpfs"])
            .arg(dir),
    );
    assert!(
        mounted.status.success(),
        "mount -t tmpfs {} failed (needs root or passwordless sudo): {}",
        dir.display(),
        String::from_utf8_lossy(&mounted.stderr)
    );
}

#[cfg(target_os = "linux")]
fn unmount(dir: &Path) {
    let _ = as_root("umount").arg(dir).output();
    let _ = std::fs::remove_dir(dir);
}

#[cfg(target_os = "linux")]
extern "C" fn detach_ram_disk() {
    if let Some(disk) = RAM.get() {
        unmount(&disk.mount);
    }
}

#[cfg(target_os = "linux")]
fn attach_ram_disk() -> RamDisk {
    let dir =
        Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("dc-test-{}", std::process::id()));
    mount_tmpfs(&dir);
    RamDisk {
        mount: std::fs::canonicalize(dir).unwrap(),
    }
}

#[cfg(target_os = "linux")]
pub struct OtherVolume(pub PathBuf);

#[cfg(target_os = "linux")]
impl Drop for OtherVolume {
    fn drop(&mut self) {
        unmount(&self.0);
    }
}

#[cfg(target_os = "linux")]
pub fn other_volume(dir: &Path) -> OtherVolume {
    assert_inside_ram_disk(dir.parent().unwrap());
    mount_tmpfs(dir);
    OtherVolume(std::fs::canonicalize(dir).unwrap())
}

#[cfg(windows)]
fn diskpart(script: &str) -> Output {
    let file = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "diskpart-{}-{}.txt",
        std::process::id(),
        nanos()
    ));
    std::fs::write(&file, script).unwrap();
    let out = output(Command::new("diskpart").arg("/s").arg(&file));
    let _ = std::fs::remove_file(&file);
    out
}

#[cfg(windows)]
fn create_vhdx(name: &str, assign: &str) -> PathBuf {
    let file = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("{name}.vhdx"));
    let _ = std::fs::remove_file(&file);
    let made = diskpart(&format!(
        "create vdisk file=\"{f}\" maximum=2048 type=expandable\nselect vdisk file=\"{f}\"\nattach vdisk\nconvert gpt\ncreate partition primary\nformat fs=ntfs quick label=dc-test\n{assign}\n",
        f = file.display()
    ));
    assert!(
        made.status.success(),
        "diskpart could not create {} (needs an administrator):\n{}\n{}",
        file.display(),
        String::from_utf8_lossy(&made.stdout),
        String::from_utf8_lossy(&made.stderr)
    );
    file
}

#[cfg(windows)]
fn detach_vhdx(file: &Path) {
    let _ = diskpart(&format!(
        "select vdisk file=\"{}\"\ndetach vdisk\n",
        file.display()
    ));
    let _ = std::fs::remove_file(file);
}

#[cfg(windows)]
pub fn free_letter() -> char {
    ('G'..='Z')
        .rev()
        .find(|l| !Path::new(&format!("{l}:\\")).exists())
        .expect("no free drive letter")
}

#[cfg(windows)]
static ASSIGNING_LETTERS: Mutex<()> = Mutex::new(());

#[cfg(windows)]
fn attach_drive(name: &str) -> (PathBuf, PathBuf) {
    let assigning = ASSIGNING_LETTERS
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let letter = free_letter();
    let file = create_vhdx(name, &format!("assign letter={letter}"));
    drop(assigning);
    let short_names =
        output(Command::new("fsutil").args(["8dot3name", "set", &format!("{letter}:"), "0"]));
    assert!(
        short_names.status.success(),
        "fsutil 8dot3name set {letter}: 0 failed: {}",
        String::from_utf8_lossy(&short_names.stdout)
    );
    (file, PathBuf::from(format!("{letter}:/")))
}

#[cfg(windows)]
extern "C" fn detach_ram_disk() {
    if let Some(disk) = RAM.get() {
        detach_vhdx(&disk.file);
    }
}

#[cfg(windows)]
fn attach_ram_disk() -> RamDisk {
    let (file, mount) = attach_drive(&format!("dc-test-{}", std::process::id()));
    RamDisk { file, mount }
}

#[cfg(windows)]
static OTHER_DRIVES: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

#[cfg(windows)]
pub struct OtherVolume(pub PathBuf, PathBuf);

#[cfg(windows)]
impl Drop for OtherVolume {
    fn drop(&mut self) {
        OTHER_DRIVES
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|root| root != &self.0);
        detach_vhdx(&self.1);
    }
}

#[cfg(windows)]
pub fn other_drive() -> OtherVolume {
    let (file, root) = attach_drive(&format!("dc-other-{}-{}", std::process::id(), nanos()));
    OTHER_DRIVES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(root.clone());
    OtherVolume(root, file)
}

#[cfg(windows)]
pub fn folder_volume(dir: &Path) -> OtherVolume {
    assert_inside_ram_disk(dir.parent().unwrap());
    std::fs::create_dir_all(dir).unwrap();
    let file = create_vhdx(
        &format!("dc-folder-{}-{}", std::process::id(), nanos()),
        &format!("assign mount=\"{}\"", text(dir).replace('/', "\\")),
    );
    OtherVolume(dir.to_path_buf(), file)
}

#[cfg(unix)]
fn on_another_test_volume(_real: &Path) -> bool {
    false
}

#[cfg(windows)]
fn on_another_test_volume(real: &Path) -> bool {
    OTHER_DRIVES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .any(|root| real.starts_with(root))
}

pub fn ram_root() -> &'static Path {
    &RAM.get_or_init(|| {
        let disk = attach_ram_disk();
        // SAFETY: registers a plain extern "C" function to run at process exit.
        unsafe { libc::atexit(detach_ram_disk) };
        disk
    })
    .mount
}

#[cfg(unix)]
pub fn real_path(path: &Path) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(path)
}

#[cfg(windows)]
pub fn real_path(path: &Path) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(path).map(|real| PathBuf::from(text(&real)))
}

#[cfg(unix)]
pub fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(windows)]
pub fn text(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let plain = raw.strip_prefix("//?/").unwrap_or(&raw);
    let mut chars = plain.chars();
    match (chars.next(), chars.next()) {
        (Some(letter), Some(':')) => format!("{}{}", letter.to_ascii_uppercase(), &plain[1..]),
        _ => plain.to_string(),
    }
}

pub fn assert_inside_ram_disk(path: &Path) {
    let real = real_path(path).unwrap_or_else(|_| path.to_path_buf());
    assert!(
        real.starts_with(ram_root()) || on_another_test_volume(&real),
        "{} is outside the test RAM disk {}",
        real.display(),
        ram_root().display()
    );
}

pub fn assert_record_inside_ram_disk(home: &Path) {
    let record =
        std::fs::read_to_string(home.join(".cache/disk-clean/trashed.jsonl")).unwrap_or_default();
    for line in record.lines() {
        let entry: serde_json::Value = serde_json::from_str(line).unwrap();
        for key in ["original", "trashed"] {
            let path = entry[key].as_str().unwrap_or("");
            if !path.is_empty() {
                assert_inside_ram_disk(Path::new(path));
            }
        }
    }
}

pub fn bin(home: &Path) -> Command {
    assert_inside_ram_disk(home);
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_disk-clean"));
    cmd.env("HOME", home)
        .env("TMPDIR", home)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1");
    #[cfg(target_os = "linux")]
    cmd.env_remove("XDG_CACHE_HOME")
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("XDG_DATA_HOME");
    #[cfg(windows)]
    cmd.env("HOME", text(home))
        .env("USERPROFILE", home)
        .env("TEMP", home)
        .env("TMP", home)
        .env("LOCALAPPDATA", home.join("AppData\\Local"))
        .env("APPDATA", home.join("AppData\\Roaming"));
    cmd
}

pub struct TempDir(pub PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub struct Reaped(pub std::process::Child);

impl Drop for Reaped {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl std::ops::Deref for Reaped {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for Reaped {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

pub fn reaped(cmd: &mut Command) -> Reaped {
    Reaped(spawn(cmd))
}

fn nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}

pub fn temp_dir(tag: &str) -> TempDir {
    let dir = ram_root().join(format!("disk-clean-{tag}-{}", nanos()));
    std::fs::create_dir_all(&dir).unwrap();
    TempDir(real_path(&dir).unwrap())
}

pub fn levels_past_path_max() -> usize {
    if cfg!(target_os = "macos") { 12 } else { 36 }
}

#[cfg(unix)]
fn bash() -> Command {
    Command::new("bash")
}

#[cfg(windows)]
fn bash() -> Command {
    let program_files = std::env::var("ProgramFiles").unwrap();
    Command::new(Path::new(&program_files).join("Git\\bin\\bash.exe"))
}

pub fn sh(cwd: &Path, script: &str) {
    let status = status(
        bash()
            .arg("-ec")
            .arg(script)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1"),
    );
    assert!(status.success(), "script failed: {script}");
}

#[cfg(unix)]
pub fn sleeper() -> Command {
    let mut sleep = Command::new("sleep");
    sleep.arg("300");
    sleep
}

#[cfg(windows)]
pub fn sleeper() -> Command {
    let mut sleep = Command::new("powershell");
    sleep.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 300"]);
    sleep
}

#[cfg(unix)]
pub fn drives_arg(_home: &Path) -> String {
    "all".to_string()
}

#[cfg(windows)]
pub fn drives_arg(home: &Path) -> String {
    text(home)[..1].to_string()
}

pub fn cli(args: &[&str], home: &Path, env: &[(&str, &str)]) -> std::process::Output {
    output(bin(home).args(args).envs(env.iter().copied()))
}

pub fn wait_for(what: &str, limit: std::time::Duration, mut ready: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + limit;
    while !ready() {
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

pub fn decision_file(run: &Path) -> PathBuf {
    std::fs::create_dir_all(run.join("decisions/1")).unwrap();
    run.join("decisions/1.json")
}

pub fn events_of(run: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(run.join("clean.events"))
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[cfg(target_os = "macos")]
pub fn trash_dir(_home: &Path) -> PathBuf {
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    ram_root().join(".Trashes").join(uid.to_string())
}

#[cfg(target_os = "linux")]
pub fn trash_dir(home: &Path) -> PathBuf {
    home.join(".local/share/Trash/files")
}

#[cfg(windows)]
pub fn user_sid() -> String {
    let who = output(Command::new("whoami").args(["/user", "/fo", "csv", "/nh"]));
    let line = String::from_utf8(who.stdout).unwrap();
    line.trim()
        .rsplit(',')
        .next()
        .unwrap()
        .trim_matches('"')
        .to_string()
}

#[cfg(windows)]
pub fn recycle_bin(root: &Path) -> PathBuf {
    let bin = std::fs::read_dir(root)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .find(|name| name.eq_ignore_ascii_case("$Recycle.Bin"))
        .unwrap_or_else(|| "$Recycle.Bin".to_string());
    PathBuf::from(format!("{}{bin}/{}", text(root), user_sid()))
}

#[cfg(windows)]
pub fn trash_dir(_home: &Path) -> PathBuf {
    recycle_bin(ram_root())
}

#[cfg(windows)]
pub fn powershell(script: &str) -> String {
    let out = output(Command::new("powershell").args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
    ]));
    assert!(
        out.status.success(),
        "powershell failed: {script}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

#[cfg(windows)]
pub fn recycle_by_hand(path: &Path) {
    assert_inside_ram_disk(path);
    let method = if path.is_dir() {
        "DeleteDirectory"
    } else {
        "DeleteFile"
    };
    powershell(&format!(
        "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::{method}('{}', 'OnlyErrorDialogs', 'SendToRecycleBin')",
        path.display().to_string().replace('\'', "''")
    ));
}

#[cfg(windows)]
pub fn set_owner(path: &Path, sid: &str) {
    assert_inside_ram_disk(path);
    let native = text(path).replace('/', "\\");
    let set = output(Command::new("icacls").args([
        native.as_str(),
        "/setowner",
        &format!("*{sid}"),
        "/T",
        "/C",
        "/Q",
    ]));
    assert!(
        set.status.success(),
        "icacls /setowner {sid} on {native} failed: {}",
        String::from_utf8_lossy(&set.stdout)
    );
}

#[cfg(windows)]
pub fn junction(link: &Path, target: &Path) {
    assert_inside_ram_disk(link.parent().unwrap());
    assert_inside_ram_disk(target);
    let native = |p: &Path| text(p).replace('/', "\\");
    let made =
        output(Command::new("cmd").args(["/C", "mklink", "/J", &native(link), &native(target)]));
    assert!(
        made.status.success(),
        "mklink /J failed: {}",
        String::from_utf8_lossy(&made.stderr)
    );
}

#[cfg(windows)]
pub fn short_name(path: &Path) -> String {
    assert_inside_ram_disk(path);
    let native = text(path).replace('/', "\\");
    let short = powershell(&format!(
        "(New-Object -ComObject Scripting.FileSystemObject).GetFolder('{}').ShortPath",
        native.replace('\'', "''")
    ));
    text(Path::new(&short))
}

#[cfg(unix)]
pub fn ino(path: &Path) -> u64 {
    std::os::unix::fs::MetadataExt::ino(&std::fs::symlink_metadata(path).unwrap())
}

#[cfg(windows)]
pub fn ino(path: &Path) -> u64 {
    let native = text(path).replace('/', "\\");
    let out = output(Command::new("fsutil").args(["file", "queryFileID", &native]));
    let line = String::from_utf8(out.stdout).unwrap();
    let hex = line
        .trim()
        .rsplit("0x")
        .next()
        .unwrap_or_else(|| panic!("no file id for {native}: {line}"));
    u64::from_str_radix(&hex[hex.len().saturating_sub(16)..], 16)
        .unwrap_or_else(|e| panic!("file id {hex:?} for {native}: {e}"))
}

#[cfg(windows)]
pub const SYSTEM_FILE: &str = "C:/Windows/System32/drivers/etc/hosts";

#[cfg(target_os = "macos")]
pub fn app_caches(home: &Path) -> PathBuf {
    home.join("Library/Caches")
}

#[cfg(target_os = "linux")]
pub fn app_caches(home: &Path) -> PathBuf {
    home.join(".cache")
}

#[cfg(target_os = "macos")]
pub fn local_day(secs: u64) -> String {
    let date = output(Command::new("date").args(["-r", &secs.to_string(), "+%Y-%m-%d"]));
    String::from_utf8(date.stdout).unwrap().trim().to_string()
}

#[cfg(target_os = "linux")]
pub fn local_day(secs: u64) -> String {
    let date = output(Command::new("date").args(["-d", &format!("@{secs}"), "+%Y-%m-%d"]));
    String::from_utf8(date.stdout).unwrap().trim().to_string()
}

#[cfg(windows)]
pub fn local_day(secs: u64) -> String {
    powershell(&format!(
        "[DateTimeOffset]::FromUnixTimeSeconds({secs}).LocalDateTime.ToString('yyyy-MM-dd')"
    ))
}
