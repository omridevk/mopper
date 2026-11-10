use crate::platform::meta_of;
use crate::walk::Meta;
use std::ffi::OsString;
use std::fs;
use std::io::ErrorKind;
use std::os::fd::AsRawFd;
use std::path::Path;

pub fn read_dir_bulk(dir: &Path) -> std::io::Result<Vec<(OsString, Option<Meta>)>> {
    Ok(fs::read_dir(dir)?
        .flatten()
        .map(|e| (e.file_name(), metadata(dir, &e).map(|m| meta_of(&m))))
        .collect())
}

fn metadata(dir: &Path, e: &fs::DirEntry) -> Option<fs::Metadata> {
    match e.metadata() {
        Err(err) if err.kind() == ErrorKind::InvalidFilename => {
            let open = fs::File::open(dir).ok()?;
            let fd = Path::new("/proc/self/fd").join(open.as_raw_fd().to_string());
            fs::symlink_metadata(fd.join(e.file_name())).ok()
        }
        m => m.ok(),
    }
}
