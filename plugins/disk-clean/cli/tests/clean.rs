mod common;

use common::text;
use disk_clean::clean::is_allowed;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
const HOME: &str = "/Users/someone";
#[cfg(target_os = "macos")]
const BASE: &str = "/private/var/folders/ab/xyz";

#[cfg(target_os = "macos")]
#[test]
fn is_allowed_table() {
    let allowed = [
        "/private/tmp/x",
        "/private/tmp/some/deep/dir",
        "/private/var/folders/ab/xyz/T/cache",
        "/private/var/folders/ab/xyz/C/com.app",
        "/private/var/folders/ab/xyz/X/App.code_sign_clone",
        "/Users/someone/Library/Caches/thing",
        "/Users/someone/Library/Logs/x.log",
        "/Users/someone/.npm/_cacache",
        "/Users/someone/code/app/node_modules",
        "/Users/someone/.Trash/old",
        "/Users/someone/Downloads/big.iso",
        "/Users/someone/Documentsx",
        "/Users/someone/Library/Mailbox",
    ];
    let blocked = [
        "/private/tmp/",
        "/private/tmp",
        "/private/tmp/../etc",
        "/Users/someone/code/../Documents",
        "/private/var/folders/ab/xyz/T/",
        "/private/var/folders/ab/xyz/other/x",
        "/private/var/folders/zz/other/T/x",
        "/Users/someone",
        "/Users/someone/",
        "/",
        "/System/Library",
        "/Library/Caches",
        "/Applications/App.app",
        "/usr/local/lib",
        "/bin/ls",
        "/sbin/mount",
        "/etc/hosts",
        "/var/log",
        "/private/etc",
        "/opt/homebrew",
        "/Users",
        "/Users/other/thing",
        "relative/path",
        "/Volumes/External/x",
        "/Users/someone/Documents",
        "/Users/someone/Documents/a",
        "/Users/someone/Desktop",
        "/Users/someone/Desktop/a",
        "/Users/someone/Pictures/a",
        "/Users/someone/Movies",
        "/Users/someone/Music/a",
        "/Users/someone/.ssh",
        "/Users/someone/.ssh/id_rsa",
        "/Users/someone/.gnupg/x",
        "/Users/someone/.aws/credentials",
        "/Users/someone/.kube/config",
        "/Users/someone/.claude",
        "/Users/someone/.claude/projects",
        "/Users/someone/Library",
        "/Users/someone/Library/Keychains",
        "/Users/someone/Library/Keychains/login.keychain-db",
        "/Users/someone/Library/Group Containers/x/Keychains",
        "/Users/someone/Library/Mail",
        "/Users/someone/Library/Mail/V10",
        "/Users/someone/Library/Messages",
        "/Users/someone/Library/Messages/chat.db",
        "/private/tmp//x",
        "/private/tmp/./x",
        "/private/tmp/x/",
        "/Users/someone//Documents",
        "/Users/someone/./Documents",
        "/Users/someone/Library/./Keychains",
        "/Users/someone/Library/Caches/x/",
        "/Users/someone/documents",
        "/Users/someone/DESKTOP/a",
        "/Users/someone/.SSH/id_rsa",
        "/Users/someone/library/keychains",
        "/Users/someone/LIBRARY",
    ];
    for p in allowed {
        assert!(is_allowed(p, HOME, Some(BASE)), "should allow {p}");
    }
    for p in blocked {
        assert!(!is_allowed(p, HOME, Some(BASE)), "should block {p}");
    }
    assert!(!is_allowed(
        "/private/var/folders/ab/xyz/T/cache",
        HOME,
        None
    ));
    assert!(is_allowed("/private/tmp/x", HOME, None));
    assert!(is_allowed("/private/tmp/ok..name", HOME, None));
}

#[cfg(target_os = "macos")]
#[test]
fn a_home_inside_the_temp_folder_keeps_its_protection() {
    let home = format!("{BASE}/T/sandbox/home");
    for p in [
        home.clone(),
        format!("{BASE}/T/sandbox"),
        format!("{home}/Documents"),
        format!("{home}/.ssh/id_rsa"),
        format!("{home}/Library"),
        format!("{home}/Library/Keychains/login.keychain-db"),
    ] {
        assert!(!is_allowed(&p, &home, Some(BASE)), "should block {p}");
    }
    assert!(is_allowed(
        &format!("{home}/Library/Caches/x"),
        &home,
        Some(BASE)
    ));
    for bad_home in ["", "/", "relative", "/Users/someone/"] {
        assert!(
            !is_allowed("/private/tmp/x", bad_home, Some(BASE)),
            "home {bad_home:?} must allow nothing"
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn is_allowed_table_on_linux() {
    let home = "/home/someone";
    let allowed = [
        "/tmp/x",
        "/tmp/some/deep/dir",
        "/tmp/ok..name",
        "/var/tmp/x",
        "/home/someone/.cache/thing",
        "/home/someone/.cache/pip",
        "/home/someone/.npm/_cacache",
        "/home/someone/code/app/node_modules",
        "/home/someone/.local/share/Trash/files/old",
        "/home/someone/Downloads/big.iso",
        "/home/someone/Documentsx",
        "/home/someone/.config/ghx",
    ];
    let blocked = [
        "/tmp/",
        "/tmp",
        "/var/tmp",
        "/tmp/../etc",
        "/tmp//x",
        "/tmp/./x",
        "/tmp/x/",
        "/home/someone/code/../Documents",
        "/home/someone",
        "/home/someone/",
        "/home",
        "/home/other/thing",
        "/",
        "relative/path",
        "/usr/local/lib",
        "/bin/ls",
        "/sbin/mount",
        "/lib/x",
        "/lib64/x",
        "/etc/hosts",
        "/var/log",
        "/var/cache/apt",
        "/opt/x",
        "/boot/x",
        "/root/x",
        "/srv/x",
        "/snap/x",
        "/proc/1",
        "/sys/x",
        "/dev/null",
        "/run/user/1000",
        "/nix/store/x",
        "/media/someone/usb/x",
        "/mnt/x",
        "/private/tmp/x",
        "/home/someone/Desktop",
        "/home/someone/Desktop/a",
        "/home/someone/Documents",
        "/home/someone/Documents/a",
        "/home/someone/Pictures/a",
        "/home/someone/Music/a",
        "/home/someone/Videos",
        "/home/someone/Templates/a",
        "/home/someone/Public",
        "/home/someone/.ssh",
        "/home/someone/.ssh/id_rsa",
        "/home/someone/.gnupg/x",
        "/home/someone/.aws/credentials",
        "/home/someone/.kube/config",
        "/home/someone/.claude",
        "/home/someone/.claude/projects",
        "/home/someone/.config/gh",
        "/home/someone/.config/gh/hosts.yml",
        "/home/someone/.config/gcloud",
        "/home/someone/.local/share/keyrings",
        "/home/someone/.local/share/keyrings/login.keyring",
        "/home/someone/.gnome2/keyrings",
        "/home/someone/.local/share/kwalletd",
        "/home/someone/.local/share/evolution/mail",
        "/home/someone/Maildir/cur",
        "/home/someone/mail",
        "/home/someone/.password-store",
        "/home/someone/.pki/nssdb",
        "/home/someone/.config/google-chrome",
        "/home/someone/.config/chromium/Default",
        "/home/someone/.mozilla/firefox",
        "/home/someone/.thunderbird",
        "/home/someone/.docker",
        "/home/someone/.cache/disk-clean",
        "/home/someone/.cache/disk-clean/trashed.jsonl",
        "/home/someone/.cache/huggingface/token",
        "/home/someone/.android",
        "/home/someone//Documents",
        "/home/someone/./Documents",
        "/home/someone/documents",
        "/home/someone/DESKTOP/a",
        "/home/someone/.SSH/id_rsa",
        "/home/someone/.Config/GH",
    ];
    for p in allowed {
        assert!(is_allowed(p, home, None), "should allow {p}");
    }
    for p in blocked {
        assert!(!is_allowed(p, home, None), "should block {p}");
    }
}

#[cfg(target_os = "linux")]
#[test]
fn is_allowed_table_for_a_home_under_var_on_linux() {
    let home = "/var/home/someone";
    let allowed = [
        "/var/home/someone/.cache/thing",
        "/var/home/someone/code/app/node_modules",
        "/var/home/someone/.local/share/Trash/files/old",
        "/var/tmp/x",
        "/tmp/x",
    ];
    let blocked = [
        "/var/home/someone",
        "/var/home",
        "/var",
        "/var/home/other/thing",
        "/var/log",
        "/var/lib/flatpak/x",
        "/var/home/someone/Documents/a",
        "/var/home/someone/.ssh/id_rsa",
        "/home/someone/.cache/thing",
        "/etc/hosts",
        "/usr/lib/x",
    ];
    for p in allowed {
        assert!(is_allowed(p, home, None), "should allow {p}");
    }
    for p in blocked {
        assert!(!is_allowed(p, home, None), "should block {p}");
    }
}

#[cfg(target_os = "linux")]
#[test]
fn a_home_inside_the_temp_folder_keeps_its_protection_on_linux() {
    let home = "/tmp/sandbox/home".to_string();
    for p in [
        home.clone(),
        "/tmp/sandbox".to_string(),
        format!("{home}/Documents"),
        format!("{home}/.ssh/id_rsa"),
        format!("{home}/.config/gh"),
    ] {
        assert!(!is_allowed(&p, &home, None), "should block {p}");
    }
    assert!(is_allowed(&format!("{home}/.cache/x"), &home, None));
    for bad_home in ["", "/", "relative", "/home/someone/"] {
        assert!(
            !is_allowed("/tmp/x", bad_home, None),
            "home {bad_home:?} must allow nothing"
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn a_localized_user_dir_from_user_dirs_dirs_is_protected() {
    let t = common::temp_dir("clean-user-dirs");
    let home = &t.0;
    fs::create_dir_all(home.join(".config")).unwrap();
    fs::write(
        home.join(".config/user-dirs.dirs"),
        "# written by xdg-user-dirs-update\nXDG_PICTURES_DIR=\"$HOME/Bilder\"\n",
    )
    .unwrap();
    let (bilder, inside, pictures, beside) = (
        home.join("Bilder"),
        home.join("Bilder/Urlaub"),
        home.join("Pictures/a"),
        home.join("Bildschirm"),
    );
    for dir in [&inside, &pictures, &beside] {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("f"), b"x").unwrap();
    }
    let run = home.join("run");
    let paths = [&bilder, &inside, &pictures, &beside];
    let scan: String = paths
        .iter()
        .map(|p| scan_row("caches", "rm", &text(p)))
        .collect();
    let items: Vec<String> = paths
        .iter()
        .map(|p| selection_item("rm", &text(p)))
        .collect();
    write_run(&run, &scan, &items, None);
    let out = common::cli(
        &["clean", "--dry-run", &text(&run), "--decision", "1"],
        home,
        &[],
    );
    let plan = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{plan}");
    for p in [&bilder, &inside, &pictures] {
        assert!(
            plan.contains(&format!("# rejected (protected path): {}\n", text(p))),
            "{plan}"
        );
    }
    assert!(
        plan.contains(&format!("\ntrash -- {}\n", text(&beside))),
        "{plan}"
    );
    assert!(bilder.join("Urlaub/f").exists() && beside.join("f").exists());
}

#[cfg(windows)]
#[test]
fn is_allowed_table_on_windows() {
    let home = "C:/Users/someone";
    let temp = "C:/Users/someone/AppData/Local/Temp";
    let sid = common::user_sid();
    let own_bin = format!("C:/$Recycle.Bin/{sid}/$RABC123.txt");
    let allowed = [
        "C:/Users/someone/AppData/Local/Temp/x",
        "C:/Users/someone/AppData/Local/Temp/ok..name",
        "C:/Users/someone/AppData/Local/npm-cache/_cacache",
        "C:/Users/someone/AppData/Local/Microsoft/Windows/INetCache/IE",
        "C:/Users/someone/AppData/Local/Packages/App_8wekyb3d8bbwe/TempState/x",
        "C:/Users/someone/code/app/node_modules",
        "C:/Users/someone/Downloads/big.iso",
        "C:/Users/someone/Documentsx",
        own_bin.as_str(),
    ];
    let blocked = [
        "C:/Users/someone",
        "C:/Users/someone/",
        "C:/Users",
        "C:/",
        "C:",
        "/",
        "relative/path",
        "/etc/hosts",
        "C:/Users/someone/AppData/Local/Temp",
        "C:/Users/someone/AppData/Local/Temp/",
        "C:/Users/someone/AppData/Local/Temp//x",
        "C:/Users/someone/AppData/Local/Temp/./x",
        "C:/Users/someone/AppData/Local/Temp/x/",
        "C:/Users/someone/code/../Documents",
        "C:/Windows",
        "C:/Windows/System32/drivers/etc/hosts",
        "C:/Windows/Temp/x",
        "C:/Program Files/App",
        "C:/Program Files (x86)/App",
        "C:/ProgramData/x",
        "C:/System Volume Information/x",
        "C:/$WinREAgent/x",
        "C:/Recovery/x",
        "C:/PerfLogs/x",
        "C:/pagefile.sys",
        "C:/hiberfil.sys",
        "C:/swapfile.sys",
        "C:/$Recycle.Bin/S-1-5-21-1-2-3-1001/$RABC123.txt",
        "C:/$Recycle.Bin/$RABC123.txt",
        "C:/Users/other/thing",
        "D:/x",
        "C:/Users/someone/Documents",
        "C:/Users/someone/Documents/a",
        "C:/Users/someone/Desktop",
        "C:/Users/someone/Desktop/a",
        "C:/Users/someone/Pictures/a",
        "C:/Users/someone/Music/a",
        "C:/Users/someone/Videos",
        "C:/Users/someone/OneDrive/a",
        "C:/Users/someone/.ssh",
        "C:/Users/someone/.ssh/id_rsa",
        "C:/Users/someone/.gnupg/x",
        "C:/Users/someone/.aws/credentials",
        "C:/Users/someone/.kube/config",
        "C:/Users/someone/.azure/x",
        "C:/Users/someone/.claude/projects",
        "C:/Users/someone/.docker/config.json",
        "C:/Users/someone/.cache/disk-clean",
        "C:/Users/someone/.cache/disk-clean/trashed.jsonl",
        "C:/Users/someone/AppData/Roaming/gnupg/x",
        "C:/Users/someone/AppData/Roaming/Microsoft/Protect/x",
        "C:/Users/someone/AppData/Roaming/Microsoft/Credentials/x",
        "C:/Users/someone/AppData/Local/Microsoft/Credentials/x",
        "C:/Users/someone/AppData/Local/Microsoft/Vault/x",
        "C:/Users/someone/AppData/Roaming/Microsoft/Crypto/x",
        "C:/Users/someone/AppData/Roaming/Microsoft/SystemCertificates/x",
        "C:/Users/someone/AppData/Local/Microsoft/Outlook/x.ost",
        "C:/Users/someone/AppData/Roaming/Thunderbird/Profiles/x",
        "C:/Users/someone/AppData/Local/Packages/App_8wekyb3d8bbwe/LocalState/x",
        "C:/Users/someone/code/vault.kdbx",
        "C:/Users/someone/code/mail.pst",
        "C:/Users/someone//Documents",
        "C:/Users/someone/./Documents",
        "C:/Users/someone/documents",
        "c:/users/someone/documents/a",
        "C:/USERS/SOMEONE/DESKTOP/a",
        "C:/Users/someone/.SSH/id_rsa",
        "C:/Users/someone/APPDATA/ROAMING/MICROSOFT/PROTECT/x",
        "C:\\Users\\someone\\Documents\\a",
        "C:/Users/SOMEON~1/Documents/a",
    ];
    for p in allowed {
        assert!(is_allowed(p, home, Some(temp)), "should allow {p}");
    }
    for p in blocked {
        assert!(!is_allowed(p, home, Some(temp)), "should block {p}");
    }
    assert!(!is_allowed(
        "C:/Users/someone/AppData/Local/Temp/x",
        home,
        None
    ));
}

#[cfg(windows)]
#[test]
fn the_system_folders_of_this_pc_are_never_walked() {
    let home = "C:/Users/someone";
    let (drives, never) = disk_clean::platform::drives_to_walk(home);
    assert!(drives.iter().any(|d| d == Path::new("C:/")), "{drives:?}");
    let windows = text(Path::new(&std::env::var("SystemRoot").unwrap()));
    for folder in [windows.as_str(), "C:/Program Files", "C:/ProgramData"] {
        assert!(never.contains(Path::new(folder)), "{folder} {never:?}");
    }
    assert!(
        !never.iter().any(|n| Path::new(home).starts_with(n)),
        "{never:?}"
    );
}

#[cfg(windows)]
#[test]
fn a_home_inside_the_temp_folder_keeps_its_protection_on_windows() {
    let temp = "C:/Users/someone/AppData/Local/Temp";
    let home = format!("{temp}/sandbox/home");
    for p in [
        home.clone(),
        format!("{temp}/sandbox"),
        format!("{home}/Documents"),
        format!("{home}/.ssh/id_rsa"),
        format!("{home}/AppData/Roaming/Microsoft/Protect"),
    ] {
        assert!(!is_allowed(&p, &home, Some(temp)), "should block {p}");
    }
    assert!(is_allowed(
        &format!("{home}/AppData/Local/x"),
        &home,
        Some(temp)
    ));
    for bad_home in ["", "C:/", "C:", "relative", "C:/Users/someone/"] {
        assert!(
            !is_allowed(&format!("{temp}/x"), bad_home, Some(temp)),
            "home {bad_home:?} must allow nothing"
        );
    }
}

#[cfg(windows)]
#[test]
fn protected_folders_spelled_by_case_or_short_name_are_rejected() {
    let t = common::temp_dir("clean-spellings");
    let home = &t.0;
    for dir in ["Documents/a", "Desktop/b", "AppData/Local/x"] {
        fs::create_dir_all(home.join(dir)).unwrap();
        fs::write(home.join(dir).join("f"), b"x").unwrap();
    }
    let short = common::short_name(&home.join("Documents"));
    let short_leaf = short.rsplit('/').next().unwrap().to_string();
    assert!(short_leaf.contains('~'), "no short name: {short}");
    let h = text(home);
    let spellings = [
        format!("{h}/documents/a"),
        format!("{h}/DESKTOP/b"),
        format!("{}/Documents/a", h.to_uppercase()),
        format!("{h}/{short_leaf}/a"),
        format!("{h}/{short_leaf}"),
    ];
    let control = text(&home.join("AppData/Local/x"));
    let scan: String = spellings
        .iter()
        .chain([&control])
        .map(|p| scan_row("caches", "rm", p))
        .collect();
    let items: Vec<String> = spellings
        .iter()
        .chain([&control])
        .map(|p| selection_item("rm", p))
        .collect();
    let run = home.join("run");
    write_run(&run, &scan, &items, None);
    let out = common::cli(
        &["clean", "--dry-run", &text(&run), "--decision", "1"],
        home,
        &[],
    );
    let plan = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{plan}");
    for p in &spellings {
        let shown = if p.contains('~') {
            format!("'{p}'")
        } else {
            p.clone()
        };
        assert!(
            plan.contains(&format!("# rejected (protected path): {shown}\n")),
            "{plan}"
        );
    }
    assert!(plan.contains(&format!("\ntrash -- {control}\n")), "{plan}");
    assert!(home.join("Documents/a/f").exists() && home.join("Desktop/b/f").exists());
}

fn scan_row(cat: &str, action: &str, path: &str) -> String {
    format!("{cat}\tTitle\tDesc\tsafe\t1\t{action}\t-\t{path}\t{path}\t4096\tnote\t1\texact\n")
}

fn selection_item(action: &str, path: &str) -> String {
    format!(
        r#"{{"path": "{path}", "label": "{path}", "bytes": 4096, "action": "{action}", "cmd_id": "-", "category": "x"}}"#
    )
}

#[cfg(unix)]
#[test]
fn clean_end_to_end_on_fixture() {
    let t = common::temp_dir("clean");
    let root = &t.0;
    let run = root.join("run");
    fs::create_dir_all(&run).unwrap();
    let doomed = root.join("doomed");
    fs::create_dir_all(doomed.join("nested/deeper")).unwrap();
    fs::write(doomed.join("nested/deeper/file"), vec![1u8; 10_000]).unwrap();
    let doomed_file = root.join("doomed-file.bin");
    fs::write(&doomed_file, b"bytes").unwrap();
    let not_in_scan = root.join("not-in-scan");
    fs::create_dir_all(&not_in_scan).unwrap();
    let protected = root.join(".ssh/id_rsa");
    fs::create_dir_all(root.join(".ssh")).unwrap();
    fs::write(&protected, b"key").unwrap();
    common::sh(
        root,
        "git init -q -b main repo && cd repo && echo a >a && git add a && git commit -qm init",
    );
    let repo = root.join("repo");

    let p = |x: &Path| x.to_string_lossy().into_owned();
    let scan = [
        scan_row("caches", "rm", &p(&doomed)),
        scan_row("caches", "rm", &p(&doomed_file)),
        scan_row("caches", "rm", &p(&protected)),
        scan_row("worktrees", "worktree", &p(&repo)),
    ]
    .concat();
    fs::write(run.join("scan.tsv"), scan).unwrap();
    fs::write(run.join("free-before"), "987654321987\n").unwrap();
    let items = [
        selection_item("rm", &p(&doomed)),
        selection_item("rm", &p(&doomed_file)),
        selection_item("rm", &p(&not_in_scan)),
        selection_item("rm", &p(&protected)),
        selection_item("worktree", &p(&repo)),
        selection_item("rm", &p(&repo)),
        r#"{"action": "cmd", "cmd_id": "rm-rf-everything", "bytes": 1}"#.to_string(),
    ]
    .join(",");
    fs::write(
        common::decision_file(&run),
        format!(r#"{{"items": [{items}], "total_bytes": 0}}"#),
    )
    .unwrap();

    let dry = common::cli(
        &["clean", "--dry-run", &p(&run), "--decision", "1"],
        root,
        &[],
    );
    let plan = String::from_utf8_lossy(&dry.stdout);
    assert!(dry.status.success(), "{plan}");
    let (hold_at, cant_undo) = (
        plan.find("# moved to the Trash (undo in the page").unwrap(),
        plan.find("# can't be undone:\n").unwrap(),
    );
    let first = plan.find(&format!("\ntrash -- {}\n", p(&doomed))).unwrap();
    let second = plan
        .find(&format!("\ntrash -- {}\n", p(&doomed_file)))
        .unwrap();
    assert!(hold_at < first && hold_at < second, "{plan}");
    assert!(first < cant_undo && second < cant_undo, "{plan}");
    assert!(
        !plan.contains("rm -rf") && !plan.contains("\ndelete "),
        "{plan}"
    );
    assert!(
        plan.contains(&format!("# kept, not a registered worktree: {}", p(&repo))),
        "{plan}"
    );
    assert!(
        plan.contains(&format!("# rejected (protected path): {}", p(&protected))),
        "{plan}"
    );
    assert!(
        plan.contains("# rejected (unknown command id): rm-rf-everything"),
        "{plan}"
    );
    assert!(plan.contains("# 3 items, 12288 bytes"), "{plan}");
    assert!(doomed.exists() && doomed_file.exists());
    assert!(!run.join("decisions/1/rm-list").exists() && !run.join("decisions/1/status").exists());

    let out = common::cli(&["clean", &p(&run), "--decision", "1"], root, &[]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "clean failed: {stdout} {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        stdout.contains("queued  : 3 items (12288 bytes)"),
        "{stdout}"
    );
    assert!(stdout.contains("rejected: 4"), "{stdout}");
    assert!(stdout.contains("pid     : "), "{stdout}");
    assert!(
        stdout.contains(&format!("log     : {}", p(&run.join("clean.log")))),
        "{stdout}"
    );

    let rejected = fs::read_to_string(run.join("decisions/1/rejected")).unwrap();
    assert!(
        rejected.contains(&format!("not in scan\t{}\n", p(&not_in_scan))),
        "{rejected}"
    );
    assert!(
        rejected.contains(&format!("protected path\t{}\n", p(&protected))),
        "{rejected}"
    );
    assert!(
        rejected.contains(&format!("action does not match scan\t{}\n", p(&repo))),
        "{rejected}"
    );
    assert!(
        rejected.contains("unknown command id\trm-rf-everything\n"),
        "{rejected}"
    );
    assert_eq!(
        fs::read_to_string(run.join("decisions/1/cmd-list")).unwrap(),
        ""
    );
    assert_eq!(
        fs::read_to_string(run.join("decisions/1/wt-list")).unwrap(),
        format!("{}\n", p(&repo))
    );

    let deadline = Instant::now() + Duration::from_secs(30);
    while fs::read_to_string(run.join("decisions/1/status")).unwrap_or_default() != "done\n" {
        assert!(Instant::now() < deadline, "worker never finished");
        std::thread::sleep(Duration::from_millis(100));
    }
    let log = fs::read_to_string(run.join("clean.log")).unwrap();
    let bin = p(&common::trash_dir(root));
    assert!(
        log.contains(&format!("trashed {} -> {bin}/doomed\n", p(&doomed))),
        "{log}"
    );
    assert!(
        log.contains(&format!(
            "trashed {} -> {bin}/doomed-file.bin\n",
            p(&doomed_file)
        )),
        "{log}"
    );
    assert!(
        log.contains(&format!("KEPT    {} (not a registered worktree)", p(&repo))),
        "{log}"
    );
    assert!(log.contains("removed: 0 items, 0 bytes"), "{log}");
    assert!(
        log.contains("trashed: 2 items, 8192 bytes, in the Trash until it is emptied"),
        "{log}"
    );
    assert!(log.contains("free space changed by "), "{log}");
    assert!(
        !log.contains("987654321987"),
        "the scan-time free-before is never used: {log}"
    );
    assert!(!doomed.exists() && !doomed_file.exists());
    common::assert_record_inside_ram_disk(root);
    let record = disk_clean::trash::read(&p(root));
    assert_eq!(record.len(), 2);
    for entry in &record {
        assert!(Path::new(&entry.trashed).exists(), "{entry:?}");
        assert_eq!((entry.bytes, entry.state.as_str()), (4096, "trashed"));
        assert_eq!(entry.run, disk_clean::trash::round_run(&run, 1));
        assert!(entry.at > 0);
    }
    assert!(
        Path::new(&record[0].trashed)
            .join("nested/deeper/file")
            .exists()
    );
    assert!(not_in_scan.exists() && repo.join("a").exists() && protected.exists());
}

#[test]
fn clean_rejects_everything() {
    let t = common::temp_dir("clean-none");
    let run = t.0.join("run");
    fs::create_dir_all(&run).unwrap();
    let protected = t.0.join(".ssh/id_rsa");
    fs::create_dir_all(t.0.join(".ssh")).unwrap();
    fs::write(&protected, b"key").unwrap();
    fs::write(run.join("scan.tsv"), "").unwrap();
    fs::write(
        common::decision_file(&run),
        format!(r#"{{"items": [{{"path": "{}"}}]}}"#, text(&protected)),
    )
    .unwrap();
    let out = common::cli(&["clean", &text(&run), "--decision", "1"], &t.0, &[]);
    assert_eq!(out.status.code(), Some(3));
    assert!(String::from_utf8_lossy(&out.stderr).contains("nothing passed validation"));
    let log = fs::read_to_string(run.join("clean.log")).unwrap();
    assert!(
        log.contains("decision 1 abandoned: nothing passed"),
        "{log}"
    );
    assert_eq!(
        fs::read_to_string(run.join("decisions/1/status")).unwrap(),
        "abandoned\n"
    );
    let events = common::events_of(&run);
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0]["event"], "abandoned");
    assert!(
        events[0]["reason"]
            .as_str()
            .unwrap()
            .contains("nothing passed the safety checks"),
        "{events:?}"
    );
}

#[test]
fn dry_run_quotes_paths_and_lists_fixed_commands() {
    let t = common::temp_dir("clean-dry");
    let run = t.0.join("run");
    fs::create_dir_all(&run).unwrap();
    let odd = t.0.join("it's a dir");
    fs::create_dir_all(&odd).unwrap();
    let odd_s = text(&odd);
    fs::write(run.join("scan.tsv"), scan_row("caches", "rm", &odd_s)).unwrap();
    let items = [
        selection_item("rm", &odd_s).replace('\'', "\\u0027"),
        r#"{"action": "cmd", "cmd_id": "docker-prune", "bytes": 7}"#.to_string(),
    ]
    .join(",");
    fs::write(
        common::decision_file(&run),
        format!(r#"{{"items": [{items}]}}"#),
    )
    .unwrap();
    let out = common::cli(
        &["clean", "--dry-run", &text(&run), "--decision", "1"],
        &t.0,
        &[],
    );
    let plan = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{plan}");
    let quoted = format!("'{}'", odd_s.replace('\'', r"'\''"));
    assert!(plan.contains(&format!("\ntrash -- {quoted}\n")), "{plan}");
    assert!(plan.contains("\ndocker system prune -f\n"), "{plan}");
    assert!(odd.exists());
}

#[test]
fn dry_run_names_the_owning_repo_of_a_linked_worktree() {
    let t = common::temp_dir("clean-dry-wt");
    let root = &t.0;
    let run = root.join("run");
    fs::create_dir_all(&run).unwrap();
    common::sh(
        root,
        "git init -q -b main repo && cd repo && echo a >a && git add a && git commit -qm init && git worktree add -q ../wt",
    );
    let repo = common::real_path(&root.join("repo")).unwrap();
    let wt = root.join("wt");
    let wt_s = text(&wt);
    fs::write(
        run.join("scan.tsv"),
        scan_row("worktrees", "worktree", &wt_s),
    )
    .unwrap();
    fs::write(
        common::decision_file(&run),
        format!(r#"{{"items": [{}]}}"#, selection_item("worktree", &wt_s)),
    )
    .unwrap();
    let out = common::cli(
        &["clean", "--dry-run", &text(&run), "--decision", "1"],
        root,
        &[],
    );
    let plan = String::from_utf8_lossy(&out.stdout);
    let repo_s = text(&repo);
    assert!(
        plan.contains(&format!(
            "\n# can't be undone:\ngit -C {repo_s} worktree remove {wt_s}\n"
        )),
        "{plan}"
    );
    assert!(
        plan.contains(&format!("\ngit -C {repo_s} worktree prune\n")),
        "{plan}"
    );
    assert!(wt.exists());
}

fn wait_done(run: &Path) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while fs::read_to_string(run.join("decisions/1/status")).unwrap_or_default() != "done\n" {
        assert!(Instant::now() < deadline, "worker never finished");
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(unix)]
#[test]
fn worker_writes_one_event_per_outcome() {
    let t = common::temp_dir("clean-events");
    let root = &t.0;
    let run = root.join("run");
    fs::create_dir_all(&run).unwrap();
    let doomed = root.join("doomed");
    fs::create_dir_all(doomed.join("a")).unwrap();
    fs::write(doomed.join("a/file"), vec![1u8; 10_000]).unwrap();
    let stuck = root.join("pinned/stuck");
    fs::create_dir_all(&stuck).unwrap();
    fs::write(stuck.join("file"), b"x").unwrap();
    common::sh(
        root,
        "chmod 555 pinned && git init -q -b main repo && cd repo && echo a >a && git add a && git commit -qm init && git worktree add -q -b gone ../gone main && git worktree add -q -b dirty ../dirty main && echo b >../dirty/b",
    );
    let p = |x: &Path| x.to_string_lossy().into_owned();
    let (gone, dirty) = (root.join("gone"), root.join("dirty"));
    let scan = [
        scan_row("caches", "rm", &p(&doomed)),
        scan_row("caches", "rm", &p(&stuck)),
        scan_row("worktrees", "worktree", &p(&gone)),
        scan_row("worktrees", "worktree", &p(&dirty)),
    ]
    .concat();
    fs::write(run.join("scan.tsv"), scan).unwrap();
    let items = [
        selection_item("rm", &p(&doomed)),
        selection_item("rm", &p(&stuck)),
        selection_item("worktree", &p(&gone)),
        selection_item("worktree", &p(&dirty)),
    ]
    .join(",");
    fs::write(
        common::decision_file(&run),
        format!(r#"{{"items": [{items}]}}"#),
    )
    .unwrap();
    let out = common::cli(&["clean", &p(&run), "--decision", "1"], root, &[]);
    assert!(out.status.success());
    wait_done(&run);
    common::sh(root, "chmod 755 pinned");

    let events: Vec<serde_json::Value> = fs::read_to_string(run.join("clean.events"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let named = |name: &str| -> Vec<&serde_json::Value> {
        events.iter().filter(|e| e["event"] == name).collect()
    };
    let started = &events[0];
    assert_eq!(started["event"], "started");
    assert_eq!(
        (
            &started["paths"],
            &started["worktrees"],
            &started["commands"],
            &started["bytes"]
        ),
        (&2.into(), &2.into(), &0.into(), &(4 * 4096).into())
    );
    assert!(started["free"].as_i64().unwrap() > 0);
    assert!(
        named("removed").is_empty(),
        "trashed paths are never reported removed"
    );
    let trashed = named("trashed");
    assert_eq!(trashed.len(), 1);
    assert_eq!(trashed[0]["path"], p(&doomed));
    assert_eq!(trashed[0]["bytes"], 4096);
    assert_eq!(trashed[0]["id"].as_str().unwrap().len(), 16);
    let trashed_path = trashed[0]["trashed_path"].as_str().unwrap();
    assert!(Path::new(trashed_path).join("a/file").exists());
    let failed = named("failed");
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0]["path"], p(&stuck));
    assert!(
        failed[0]["reason"]
            .as_str()
            .unwrap()
            .starts_with("not moved to the Trash: "),
        "{}",
        failed[0]
    );
    let rows = named("trash");
    assert_eq!(rows.len(), 1, "one record batch");
    let states: Vec<&str> = rows[0]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["state"].as_str().unwrap())
        .collect();
    assert_eq!(states, ["trashed", "failed"]);
    let worktrees = named("worktree");
    assert_eq!(worktrees.len(), 2);
    assert_eq!(worktrees[0]["path"], p(&gone));
    assert_eq!(worktrees[0]["outcome"], "removed");
    assert_eq!(worktrees[1]["path"], p(&dirty));
    assert_eq!(worktrees[1]["outcome"], "kept");
    assert_eq!(worktrees[1]["bytes"], 4096);
    assert!(
        worktrees[1]["reason"]
            .as_str()
            .unwrap()
            .contains("1 uncommitted or untracked files"),
        "{}",
        worktrees[1]
    );
    let done = events.last().unwrap();
    assert_eq!(done["event"], "done");
    assert_eq!(done["removed"], 1);
    assert_eq!(done["removed_bytes"], 4096, "{done}");
    assert_eq!(done["trashed"], 1);
    assert_eq!(done["trashed_bytes"], 4096);
    assert_eq!(done["free_before"], started["free"]);
    assert!(done["free_after"].is_i64());
    assert!(events.iter().all(|e| e["elapsed_ms"].is_u64()));
    let log = fs::read_to_string(run.join("clean.log")).unwrap();
    assert!(
        log.contains(&format!(
            "NOT TRASHED {} (not moved to the Trash: ",
            p(&stuck)
        )),
        "{log}"
    );
    assert!(log.contains("removed: 1 items, 4096 bytes"), "{log}");
    assert!(log.contains("trashed: 1 items, 4096 bytes"), "{log}");
    assert!(!doomed.exists() && !gone.exists() && dirty.exists() && stuck.exists());
}

fn write_run(run: &Path, scan: &str, items: &[String], lists: Option<(&str, &str)>) {
    fs::create_dir_all(run).unwrap();
    fs::write(run.join("scan.tsv"), scan).unwrap();
    fs::write(
        common::decision_file(run),
        format!(r#"{{"items": [{}]}}"#, items.join(",")),
    )
    .unwrap();
    if let Some((rm, wt)) = lists {
        fs::write(run.join("decisions/1/rm-list"), rm).unwrap();
        fs::write(run.join("decisions/1/wt-list"), wt).unwrap();
        fs::write(run.join("decisions/1/cmd-list"), "").unwrap();
    }
}

#[test]
fn an_unusable_home_is_refused() {
    let t = common::temp_dir("clean-home");
    let run = t.0.join("run");
    let doomed = t.0.join("doomed");
    fs::create_dir_all(&doomed).unwrap();
    write_run(
        &run,
        &scan_row("caches", "rm", &text(&doomed)),
        &[selection_item("rm", &text(&doomed))],
        None,
    );
    let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    for home in ["", "relative/home", "/nonexistent/disk-clean-home"] {
        let out = common::output(
            Command::new(env!("CARGO_BIN_EXE_disk-clean"))
                .args(["clean", "--dry-run", &text(&run), "--decision", "1"])
                .env(home_var, home),
        );
        assert_eq!(out.status.code(), Some(1), "HOME={home:?}");
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(err.contains("HOME"), "HOME={home:?}: {err}");
        assert!(String::from_utf8_lossy(&out.stdout).is_empty());
    }
}

#[cfg(unix)]
#[test]
fn a_symlink_swapped_into_a_parent_after_the_scan_keeps_the_decoy() {
    let home_t = common::temp_dir("swap-home");
    let decoy_t = common::temp_dir("swap-decoy");
    let home = &home_t.0;
    let app = home.join("Library/Caches/app");
    let target = app.join("victim");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("cache"), b"x").unwrap();
    let decoy = decoy_t.0.join("app/victim");
    fs::create_dir_all(&decoy).unwrap();
    fs::write(decoy.join("precious"), b"keep me").unwrap();
    let run = home.join("run");
    write_run(
        &run,
        &scan_row("caches", "rm", &text(&target)),
        &[selection_item("rm", &text(&target))],
        Some((&format!("{}\n", text(&target)), "")),
    );
    fs::rename(&app, home.join("Library/Caches/app-moved")).unwrap();
    std::os::unix::fs::symlink(decoy_t.0.join("app"), &app).unwrap();

    let dry = common::cli(
        &["clean", "--dry-run", &text(&run), "--decision", "1"],
        home,
        &[],
    );
    let plan = String::from_utf8_lossy(&dry.stdout);
    assert!(
        plan.contains(&format!(
            "# rejected (path changed since the scan): {}",
            text(&target)
        )),
        "{plan}"
    );
    let out = common::cli(&["clean", "--worker", &text(&run), "1"], home, &[]);
    assert!(out.status.success());
    let log = fs::read_to_string(run.join("clean.log")).unwrap_or_default()
        + &String::from_utf8_lossy(&out.stdout);
    assert!(
        decoy.join("precious").exists(),
        "the decoy was deleted\n{log}"
    );
    assert!(
        log.contains(&format!(
            "KEPT    {} (path changed since the scan)",
            text(&target)
        )),
        "{log}"
    );
    let kept: Vec<_> = common::events_of(&run)
        .into_iter()
        .filter(|e| e["event"] == "kept")
        .collect();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0]["path"], text(&target));
}

#[cfg(unix)]
#[test]
fn a_leaf_symlink_is_moved_itself_never_followed() {
    let home_t = common::temp_dir("leaf-home");
    let decoy_t = common::temp_dir("leaf-decoy");
    let home = &home_t.0;
    let caches = home.join("Library/Caches");
    fs::create_dir_all(&caches).unwrap();
    fs::write(decoy_t.0.join("precious"), b"keep me").unwrap();
    let link = caches.join("link");
    std::os::unix::fs::symlink(&decoy_t.0, &link).unwrap();
    let run = home.join("run");
    write_run(
        &run,
        &scan_row("caches", "rm", &text(&link)),
        &[selection_item("rm", &text(&link))],
        Some((&format!("{}\n", text(&link)), "")),
    );
    let out = common::cli(&["clean", "--worker", &text(&run), "1"], home, &[]);
    assert!(out.status.success());
    assert!(fs::symlink_metadata(&link).is_err(), "the link itself goes");
    assert!(decoy_t.0.join("precious").exists(), "its target stays");
    let record = disk_clean::trash::read(&text(home));
    assert_eq!(record.len(), 1);
    assert!(
        fs::symlink_metadata(&record[0].trashed)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    common::assert_record_inside_ram_disk(home);
}

#[cfg(unix)]
#[test]
fn a_worktree_swapped_for_another_checkout_keeps_the_decoy() {
    let home_t = common::temp_dir("wt-swap-home");
    let decoy_t = common::temp_dir("wt-swap-decoy");
    let home = &home_t.0;
    common::sh(
        home,
        "git init -q -b main repo && cd repo && echo a >a && git add a && git commit -qm init && git worktree add -q -b wt ../wts/a/wt main",
    );
    common::sh(
        &decoy_t.0,
        "git init -q -b main repo2 && cd repo2 && echo b >b && git add b && git commit -qm init && git worktree add -q -b wt2 ../a/wt main",
    );
    let target = home.join("wts/a/wt");
    let decoy = decoy_t.0.join("a/wt");
    let run = home.join("run");
    write_run(
        &run,
        &scan_row("worktrees", "worktree", &text(&target)),
        &[selection_item("worktree", &text(&target))],
        Some(("", &format!("{}\n", text(&target)))),
    );
    fs::rename(home.join("wts/a"), home.join("wts/a-moved")).unwrap();
    std::os::unix::fs::symlink(decoy_t.0.join("a"), home.join("wts/a")).unwrap();

    let out = common::cli(&["clean", "--worker", &text(&run), "1"], home, &[]);
    assert!(out.status.success());
    let log = fs::read_to_string(run.join("clean.log")).unwrap_or_default()
        + &String::from_utf8_lossy(&out.stdout);
    assert!(
        decoy.join("b").exists(),
        "the decoy checkout was emptied\n{log}"
    );
    assert!(
        log.contains(&format!(
            "KEPT    {} (path changed since the scan)",
            text(&target)
        )),
        "{log}"
    );
}

fn add_decision(run: &Path, n: u64, items: &[String]) {
    fs::create_dir_all(run.join(format!("decisions/{n}"))).unwrap();
    fs::write(
        run.join(format!("decisions/{n}.json")),
        format!(r#"{{"items": [{}]}}"#, items.join(",")),
    )
    .unwrap();
}

#[test]
fn a_second_round_appends_to_the_one_log_of_record() {
    let t = common::temp_dir("clean-rerun");
    let root = &t.0;
    let (a, b) = (root.join("a"), root.join("b"));
    for dir in [&a, &b] {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("f"), b"x").unwrap();
    }
    let run = root.join("run");
    let scan = scan_row("caches", "rm", &text(&a)) + &scan_row("caches", "rm", &text(&b));
    write_run(&run, &scan, &[selection_item("rm", &text(&a))], None);
    add_decision(&run, 2, &[selection_item("rm", &text(&b))]);
    for n in ["1", "2"] {
        let out = common::cli(&["clean", &text(&run), "--decision", n], root, &[]);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        common::wait_for("the round", Duration::from_secs(20), || {
            fs::read_to_string(run.join(format!("decisions/{n}/status")))
                .is_ok_and(|s| s == "done\n")
        });
    }
    let events = common::events_of(&run);
    let started: Vec<&serde_json::Value> =
        events.iter().filter(|e| e["event"] == "started").collect();
    assert_eq!(started.len(), 2, "{events:?}");
    assert_eq!(started[0]["decision"], 1);
    assert_eq!(started[1]["decision"], 2);
    assert_ne!(started[0]["run"], started[1]["run"]);
    let trashed: Vec<(u64, String)> = events
        .iter()
        .filter(|e| e["event"] == "trashed")
        .map(|e| {
            (
                e["decision"].as_u64().unwrap(),
                e["path"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(trashed, [(1, text(&a)), (2, text(&b))]);
    assert_eq!(events.iter().filter(|e| e["event"] == "done").count(), 2);
    let log = fs::read_to_string(run.join("clean.log")).unwrap();
    assert!(
        log.contains("decision 1 finished") && log.contains("decision 2 finished"),
        "{log}"
    );
    let rounds: Vec<String> = disk_clean::trash::read(&text(root))
        .into_iter()
        .map(|e| e.run)
        .collect();
    let id = disk_clean::trash::run_id(&run);
    assert_eq!(rounds, [format!("{id}-1"), format!("{id}-2")]);
    let same = common::cli(&["clean", &text(&run), "--decision", "1"], root, &[]);
    assert_eq!(same.status.code(), Some(0));
    assert!(
        String::from_utf8_lossy(&same.stdout).contains("decision 1 already ran (done)"),
        "{}",
        String::from_utf8_lossy(&same.stdout)
    );
    let missing = common::cli(&["clean", &text(&run), "--decision", "3"], root, &[]);
    assert_eq!(missing.status.code(), Some(2));
    let unnumbered = common::cli(&["clean", &text(&run)], root, &[]);
    assert_eq!(unnumbered.status.code(), Some(2));
}

#[test]
fn two_approvals_queue_and_run_in_order() {
    let t = common::temp_dir("clean-queue");
    let root = &t.0;
    let (a, b) = (root.join("a"), root.join("b"));
    for dir in [&a, &b] {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("f"), b"x").unwrap();
    }
    let run = root.join("run");
    let scan = scan_row("caches", "rm", &text(&a)) + &scan_row("caches", "rm", &text(&b));
    write_run(&run, &scan, &[selection_item("rm", &text(&a))], None);
    add_decision(&run, 2, &[selection_item("rm", &text(&b))]);
    let busy = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(run.join("clean.lock"))
        .unwrap();
    busy.try_lock().unwrap();
    for n in ["2", "1"] {
        let out = common::cli(&["clean", &text(&run), "--decision", n], root, &[]);
        assert_eq!(
            out.status.code(),
            Some(0),
            "queued, never an error: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(
            String::from_utf8_lossy(&out.stdout).contains("waits   : for the cleanup before it"),
            "{}",
            String::from_utf8_lossy(&out.stdout)
        );
        assert_eq!(
            fs::read_to_string(run.join(format!("decisions/{n}/status"))).unwrap(),
            "queued\n"
        );
    }
    common::wait_for("both queued events", Duration::from_secs(10), || {
        common::events_of(&run)
            .iter()
            .filter(|e| e["event"] == "queued")
            .count()
            == 2
    });
    let again = common::cli(&["clean", &text(&run), "--decision", "2"], root, &[]);
    assert!(
        String::from_utf8_lossy(&again.stdout).contains("decision 2 is already queued or running")
    );
    assert!(
        a.exists() && b.exists(),
        "nothing runs while another cleanup holds the run"
    );
    drop(busy);
    common::wait_for("both rounds", Duration::from_secs(30), || {
        ["1", "2"].iter().all(|n| {
            fs::read_to_string(run.join(format!("decisions/{n}/status")))
                .is_ok_and(|s| s == "done\n")
        })
    });
    let order: Vec<(String, u64)> = common::events_of(&run)
        .iter()
        .filter(|e| e["event"] == "started" || e["event"] == "done")
        .map(|e| {
            (
                e["event"].as_str().unwrap().to_string(),
                e["decision"].as_u64().unwrap(),
            )
        })
        .collect();
    let expected: Vec<(String, u64)> = [("started", 1), ("done", 1), ("started", 2), ("done", 2)]
        .iter()
        .map(|(e, n)| (e.to_string(), *n))
        .collect();
    assert_eq!(order, expected);
    assert!(!a.exists() && !b.exists());
    common::assert_record_inside_ram_disk(root);
}

#[test]
fn duplicate_selection_paths_are_planned_once() {
    let t = common::temp_dir("clean-dupes");
    let dir = t.0.join("dup");
    fs::create_dir_all(&dir).unwrap();
    let run = t.0.join("run");
    write_run(
        &run,
        &scan_row("caches", "rm", &text(&dir)),
        &[
            selection_item("rm", &text(&dir)),
            selection_item("rm", &text(&dir)),
            r#"{"action": "cmd", "cmd_id": "docker-prune", "bytes": 7}"#.to_string(),
            r#"{"action": "cmd", "cmd_id": "docker-prune", "bytes": 7}"#.to_string(),
        ],
        None,
    );
    let out = common::cli(
        &["clean", "--dry-run", &text(&run), "--decision", "1"],
        &t.0,
        &[],
    );
    let plan = String::from_utf8_lossy(&out.stdout);
    assert_eq!(
        plan.matches(&format!("trash -- {}\n", text(&dir))).count(),
        1,
        "{plan}"
    );
    assert_eq!(
        plan.matches("docker system prune -f\n").count(),
        1,
        "{plan}"
    );
    assert!(plan.contains("# 2 items, 4103 bytes"), "{plan}");

    let cats = disk_clean::review::load_scan(&run);
    let picked = disk_clean::review::selection(
        &cats,
        &[
            serde_json::json!({"path": text(&dir)}),
            serde_json::json!({"path": text(&dir)}),
        ],
    )
    .unwrap();
    assert_eq!(picked["items"].as_array().unwrap().len(), 1);
    assert_eq!(picked["total_bytes"], 4096);
}

#[test]
fn dry_run_exit_codes_match_the_real_run() {
    let t = common::temp_dir("clean-codes");
    let missing = t.0.join("no-such-run");
    let out = common::cli(
        &["clean", "--dry-run", &text(&missing), "--decision", "1"],
        &t.0,
        &[],
    );
    assert_eq!(out.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("no run directory at"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let run = t.0.join("run");
    let protected = t.0.join(".ssh/id_rsa");
    fs::create_dir_all(t.0.join(".ssh")).unwrap();
    fs::write(&protected, b"key").unwrap();
    write_run(&run, "", &[selection_item("rm", &text(&protected))], None);
    let dry = common::cli(
        &["clean", "--dry-run", &text(&run), "--decision", "1"],
        &t.0,
        &[],
    );
    assert_eq!(dry.status.code(), Some(3));
    let real = common::cli(&["clean", &text(&run), "--decision", "1"], &t.0, &[]);
    assert_eq!(real.status.code(), Some(3));
}

#[test]
fn planning_ten_thousand_items_takes_well_under_a_second() {
    let t = common::temp_dir("clean-fast");
    let path = |i: usize| format!("{}/item-{i}", t.0.display());
    let scan: Vec<String> = (0..14_000)
        .map(|i| scan_row("caches", "rm", &path(i)).trim_end().to_string())
        .collect();
    let items: Vec<serde_json::Value> = (0..10_000)
        .map(|i| serde_json::from_str(&selection_item("rm", &path(i))).unwrap())
        .collect();
    let started = Instant::now();
    let plan = disk_clean::clean::plan_in(
        &disk_clean::clean::index_scan(&scan),
        &items,
        &t.0.to_string_lossy(),
    );
    let took = started.elapsed();
    assert_eq!(plan.rejected.len(), 10_000);
    assert!(
        plan.rejected
            .iter()
            .all(|(reason, _)| reason == "already gone")
    );
    assert!(took < Duration::from_secs(1), "planning took {took:?}");
}

#[cfg(unix)]
#[test]
fn a_decision_runs_once_and_a_killed_worker_reads_as_interrupted() {
    let t = common::temp_dir("clean-lock");
    let root = &t.0;
    let (run, bin, gate, ran) = (
        root.join("run"),
        root.join("bin"),
        root.join("gate"),
        root.join("ran"),
    );
    fs::create_dir_all(&bin).unwrap();
    fs::write(
        bin.join("docker"),
        format!(
            "#!/bin/sh\ntouch '{0}'\nwhile [ ! -e '{1}' ]; do sleep 0.05; done\nrm -f '{0}'\n",
            ran.display(),
            gate.display()
        ),
    )
    .unwrap();
    common::status(Command::new("chmod").arg("+x").arg(bin.join("docker")));
    write_run(
        &run,
        "",
        &[r#"{"action": "cmd", "cmd_id": "docker-prune", "bytes": 1}"#.to_string()],
        None,
    );
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
    let env = [("PATH", path.as_str())];
    let first = common::cli(&["clean", &text(&run), "--decision", "1"], root, &env);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    common::wait_for("the worker to run docker", Duration::from_secs(10), || {
        ran.exists()
    });

    let second = common::cli(&["clean", &text(&run), "--decision", "1"], root, &env);
    assert_eq!(second.status.code(), Some(0));
    assert!(
        String::from_utf8_lossy(&second.stdout).contains("decision 1 is already queued or running"),
        "{}",
        String::from_utf8_lossy(&second.stdout)
    );

    let pid = fs::read_to_string(run.join("decisions/1/worker.pid")).unwrap();
    assert!(common::status(Command::new("kill").args(["-9", pid.trim()])).success());
    common::wait_for(
        "the killed worker to let go",
        Duration::from_secs(10),
        || disk_clean::clean::run_status(&run, 1) == "interrupted",
    );
    fs::write(&gate, "").unwrap();
    common::wait_for("the fake docker to exit", Duration::from_secs(10), || {
        !ran.exists()
    });
    assert_eq!(
        fs::read_to_string(run.join("decisions/1/status")).unwrap(),
        "interrupted\n"
    );
    let last = common::events_of(&run).pop().unwrap();
    assert_eq!(last["event"], "abandoned", "{last}");
    assert_eq!(last["decision"], 1, "{last}");
}

#[cfg(windows)]
#[test]
fn clean_end_to_end_on_fixture_on_windows() {
    let t = common::temp_dir("clean-windows");
    let root = &t.0;
    let run = root.join("run");
    fs::create_dir_all(&run).unwrap();
    let doomed = root.join("doomed");
    fs::create_dir_all(doomed.join("nested/deeper")).unwrap();
    fs::write(doomed.join("nested/deeper/file"), vec![1u8; 10_000]).unwrap();
    let doomed_file = root.join("doomed-file.bin");
    fs::write(&doomed_file, b"bytes").unwrap();
    let not_in_scan = root.join("not-in-scan");
    fs::create_dir_all(&not_in_scan).unwrap();
    let protected = root.join(".ssh/id_rsa");
    fs::create_dir_all(root.join(".ssh")).unwrap();
    fs::write(&protected, b"key").unwrap();
    common::sh(
        root,
        "git init -q -b main repo && cd repo && echo a >a && git add a && git commit -qm init",
    );
    let repo = root.join("repo");
    let p = text;
    let scan = [
        scan_row("caches", "rm", &p(&doomed)),
        scan_row("caches", "rm", &p(&doomed_file)),
        scan_row("caches", "rm", &p(&protected)),
        scan_row("worktrees", "worktree", &p(&repo)),
    ]
    .concat();
    fs::write(run.join("scan.tsv"), scan).unwrap();
    let items = [
        selection_item("rm", &p(&doomed)),
        selection_item("rm", &p(&doomed_file)),
        selection_item("rm", &p(&not_in_scan)),
        selection_item("rm", &p(&protected)),
        selection_item("worktree", &p(&repo)),
        selection_item("rm", &p(&repo)),
        r#"{"action": "cmd", "cmd_id": "rm-rf-everything", "bytes": 1}"#.to_string(),
    ]
    .join(",");
    fs::write(
        common::decision_file(&run),
        format!(r#"{{"items": [{items}], "total_bytes": 0}}"#),
    )
    .unwrap();

    let dry = common::cli(
        &["clean", "--dry-run", &p(&run), "--decision", "1"],
        root,
        &[],
    );
    let plan = String::from_utf8_lossy(&dry.stdout);
    assert!(dry.status.success(), "{plan}");
    assert!(
        plan.contains(&format!("\ntrash -- {}\n", p(&doomed))),
        "{plan}"
    );
    assert!(
        plan.contains(&format!("\ntrash -- {}\n", p(&doomed_file))),
        "{plan}"
    );
    assert!(
        plan.contains(&format!("# rejected (protected path): {}", p(&protected))),
        "{plan}"
    );
    assert!(plan.contains("# 3 items, 12288 bytes"), "{plan}");

    let out = common::cli(&["clean", &p(&run), "--decision", "1"], root, &[]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "clean failed: {stdout} {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(stdout.contains("rejected: 4"), "{stdout}");
    wait_done(&run);
    let log = fs::read_to_string(run.join("clean.log")).unwrap();
    common::assert_record_inside_ram_disk(root);
    let record = disk_clean::trash::read(&p(root));
    assert_eq!(record.len(), 2);
    let bin = common::trash_dir(root);
    for entry in &record {
        let trashed = Path::new(&entry.trashed);
        assert!(
            [Some(bin.as_path()), bin.parent()].contains(&trashed.parent()),
            "{entry:?}"
        );
        assert_eq!(entry.state, "trashed", "{entry:?}");
        assert!(
            trashed
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("$R"),
            "{entry:?}"
        );
        assert!(trashed.exists(), "{entry:?}");
        assert!(
            log.contains(&format!(
                "trashed {} -> {}\n",
                entry.original, entry.trashed
            )),
            "{log}"
        );
    }
    assert!(log.contains("trashed: 2 items, 8192 bytes"), "{log}");
    assert!(!doomed.exists() && !doomed_file.exists());
    assert!(not_in_scan.exists() && repo.join("a").exists() && protected.exists());
}

#[cfg(windows)]
#[test]
fn a_junction_swapped_into_a_parent_after_the_scan_keeps_the_decoy() {
    let home_t = common::temp_dir("swap-home-windows");
    let decoy_t = common::temp_dir("swap-decoy-windows");
    let home = &home_t.0;
    let app = home.join("AppData/Local/app");
    let target = app.join("victim");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("cache"), b"x").unwrap();
    let decoy = decoy_t.0.join("app/victim");
    fs::create_dir_all(&decoy).unwrap();
    fs::write(decoy.join("precious"), b"keep me").unwrap();
    let run = home.join("run");
    write_run(
        &run,
        &scan_row("caches", "rm", &text(&target)),
        &[selection_item("rm", &text(&target))],
        Some((&format!("{}\n", text(&target)), "")),
    );
    fs::rename(&app, home.join("AppData/Local/app-moved")).unwrap();
    common::junction(&app, &decoy_t.0.join("app"));

    let dry = common::cli(
        &["clean", "--dry-run", &text(&run), "--decision", "1"],
        home,
        &[],
    );
    let plan = String::from_utf8_lossy(&dry.stdout);
    assert!(
        plan.contains(&format!(
            "# rejected (path changed since the scan): {}",
            text(&target)
        )),
        "{plan}"
    );
    let out = common::cli(&["clean", "--worker", &text(&run), "1"], home, &[]);
    assert!(out.status.success());
    let log = fs::read_to_string(run.join("clean.log")).unwrap_or_default()
        + &String::from_utf8_lossy(&out.stdout);
    assert!(
        decoy.join("precious").exists(),
        "the decoy was deleted\n{log}"
    );
    assert!(
        log.contains(&format!(
            "KEPT    {} (path changed since the scan)",
            text(&target)
        )),
        "{log}"
    );
}

#[cfg(windows)]
#[test]
fn a_leaf_junction_is_moved_itself_and_its_target_stays() {
    let home_t = common::temp_dir("leaf-home-windows");
    let decoy_t = common::temp_dir("leaf-decoy-windows");
    let home = &home_t.0;
    let caches = home.join("AppData/Local");
    fs::create_dir_all(&caches).unwrap();
    fs::write(decoy_t.0.join("precious"), b"keep me").unwrap();
    let link = caches.join("link");
    common::junction(&link, &decoy_t.0);
    let run = home.join("run");
    write_run(
        &run,
        &scan_row("caches", "rm", &text(&link)),
        &[selection_item("rm", &text(&link))],
        Some((&format!("{}\n", text(&link)), "")),
    );
    let out = common::cli(&["clean", "--worker", &text(&run), "1"], home, &[]);
    assert!(out.status.success());
    assert!(
        fs::symlink_metadata(&link).is_err(),
        "the junction itself goes"
    );
    assert!(decoy_t.0.join("precious").exists(), "its target stays");
    let record = disk_clean::trash::read(&text(home));
    assert_eq!(record.len(), 1);
    assert!(
        fs::symlink_metadata(&record[0].trashed)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    common::assert_record_inside_ram_disk(home);
}

#[cfg(windows)]
#[test]
fn a_worktree_swapped_for_a_junction_to_another_checkout_keeps_the_decoy() {
    let home_t = common::temp_dir("wt-swap-home-windows");
    let decoy_t = common::temp_dir("wt-swap-decoy-windows");
    let home = &home_t.0;
    common::sh(
        home,
        "git init -q -b main repo && cd repo && echo a >a && git add a && git commit -qm init && git worktree add -q -b wt ../wts/a/wt main",
    );
    common::sh(
        &decoy_t.0,
        "git init -q -b main repo2 && cd repo2 && echo b >b && git add b && git commit -qm init && git worktree add -q -b wt2 ../a/wt main",
    );
    let target = home.join("wts/a/wt");
    let decoy = decoy_t.0.join("a/wt");
    let run = home.join("run");
    write_run(
        &run,
        &scan_row("worktrees", "worktree", &text(&target)),
        &[selection_item("worktree", &text(&target))],
        Some(("", &format!("{}\n", text(&target)))),
    );
    fs::rename(home.join("wts/a"), home.join("wts/a-moved")).unwrap();
    common::junction(&home.join("wts/a"), &decoy_t.0.join("a"));

    let out = common::cli(&["clean", "--worker", &text(&run), "1"], home, &[]);
    assert!(out.status.success());
    let log = fs::read_to_string(run.join("clean.log")).unwrap_or_default()
        + &String::from_utf8_lossy(&out.stdout);
    assert!(
        decoy.join("b").exists(),
        "the decoy checkout was emptied\n{log}"
    );
    assert!(
        log.contains(&format!(
            "KEPT    {} (path changed since the scan)",
            text(&target)
        )),
        "{log}"
    );
}
