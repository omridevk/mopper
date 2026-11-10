pub const COMMANDS: &[(&str, &str, &[&str])] = &[
    (
        "xcode-unavailable-sims",
        "xcrun",
        &["simctl", "delete", "unavailable"],
    ),
    ("docker-prune", "docker", &["system", "prune", "-f"]),
    ("brew-cleanup", "brew", &["cleanup", "--prune=all", "-s"]),
];
