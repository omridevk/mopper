use disk_clean::selection::{Listed, decode, fingerprint, full_token, short_token};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("fixtures/selection-vectors.json")).unwrap()
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap()
}

#[test]
fn tokens_match_the_page_hash() {
    for case in vectors()["tokens"].as_array().unwrap() {
        let path = text(&case["path"]);
        assert_eq!(
            full_token(path),
            text(&case["full"]),
            "full token of {path:?}"
        );
        assert_eq!(
            short_token(path),
            text(&case["short"]),
            "short token of {path:?}"
        );
    }
}

#[test]
fn fingerprints_match_the_page() {
    for case in vectors()["fingerprints"].as_array().unwrap() {
        let paths: Vec<String> = case["paths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| text(p).to_string())
            .collect();
        assert_eq!(fingerprint(&paths), text(&case["fingerprint"]));
    }
}

#[test]
fn url_selections_decode_like_the_page() {
    let vectors = vectors();
    let items: Vec<Listed> = vectors["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["report"] != Value::Bool(true))
        .map(|i| Listed {
            path: text(&i["path"]),
            section: text(&i["section"]),
            preselect: i["preselect"].as_bool().unwrap(),
        })
        .collect();
    for case in vectors["decodes"].as_array().unwrap() {
        let mut selected = decode(&items, text(&case["add"]), text(&case["drop"]));
        assert_eq!(fingerprint(&selected), text(&case["fingerprint"]), "{case}");
        selected.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let expected: Vec<&str> = case["selected"]
            .as_array()
            .unwrap()
            .iter()
            .map(text)
            .collect();
        assert_eq!(selected, expected, "{case}");
    }
}
