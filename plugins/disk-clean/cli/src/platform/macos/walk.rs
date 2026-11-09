use crate::walk::{Kind, Meta};
use std::ffi::{CString, OsString};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::Path;

const COMMON: u32 = libc::ATTR_CMN_RETURNED_ATTRS
    | libc::ATTR_CMN_NAME
    | libc::ATTR_CMN_DEVID
    | libc::ATTR_CMN_OBJTYPE
    | libc::ATTR_CMN_MODTIME
    | libc::ATTR_CMN_FILEID;
const DIR_ATTRS: u32 = libc::ATTR_DIR_MOUNTSTATUS | libc::ATTR_DIR_ALLOCSIZE;
const FILE_ATTRS: u32 =
    libc::ATTR_FILE_LINKCOUNT | libc::ATTR_FILE_ALLOCSIZE | libc::ATTR_FILE_DATALENGTH;
const VREG: u32 = 1;
const VDIR: u32 = 2;
const VLNK: u32 = 5;

fn take<const N: usize>(buf: &[u8], at: &mut usize) -> Option<[u8; N]> {
    let bytes = buf.get(*at..*at + N)?.try_into().ok()?;
    *at += N;
    Some(bytes)
}

fn u32_at(buf: &[u8], at: &mut usize) -> Option<u32> {
    take(buf, at).map(u32::from_ne_bytes)
}

fn u64_at(buf: &[u8], at: &mut usize) -> Option<u64> {
    take(buf, at).map(u64::from_ne_bytes)
}

fn blocks_of(alloc: u64) -> u64 {
    alloc.div_ceil(512)
}

fn parse_entry(rec: &[u8]) -> Option<(OsString, Option<Meta>)> {
    let mut at = 4;
    let common = u32_at(rec, &mut at)?;
    let [_, dirattr, fileattr, _] = [(); 4].map(|_| u32_at(rec, &mut at).unwrap_or(0));
    let has = |bit: u32| common & bit == bit;
    if !has(libc::ATTR_CMN_NAME) {
        return None;
    }
    let name_at = at;
    let offset = i32::from_ne_bytes(take(rec, &mut at)?);
    let len = u32_at(rec, &mut at)? as usize;
    let start = name_at.checked_add_signed(offset as isize)?;
    let name = rec.get(start..start + len.saturating_sub(1))?;
    let name = OsString::from_vec(name.to_vec());
    let wanted = libc::ATTR_CMN_DEVID
        | libc::ATTR_CMN_OBJTYPE
        | libc::ATTR_CMN_MODTIME
        | libc::ATTR_CMN_FILEID;
    if !has(wanted) {
        return Some((name, None));
    }
    let dev = i32::from_ne_bytes(take(rec, &mut at)?) as u64;
    let objtype = u32_at(rec, &mut at)?;
    let mtime = i64::from_ne_bytes(take(rec, &mut at)?);
    at += 8;
    let ino = u64_at(rec, &mut at)?;
    let mut meta = Meta {
        dev,
        ino,
        mtime,
        kind: match objtype {
            VREG => Kind::File,
            VDIR => Kind::Dir,
            VLNK => Kind::Symlink,
            _ => Kind::Other,
        },
        ..Meta::default()
    };
    if meta.kind == Kind::Dir {
        if dirattr & DIR_ATTRS != DIR_ATTRS {
            return Some((name, None));
        }
        let mount = u32_at(rec, &mut at)?;
        if mount & libc::DIR_MNTSTATUS_MNTPOINT != 0 {
            return Some((name, None));
        }
        meta.blocks = blocks_of(u64_at(rec, &mut at)?);
    } else {
        if fileattr & FILE_ATTRS != FILE_ATTRS {
            return Some((name, None));
        }
        meta.nlink = u64::from(u32_at(rec, &mut at)?);
        meta.blocks = blocks_of(u64_at(rec, &mut at)?);
        meta.size = u64_at(rec, &mut at)?;
    }
    Some((name, Some(meta)))
}

pub fn read_dir_bulk(dir: &Path) -> std::io::Result<Vec<(OsString, Option<Meta>)>> {
    let mut out = Vec::new();
    let Ok(c) = CString::new(dir.as_os_str().as_bytes()) else {
        return Ok(out);
    };
    let fd = loop {
        // SAFETY: open has no memory preconditions beyond a valid C string.
        let fd = unsafe {
            libc::open(
                c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd >= 0 {
            break fd;
        }
        let e = std::io::Error::last_os_error();
        if e.kind() != std::io::ErrorKind::Interrupted {
            return Err(e);
        }
    };
    let mut list = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: COMMON,
        volattr: 0,
        dirattr: DIR_ATTRS,
        fileattr: FILE_ATTRS,
        forkattr: 0,
    };
    let mut buf = vec![0u8; 128 * 1024];
    loop {
        // SAFETY: getattrlistbulk writes at most buf.len() bytes into buf.
        let n = unsafe {
            libc::getattrlistbulk(
                fd,
                (&mut list as *mut libc::attrlist).cast(),
                buf.as_mut_ptr().cast(),
                buf.len(),
                0,
            )
        };
        if n < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        if n <= 0 {
            break;
        }
        let mut at = 0usize;
        for _ in 0..n {
            let mut cursor = at;
            let Some(len) = u32_at(&buf, &mut cursor).map(|l| l as usize) else {
                break;
            };
            if len == 0 || at + len > buf.len() {
                break;
            }
            out.extend(parse_entry(&buf[at..at + len]));
            at += len;
        }
    }
    // SAFETY: fd was opened above and is closed once.
    unsafe { libc::close(fd) };
    Ok(out)
}
