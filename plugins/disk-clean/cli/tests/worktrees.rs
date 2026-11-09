mod common;

use disk_clean::worktrees;
use std::process::Command;

#[test]
fn removes_only_worktrees_without_leftover_work() {
    let t = common::temp_dir("wt");
    let root = &t.0;
    common::sh(
        root,
        r#"
git init -q -b main repo
cd repo
printf 'node_modules/\ndist/\n.env\n' >.gitignore
echo a >a.txt
git add . && git commit -qm init
add() { git worktree add -q -b "$1" "../$1" main; }
add clean
add clean-with-build && mkdir -p ../clean-with-build/node_modules/x ../clean-with-build/dist && echo x >../clean-with-build/node_modules/x/i.js
add unpushed-commit && (cd ../unpushed-commit && echo b >b.txt && git add b.txt && git commit -qm b)
add modified && echo changed >>../modified/a.txt
add staged && (cd ../staged && echo s >s.txt && git add s.txt)
add untracked && echo u >../untracked/new.txt
add env-file && echo SECRET=1 >../env-file/.env
add locked && git worktree lock ../locked
add in-use
add dropped-commit && (cd ../dropped-commit && echo d >d.txt && git add d.txt && git commit -qm d && git reset -q --hard HEAD~1)
add rebasing && mkdir -p "$(git -C ../rebasing rev-parse --absolute-git-dir)/rebase-merge"
git worktree add -q --detach ../detached-orphan main && (cd ../detached-orphan && echo o >o.txt && git add o.txt && git commit -qm o)
add changed-after-scan
"#,
    );
    let mut sleeper = common::spawn(common::sleeper().current_dir(root.join("in-use")));
    std::thread::sleep(std::time::Duration::from_secs(1));
    std::fs::write(root.join("changed-after-scan/late.txt"), "late\n").unwrap();

    let mut paths: Vec<String> = std::fs::read_dir(root)
        .unwrap()
        .flatten()
        .filter(|e| e.path().is_dir() && e.file_name() != "repo")
        .map(|e| common::text(&e.path()))
        .collect();
    paths.sort();
    let mut out = Vec::new();
    worktrees::remove(&paths, &mut out, &|_| Ok(()), &mut |_, _| {}).unwrap();
    let _ = sleeper.kill();
    let _ = sleeper.wait();
    let log = String::from_utf8(out).unwrap();
    println!("{log}");

    for gone in ["clean", "clean-with-build", "unpushed-commit"] {
        assert!(!root.join(gone).exists(), "{gone} should be removed\n{log}");
    }
    for kept in [
        "modified",
        "staged",
        "untracked",
        "env-file",
        "locked",
        "in-use",
        "dropped-commit",
        "rebasing",
        "detached-orphan",
        "changed-after-scan",
    ] {
        assert!(
            root.join(kept).exists(),
            "{kept} was removed but holds work\n{log}"
        );
    }
    let repo = root.join("repo");
    let verify = common::output(Command::new("git").args([
        "-C",
        &repo.to_string_lossy(),
        "rev-parse",
        "-q",
        "--verify",
        "unpushed-commit",
    ]));
    assert!(verify.status.success(), "branch unpushed-commit lost");
    let subject = common::output(Command::new("git").args([
        "-C",
        &repo.to_string_lossy(),
        "log",
        "-1",
        "--format=%s",
        "unpushed-commit",
    ]));
    assert_eq!(
        String::from_utf8_lossy(&subject.stdout).trim(),
        "b",
        "commit on unpushed-commit lost"
    );
    assert!(log.contains("KEPT    ") && log.contains("removed worktree "));
}

#[test]
fn regenerable_entries() {
    assert!(worktrees::is_regenerable("node_modules/"));
    assert!(worktrees::is_regenerable("packages/app/dist/"));
    assert!(worktrees::is_regenerable("tsconfig.tsbuildinfo"));
    assert!(worktrees::is_regenerable("sub/.DS_Store"));
    assert!(!worktrees::is_regenerable(".env"));
    assert!(!worktrees::is_regenerable(".idea/"));
    assert!(!worktrees::is_regenerable("plans/notes.md"));
}

#[test]
fn batched_orphan_counts_match_per_worktree_git() {
    let t = common::temp_dir("wt-orphans");
    let root = &t.0;
    common::sh(
        root,
        r#"
git init -q -b main repo
cd repo
echo a >a.txt && git add . && git commit -qm init
add() { git worktree add -q -b "$1" "../$1" main; }
add clean
add one-dropped && (cd ../one-dropped && echo d >d && git add d && git commit -qm d && git reset -q --hard HEAD~1)
add two-dropped && (cd ../two-dropped && echo e >e && git add e && git commit -qm e && echo f >f && git add f && git commit -qm f && git reset -q --hard HEAD~2)
add kept-commits && (cd ../kept-commits && echo g >g && git add g && git commit -qm g)
git worktree add -q --detach ../detached main && (cd ../detached && echo o >o && git add o && git commit -qm o && echo p >p && git add p && git commit -qm p)
"#,
    );
    let paths: Vec<std::path::PathBuf> = [
        "clean",
        "one-dropped",
        "two-dropped",
        "kept-commits",
        "detached",
    ]
    .iter()
    .map(|n| root.join(n))
    .collect();
    let batched = worktrees::orphan_counts(&paths);
    let single: Vec<i64> = paths
        .iter()
        .map(|p| worktrees::orphaned_reflog_commits(p))
        .collect();
    assert_eq!(single, [0, 1, 2, 0, 2]);
    assert_eq!(batched, single);
}

#[test]
fn notes_say_when_a_worktree_was_used_and_where_its_branch_stands() {
    let checked = |path: &str, idle: f64, unpushed: Option<i64>| worktrees::Checked {
        entry: [("worktree".to_string(), path.to_string())].into(),
        blockers: Vec::new(),
        info: Some(worktrees::Info {
            branch: "feat".to_string(),
            unpushed,
            idle,
        }),
    };
    let rows = worktrees::rows(
        &[
            checked("/h/today", 0.4, None),
            checked("/h/one", 1.2, Some(0)),
            checked("/h/old", 30.0, Some(3)),
        ],
        "/h",
        |_| 0,
    );
    let notes: Vec<&str> = rows.iter().map(|r| r[10].as_str()).collect();
    assert_eq!(
        notes,
        [
            "Used today, so not ticked by default. Branch feat stays with all its commits (local only, never pushed). Re-create with: git worktree add ~/today feat",
            "Used 1 day ago, so not ticked by default. Branch feat stays with all its commits (pushed). Re-create with: git worktree add ~/one feat",
            "Branch feat stays with all its commits (3 unpushed). Re-create with: git worktree add ~/old feat",
        ]
    );
}
