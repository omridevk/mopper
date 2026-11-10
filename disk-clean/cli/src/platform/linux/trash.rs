use crate::platform::{Checked, create_private_dir, local_time, no_follow, same_item, uid};
use crate::trash::is_real_dir;
use crate::util;
use std::ffi::{CString, OsString};
use std::fs;
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

const INFO: &str = ".trashinfo";
const NAME_TRIES: usize = 1000;

pub const RESTORE_BY_HAND: &str = "your file manager's Restore";

fn data_home(home: &str) -> PathBuf {
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| Path::new(home).join(".local/share"));
    fs::canonicalize(&data).unwrap_or(data)
}

pub(super) fn home_trash(home: &str) -> PathBuf {
    data_home(home).join("Trash")
}

fn is_sticky_dir(dir: &Path) -> bool {
    fs::symlink_metadata(dir).is_ok_and(|m| m.is_dir() && m.mode() & libc::S_ISVTX != 0)
}

pub fn is_trash_dir(dir: &Path, home: &str) -> bool {
    let Some(trash) = dir
        .parent()
        .filter(|_| dir.file_name() == Some("files".as_ref()))
    else {
        return false;
    };
    let uid = uid().to_string();
    let name = trash.file_name().and_then(|n| n.to_str());
    let admin_trash = || {
        trash
            .parent()
            .is_some_and(|t| t.file_name() == Some(".Trash".as_ref()) && is_sticky_dir(t))
    };
    let volume_trash =
        name == Some(&format!(".Trash-{uid}")) || (name == Some(&uid) && admin_trash());
    (trash == home_trash(home) || volume_trash) && is_real_dir(dir)
}

fn private_dir(dir: &Path) -> bool {
    let _ = fs::DirBuilder::new().mode(0o700).create(dir);
    fs::symlink_metadata(dir).is_ok_and(|m| m.is_dir() && m.uid() == uid())
}

fn usable(trash: PathBuf) -> Option<PathBuf> {
    (private_dir(&trash) && private_dir(&trash.join("files")) && private_dir(&trash.join("info")))
        .then_some(trash)
}

fn topdir(path: &Path, dev: u64) -> Option<&Path> {
    let mut top = path;
    while let Some(up) = top.parent() {
        if !fs::symlink_metadata(up).is_ok_and(|m| m.dev() == dev) {
            break;
        }
        top = up;
    }
    (top != path).then_some(top)
}

fn place(path: &Path, dev: u64, home: &str) -> Result<(PathBuf, Option<PathBuf>), String> {
    let home_trash = home_trash(home);
    if let Some(data) = home_trash.parent() {
        let _ = create_private_dir(data);
        if fs::symlink_metadata(data).is_ok_and(|m| m.dev() == dev) {
            return usable(home_trash)
                .map(|trash| (trash, None))
                .ok_or_else(|| "the home Trash is not a private folder of this user".to_string());
        }
    }
    let top = topdir(path, dev).ok_or("it is the top folder of its volume")?;
    let uid = uid();
    let admin = top.join(".Trash");
    is_sticky_dir(&admin)
        .then(|| usable(admin.join(uid.to_string())))
        .flatten()
        .or_else(|| usable(top.join(format!(".Trash-{uid}"))))
        .map(|trash| (trash, Some(top.to_path_buf())))
        .ok_or_else(|| {
            format!(
                "no Trash folder could be made on the volume at {}",
                top.display()
            )
        })
}

fn percent_encode(path: &[u8]) -> String {
    path.iter()
        .map(|&b| {
            if b.is_ascii_alphanumeric() || b"/-_.!~*'()".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn trash_one(item: &Checked, home: &str, date: &str) -> Result<String, String> {
    if same_item(&item.path, item.dev, item.ino, item.ino_hi) != Some(true) {
        return Err("it changed after the check".to_string());
    }
    let path = Path::new(&item.path);
    let name = path.file_name().ok_or("not a canonical path")?;
    let (trash, top) = place(path, item.dev, home)?;
    let shown = top
        .as_deref()
        .and_then(|top| path.strip_prefix(top).ok())
        .unwrap_or(path);
    let text = format!(
        "[Trash Info]\nPath={}\nDeletionDate={date}\n",
        percent_encode(shown.as_os_str().as_bytes())
    );
    for n in 1..=NAME_TRIES {
        let mut stored: OsString = name.to_os_string();
        if n > 1 {
            stored.push(format!(".{n}"));
        }
        let landed = trash.join("files").join(&stored);
        stored.push(INFO);
        let info = trash.join("info").join(&stored);
        let mut file = match no_follow().write(true).create_new(true).open(&info) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("its .trashinfo could not be written: {e}")),
        };
        match file
            .write_all(text.as_bytes())
            .and_then(|()| rename_excl(path, &landed))
        {
            Ok(()) => return Ok(landed.to_string_lossy().into_owned()),
            Err(e) => {
                let _ = fs::remove_file(&info);
                if e.kind() != io::ErrorKind::AlreadyExists {
                    return Err(e.to_string());
                }
            }
        }
    }
    Err("no free name left in the Trash".to_string())
}

pub fn call_trash(paths: &[Checked]) -> Vec<Result<String, String>> {
    let home = util::home();
    let date = local_time(c"%Y-%m-%dT%H:%M:%S");
    paths
        .iter()
        .map(|item| trash_one(item, &home, &date))
        .collect()
}

pub fn rename_excl(from: &Path, to: &Path) -> io::Result<()> {
    let from = CString::new(from.as_os_str().as_bytes()).map_err(io::Error::other)?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(io::Error::other)?;
    // SAFETY: renameat2 only reads the two NUL-terminated paths.
    let rc = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub fn make_removable(path: &Path) {
    let Ok(dir) = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(path)
    else {
        return;
    };
    if let Ok(meta) = dir.metadata()
        && meta.mode() & 0o200 == 0
    {
        let _ = dir.set_permissions(fs::Permissions::from_mode((meta.mode() & 0o7777) | 0o200));
    }
    let Ok(list) = fs::read_dir(path) else {
        return;
    };
    for entry in list.flatten() {
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            make_removable(&entry.path());
        }
    }
}

pub fn drop_trash_info(trashed: &Path) {
    let (Some(trash), Some(name)) = (trashed.parent().and_then(Path::parent), trashed.file_name())
    else {
        return;
    };
    let mut info = name.to_os_string();
    info.push(INFO);
    let _ = fs::remove_file(trash.join("info").join(info));
}
