//! XML escaping helpers mirroring the bash `xml_attr` / `xml_text` functions.
//!
//! `xml_attr` escapes the five characters that are unsafe inside a
//! double-quoted attribute value; `xml_text` escapes the three that are unsafe
//! in element text (it intentionally leaves quotes alone, matching the script).

/// Escape a string for use inside a double-quoted XML attribute value.
///
/// Mirrors the bash `xml_attr`: `& < > "` (in that order, ampersand first so a
/// literal `&` isn't double-escaped).
pub fn attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Escape a string for use as XML element text.
///
/// Mirrors the bash `xml_text`: `& < >` only.
pub fn text(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attr_escapes_all_five() {
        assert_eq!(attr(r#"a&b<c>d"e"#), "a&amp;b&lt;c&gt;d&quot;e");
    }

    #[test]
    fn attr_ampersand_first() {
        // A literal ampersand must not be double-escaped.
        assert_eq!(attr("&lt;"), "&amp;lt;");
    }

    #[test]
    fn text_leaves_quotes() {
        assert_eq!(text(r#"a&b<c>"d"#), r#"a&amp;b&lt;c&gt;"d"#);
    }
}
