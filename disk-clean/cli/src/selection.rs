use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

const SHORT: usize = 8;
const FULL: usize = 11;
const SECTION: char = '_';
const SEPARATOR: char = '.';

pub struct Listed<'a> {
    pub path: &'a str,
    pub section: &'a str,
    pub preselect: bool,
}

pub fn cyrb53(text: &str) -> u64 {
    let (mut h1, mut h2): (u32, u32) = (0xdead_beef, 0x41c6_ce57);
    for code in text.encode_utf16() {
        let code = u32::from(code);
        h1 = (h1 ^ code).wrapping_mul(2_654_435_761);
        h2 = (h2 ^ code).wrapping_mul(1_597_334_677);
    }
    h1 = (h1 ^ (h1 >> 16)).wrapping_mul(2_246_822_507)
        ^ (h2 ^ (h2 >> 13)).wrapping_mul(3_266_489_909);
    h2 = (h2 ^ (h2 >> 16)).wrapping_mul(2_246_822_507)
        ^ (h1 ^ (h1 >> 13)).wrapping_mul(3_266_489_909);
    (u64::from(h2 & 0x1f_ffff) << 32) | u64::from(h1)
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

pub fn full_token(path: &str) -> String {
    format!("{:0>FULL$}", base36(cyrb53(path)))
}

pub fn short_token(path: &str) -> String {
    full_token(path)[..SHORT].to_string()
}

fn by_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

pub fn fingerprint(paths: &[String]) -> String {
    let mut sorted: Vec<&str> = paths.iter().map(String::as_str).collect();
    sorted.sort_by(|a, b| by_utf16(a, b));
    base36(cyrb53(&sorted.join("\n")))
}

fn is_token(token: &str) -> bool {
    match token.strip_prefix(SECTION) {
        Some(id) => {
            !id.is_empty()
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        }
        None => {
            (token.len() == SHORT || token.len() == FULL)
                && token
                    .bytes()
                    .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
        }
    }
}

fn tokens(value: &str) -> HashSet<&str> {
    value.split(SEPARATOR).filter(|t| is_token(t)).collect()
}

pub fn decode(items: &[Listed], add: &str, drop: &str) -> Vec<String> {
    let fulls: Vec<String> = items.iter().map(|i| full_token(i.path)).collect();
    let mut shorts: HashMap<&str, usize> = HashMap::new();
    for full in &fulls {
        *shorts.entry(&full[..SHORT]).or_default() += 1;
    }
    let token_of = |full: &str| -> String {
        let short = &full[..SHORT];
        if shorts.get(short) == Some(&1) {
            short.to_string()
        } else {
            full.to_string()
        }
    };
    let (add, drop) = (tokens(add), tokens(drop));
    let whole = |section: &str| {
        let token = format!("{SECTION}{section}");
        if add.contains(token.as_str()) {
            Some(true)
        } else if drop.contains(token.as_str()) {
            Some(false)
        } else {
            None
        }
    };
    items
        .iter()
        .zip(&fulls)
        .filter(|(item, full)| {
            let token = token_of(full);
            if add.contains(token.as_str()) {
                true
            } else if drop.contains(token.as_str()) {
                false
            } else {
                whole(item.section).unwrap_or(item.preselect)
            }
        })
        .map(|(item, _)| item.path.to_string())
        .collect()
}
