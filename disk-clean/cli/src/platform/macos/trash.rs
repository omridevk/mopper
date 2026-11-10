use crate::platform::{Checked, uid};
use crate::trash::is_real_dir;
use crate::util;
use serde::Deserialize;
use std::ffi::CString;
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::process::{Command, Stdio};

const RENAME_NOFOLLOW_ANY: libc::c_uint = 0x10;

pub const RESTORE_BY_HAND: &str = "Finder's Put Back";

const OSASCRIPT_SCRIPT_LIMIT: usize = 800;
const MOVE_TO_TRASH: &str = r#"ObjC.import('Foundation')
function run() {
  const files = $.NSFileManager.defaultManager
  const input = $.NSString.alloc.initWithDataEncoding($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, 4)
  return JSON.stringify(JSON.parse(ObjC.unwrap(input)).map(({path, dev, ino}) => {
    const now = ObjC.deepUnwrap(files.attributesOfItemAtPathError(path, null)) || {}
    if (now.NSFileSystemNumber !== dev || now.NSFileSystemFileNumber !== ino) return {error: 'it changed after the check'}
    const landed = $()
    const error = $()
    const moved = files.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(path), landed, error)
    return moved ? {trashed: ObjC.unwrap(landed.path)} : {error: ObjC.unwrap(error.localizedDescription)}
  }))
}"#;
const _: () = assert!(MOVE_TO_TRASH.len() < OSASCRIPT_SCRIPT_LIMIT);

pub fn is_trash_dir(dir: &Path, home: &str) -> bool {
    let home_trash = Path::new(home).join(".Trash");
    let volume_trash = dir.file_name().and_then(|n| n.to_str()) == Some(&uid().to_string())
        && dir
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|n| n == ".Trashes");
    (dir == home_trash || volume_trash) && is_real_dir(dir)
}

#[derive(Deserialize)]
struct Landed {
    trashed: Option<String>,
    error: Option<String>,
}

pub fn call_trash(paths: &[Checked]) -> Vec<Result<String, String>> {
    let failed = |why: String| paths.iter().map(|_| Err(why.clone())).collect();
    let Ok(input) = serde_json::to_vec(paths) else {
        return failed("a path could not be encoded".to_string());
    };
    let spawned = util::spawn(
        Command::new("/usr/bin/osascript")
            .args(["-l", "JavaScript", "-e", MOVE_TO_TRASH])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    );
    let mut child = match spawned {
        Ok(child) => child,
        Err(e) => return failed(format!("could not start osascript: {e}")),
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(&input);
    }
    let out = match child.wait_with_output() {
        Ok(out) => out,
        Err(e) => return failed(format!("osascript failed: {e}")),
    };
    let landed: Vec<Landed> = match serde_json::from_slice(out.stdout.trim_ascii()) {
        Ok(landed) if out.status.success() => landed,
        _ => {
            return failed(format!(
                "the Trash call failed ({}): {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
    };
    if landed.len() != paths.len() {
        return failed("the Trash call answered for a different list".to_string());
    }
    landed
        .into_iter()
        .map(|l| match (l.trashed, l.error) {
            (Some(path), _) => Ok(path),
            (None, why) => Err(why.unwrap_or_else(|| "refused".to_string())),
        })
        .collect()
}

pub fn rename_excl(from: &Path, to: &Path) -> io::Result<()> {
    let from = CString::new(from.as_os_str().as_bytes()).map_err(io::Error::other)?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(io::Error::other)?;
    // SAFETY: renamex_np only reads the two NUL-terminated paths.
    let rc = unsafe {
        libc::renamex_np(
            from.as_ptr(),
            to.as_ptr(),
            libc::RENAME_EXCL | RENAME_NOFOLLOW_ANY,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub fn make_removable(_path: &Path) {}

pub fn drop_trash_info(_trashed: &Path) {}
