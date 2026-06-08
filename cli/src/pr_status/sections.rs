//! Pure XML-section emitters that depend only on already-fetched JSON:
//! `<checks>`, `<merge-conflicts>`, `<reviews>`, and the reaction helpers.
//!
//! The filesystem-backed sections (`<comments>`, `<threads>`, `<annotations>`)
//! live in `mod.rs` alongside the cache.

use crate::xml;
use chrono::DateTime;
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

/// First key whose value is a JSON string, else `default` — the `//` chain
/// used throughout the jq (`.name // .context // "check"`).
fn first_str<'a>(v: &'a Value, keys: &[&str], default: &'a str) -> &'a str {
    for k in keys {
        if let Some(s) = v.get(*k).and_then(Value::as_str) {
            return s;
        }
    }
    default
}

fn failing_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)FAILURE|TIMED_OUT|CANCELLED|STARTUP_FAILURE").unwrap())
}

/// Emit `<checks>` with the rollup state per the §2.2 checks gate.
///
/// `info_re` is the compiled `DISPATCH_INFORMATIONAL_CHECKS` pattern (already
/// case-insensitive), `stuck_after` the threshold in seconds, `now` the current
/// unix time (passed in for testability).
pub fn checks_xml(pr_json: &Value, info_re: Option<&Regex>, stuck_after: i64, now: i64) -> String {
    struct Check {
        name: String,
        conclusion: String,
        url: String,
        informational: bool,
        pending: bool,
        failing: bool,
        stuck: bool,
    }

    let empty = Vec::new();
    let nodes = pr_json
        .get("statusCheckRollup")
        .and_then(Value::as_array)
        .unwrap_or(&empty);

    let checks: Vec<Check> = nodes
        .iter()
        .map(|c| {
            let name = first_str(c, &["name", "context"], "check").to_string();
            let conclusion = first_str(c, &["conclusion", "state"], "").to_string();
            let status = first_str(c, &["status"], "");
            let url = first_str(c, &["detailsUrl", "targetUrl"], "").to_string();
            let started = first_str(c, &["startedAt"], "");
            let name_or_context = first_str(c, &["name", "context"], "");

            let informational = match info_re {
                Some(re) => re.is_match(name_or_context),
                None => false,
            };
            let pending = matches!(status, "IN_PROGRESS" | "QUEUED" | "PENDING")
                || (conclusion.is_empty() && !status.is_empty());
            let failing = failing_re().is_match(&conclusion);
            let stuck = status == "IN_PROGRESS" && !started.is_empty() && {
                let started_ts = DateTime::parse_from_rfc3339(started)
                    .map(|d| d.timestamp())
                    .unwrap_or(now);
                now - started_ts > stuck_after
            };

            Check {
                name,
                conclusion,
                url,
                informational,
                pending,
                failing,
                stuck,
            }
        })
        .collect();

    let any_pending = checks.iter().any(|c| c.pending && !c.stuck);
    let any_failing = checks
        .iter()
        .any(|c| c.failing && !c.informational && !c.pending);
    let rollup = if any_pending {
        "pending"
    } else if any_failing {
        "failing"
    } else {
        "passing"
    };

    let mut out = String::new();
    out.push_str(&format!("  <checks state=\"{rollup}\">\n"));
    for c in &checks {
        out.push_str(&format!(
            "    <check name=\"{}\" conclusion=\"{}\" url=\"{}\" informational=\"{}\" stuck=\"{}\"/>\n",
            c.name, c.conclusion, c.url, c.informational, c.stuck
        ));
    }
    out.push_str("  </checks>");
    out
}

/// Emit `<merge-conflicts present="…"/>` from the PR's mergeable state.
pub fn conflicts_xml(pr_json: &Value) -> String {
    let present = pr_json.get("mergeable").and_then(Value::as_str) == Some("CONFLICTING");
    format!("  <merge-conflicts present=\"{present}\"/>")
}

struct Reviewer {
    login: String,
    is_bot: bool,
    state: String,
}

/// Insertion-order map of lowercased-login → reviewer, matching jq's
/// object-key ordering (first appearance wins position).
struct ReviewerMap {
    order: Vec<String>,
    by_key: std::collections::HashMap<String, Reviewer>,
}

impl ReviewerMap {
    fn new() -> Self {
        Self {
            order: Vec::new(),
            by_key: std::collections::HashMap::new(),
        }
    }
    fn contains(&self, key: &str) -> bool {
        self.by_key.contains_key(key)
    }
    fn insert(&mut self, key: String, r: Reviewer) {
        if !self.by_key.contains_key(&key) {
            self.order.push(key.clone());
        }
        self.by_key.insert(key, r);
    }
    fn iter(&self) -> impl Iterator<Item = (&String, &Reviewer)> {
        self.order
            .iter()
            .map(move |k| (k, self.by_key.get(k).unwrap()))
    }
}

fn is_bot_login(login_lc: &str) -> bool {
    ["copilot", "codex", "claude", "ai-agent"]
        .iter()
        .any(|n| login_lc.contains(n))
}

/// Emit `<reviews>` — one persistent record per reviewer, with the pending
/// override applied. Ported from the bash `reviews_xml` jq + read loop.
pub fn reviews_xml(reviews_json: &Value, operator_lc: &str) -> String {
    // Currently-outstanding requests: login + bot-ness.
    let mut reqs: Vec<(String, bool)> = Vec::new();
    if let Some(nodes) = reviews_json
        .pointer("/reviewRequests/nodes")
        .and_then(Value::as_array)
    {
        for n in nodes {
            let rr = &n["requestedReviewer"];
            let login = first_str(rr, &["login", "slug", "name"], "").to_string();
            if login.is_empty() {
                continue;
            }
            let is_bot = rr.get("__typename").and_then(Value::as_str) == Some("Bot");
            reqs.push((login, is_bot));
        }
    }
    let reqset: std::collections::HashSet<String> =
        reqs.iter().map(|(l, _)| l.to_lowercase()).collect();

    // Latest submitted review per author (drop unsubmitted PENDING drafts).
    let mut rev = ReviewerMap::new();
    if let Some(nodes) = reviews_json
        .pointer("/reviews/nodes")
        .and_then(Value::as_array)
    {
        for r in nodes {
            let lg = r
                .pointer("/author/login")
                .and_then(Value::as_str)
                .unwrap_or("");
            let state = r
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("COMMENTED");
            if lg.is_empty() || state == "PENDING" {
                continue;
            }
            let is_bot = r.pointer("/author/__typename").and_then(Value::as_str) == Some("Bot");
            rev.insert(
                lg.to_lowercase(),
                Reviewer {
                    login: lg.to_string(),
                    is_bot,
                    state: state.to_string(),
                },
            );
        }
    }

    // Add a pending stub for any requested reviewer that has not reviewed.
    for (login, is_bot) in &reqs {
        let k = login.to_lowercase();
        if !rev.contains(&k) {
            rev.insert(
                k,
                Reviewer {
                    login: login.clone(),
                    is_bot: *is_bot,
                    state: "PENDING".to_string(),
                },
            );
        }
    }

    let mut out = String::from("  <reviews>\n");
    for (key, r) in rev.iter() {
        if r.login.is_empty() {
            continue;
        }
        // Pending override: an outstanding request forces status back to pending.
        let raw_state = if reqset.contains(key) {
            "PENDING"
        } else {
            r.state.as_str()
        };

        let login_lc = r.login.to_lowercase();
        let mode = if r.is_bot || is_bot_login(&login_lc) {
            "bot"
        } else {
            "human"
        };

        let s = raw_state.to_lowercase();
        let s = match s.as_str() {
            "pending" | "commented" | "approved" | "changes_requested" | "dismissed" => s,
            _ => "commented".to_string(),
        };

        if mode == "human" {
            let role = if login_lc == operator_lc {
                "operator"
            } else {
                "team"
            };
            out.push_str(&format!(
                "    <review author=\"{}\" mode=\"human\" role=\"{}\" state=\"{}\"/>\n",
                xml::attr(&r.login),
                role,
                s
            ));
        } else {
            out.push_str(&format!(
                "    <review author=\"{}\" mode=\"bot\" state=\"{}\"/>\n",
                xml::attr(&r.login),
                s
            ));
        }
    }
    out.push_str("  </reviews>");
    out
}

/// GraphQL `ReactionContent` → platform-normalized emoji name (§2.2 reactions).
pub fn reaction_emoji(content: &str) -> String {
    match content {
        "THUMBS_UP" => "+1".to_string(),
        "THUMBS_DOWN" => "-1".to_string(),
        "LAUGH" => "laugh".to_string(),
        "HOORAY" => "hooray".to_string(),
        "CONFUSED" => "confused".to_string(),
        "HEART" => "heart".to_string(),
        "ROCKET" => "rocket".to_string(),
        "EYES" => "eyes".to_string(),
        other => other.to_lowercase(),
    }
}

/// Emit `<reactions>…</reactions>` for a reactions-node array, or an empty
/// string when there are none. Whitespace matches the bash `reactions_xml_for`
/// (which is spliced inline into a `<comment>` element).
pub fn reactions_xml_for(reactions: &Value) -> String {
    let nodes = match reactions.as_array() {
        Some(a) if !a.is_empty() => a,
        _ => return String::new(),
    };
    let mut out = String::from("<reactions>\n");
    for r in nodes {
        let user = r
            .pointer("/user/login")
            .and_then(Value::as_str)
            .unwrap_or("");
        let content = r.get("content").and_then(Value::as_str).unwrap_or("");
        if user.is_empty() || content.is_empty() {
            continue;
        }
        let emoji = reaction_emoji(content);
        out.push_str(&format!(
            "        <reaction author=\"{}\" emoji=\"{}\"/>\n",
            xml::attr(user),
            xml::attr(&emoji)
        ));
    }
    out.push_str("      </reactions>");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn checks_rollup_passing() {
        let pr = json!({
            "statusCheckRollup": [
                {"name": "build", "conclusion": "SUCCESS", "status": "COMPLETED"},
                {"name": "lint", "conclusion": "NEUTRAL", "status": "COMPLETED"}
            ]
        });
        let out = checks_xml(&pr, None, 3600, 1_000_000);
        assert!(out.contains(r#"<checks state="passing">"#));
        assert!(out.contains(r#"<check name="build" conclusion="SUCCESS""#));
    }

    #[test]
    fn checks_rollup_pending_beats_failing() {
        let pr = json!({
            "statusCheckRollup": [
                {"name": "build", "conclusion": "FAILURE", "status": "COMPLETED"},
                {"name": "test", "status": "IN_PROGRESS"}
            ]
        });
        let out = checks_xml(&pr, None, 3600, 1_000_000);
        assert!(out.contains(r#"<checks state="pending">"#));
    }

    #[test]
    fn checks_failing_when_not_informational() {
        let pr = json!({"statusCheckRollup": [
            {"name": "build", "conclusion": "FAILURE", "status": "COMPLETED"}
        ]});
        let out = checks_xml(&pr, None, 3600, 1_000_000);
        assert!(out.contains(r#"<checks state="failing">"#));
    }

    #[test]
    fn checks_informational_failure_is_suppressed() {
        let re = Regex::new(r"(?i)^(coverage|codeql)$").unwrap();
        let pr = json!({"statusCheckRollup": [
            {"name": "coverage", "conclusion": "FAILURE", "status": "COMPLETED"}
        ]});
        let out = checks_xml(&pr, Some(&re), 3600, 1_000_000);
        assert!(out.contains(r#"<checks state="passing">"#));
        assert!(out.contains(r#"informational="true""#));
    }

    #[test]
    fn checks_stuck_in_progress_not_pending() {
        // started 2h before now, threshold 1h → stuck → not counted pending.
        let now = DateTime::parse_from_rfc3339("2024-01-01T02:00:00Z")
            .unwrap()
            .timestamp();
        let pr = json!({"statusCheckRollup": [
            {"name": "test", "status": "IN_PROGRESS", "startedAt": "2024-01-01T00:00:00Z"}
        ]});
        let out = checks_xml(&pr, None, 3600, now);
        assert!(out.contains(r#"<checks state="passing">"#));
        assert!(out.contains(r#"stuck="true""#));
    }

    #[test]
    fn conflicts_present() {
        assert!(conflicts_xml(&json!({"mergeable": "CONFLICTING"})).contains("present=\"true\""));
        assert!(conflicts_xml(&json!({"mergeable": "MERGEABLE"})).contains("present=\"false\""));
        assert!(conflicts_xml(&json!({})).contains("present=\"false\""));
    }

    #[test]
    fn reviews_pending_override() {
        // alice approved but is re-requested → pending override.
        let rj = json!({
            "reviews": {"nodes": [
                {"author": {"login": "alice", "__typename": "User"}, "state": "APPROVED"}
            ]},
            "reviewRequests": {"nodes": [
                {"requestedReviewer": {"__typename": "User", "login": "alice"}}
            ]}
        });
        let out = reviews_xml(&rj, "bob");
        assert!(
            out.contains(r#"<review author="alice" mode="human" role="team" state="pending"/>"#)
        );
    }

    #[test]
    fn reviews_operator_role_and_bot_mode() {
        let rj = json!({
            "reviews": {"nodes": [
                {"author": {"login": "bob", "__typename": "User"}, "state": "APPROVED"},
                {"author": {"login": "Copilot", "__typename": "Bot"}, "state": "COMMENTED"}
            ]},
            "reviewRequests": {"nodes": []}
        });
        let out = reviews_xml(&rj, "bob");
        assert!(
            out.contains(r#"<review author="bob" mode="human" role="operator" state="approved"/>"#)
        );
        assert!(out.contains(r#"<review author="Copilot" mode="bot" state="commented"/>"#));
    }

    #[test]
    fn reviews_drops_unsubmitted_pending() {
        let rj = json!({
            "reviews": {"nodes": [
                {"author": {"login": "carol", "__typename": "User"}, "state": "PENDING"}
            ]},
            "reviewRequests": {"nodes": []}
        });
        let out = reviews_xml(&rj, "bob");
        assert_eq!(out, "  <reviews>\n  </reviews>");
    }

    #[test]
    fn reaction_emoji_mapping() {
        assert_eq!(reaction_emoji("THUMBS_UP"), "+1");
        assert_eq!(reaction_emoji("THUMBS_DOWN"), "-1");
        assert_eq!(reaction_emoji("ROCKET"), "rocket");
        assert_eq!(reaction_emoji("CUSTOM"), "custom");
    }

    #[test]
    fn reactions_empty_is_blank() {
        assert_eq!(reactions_xml_for(&json!([])), "");
        assert_eq!(reactions_xml_for(&Value::Null), "");
    }

    #[test]
    fn reactions_rendered() {
        let r = json!([{"user": {"login": "bob"}, "content": "THUMBS_UP"}]);
        let out = reactions_xml_for(&r);
        assert!(out.starts_with("<reactions>\n"));
        assert!(out.contains(r#"<reaction author="bob" emoji="+1"/>"#));
        assert!(out.ends_with("      </reactions>"));
    }
}
