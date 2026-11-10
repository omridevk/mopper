mod commands;
mod disk;
mod locations;
mod net;
mod path;
mod process;
mod protected;
mod time;
mod trash;
mod walk;

pub use commands::*;
pub use disk::*;
pub use locations::*;
pub use net::*;
pub use path::*;
pub use process::*;
pub use protected::*;
pub use time::*;
pub use trash::*;
pub use walk::*;

pub const PAGE_PLATFORM: &str = "windows";
